/**
 * 诗词 API 路由（供 Flutter App 使用）
 * 三个接口：
 *   GET  /api/v1/poems/random     —— 随机抽题（支持数量与分类筛选，懒加载题库 + 进程内缓存）
 *   GET  /api/v1/poem-leaderboard —— 诗词游戏排行榜查询
 *   POST /api/v1/poem-leaderboard —— 提交游戏成绩（需登录 Token，含服务端防作弊校验）
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');

const router = express.Router();

// ============ 诗词题库（懒加载 + 缓存） ============
// poems_data.js 是 14MB 级的大数据文件，不能随模块加载；
// 首次请求时才读取并解析成 JSON，之后常驻内存复用。
let poemsCache = null;        // 解析后的题库数组
let poemsCacheError = null;   // 加载失败的错误信息（失败后不再重复尝试读盘）

/**
 * 加载诗词题库（首次调用读文件并缓存）
 * @returns {Array} 诗词数组；加载失败返回 []
 * 实现：从 public/js/poems_data.js 提取 '[' 到 ']' 之间的 JSON 数组文本并解析。
 */
function loadPoems() {
  if (poemsCache) return poemsCache;          // 命中缓存直接返回
  if (poemsCacheError) return [];             // 已失败过，直接返回空
  try {
    const filePath = path.join(__dirname, '../../../public/js/poems_data.js');
    if (!fs.existsSync(filePath)) {
      poemsCacheError = 'poems_data.js 不存在';
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const start = raw.indexOf('[');           // 定位 JSON 数组起点
    const end = raw.lastIndexOf(']');         // 定位 JSON 数组终点
    if (start === -1 || end === -1) {
      poemsCacheError = 'poems_data.js 格式错误';
      return [];
    }
    poemsCache = JSON.parse(raw.slice(start, end + 1));  // 截取并解析
    return poemsCache;
  } catch (e) {
    poemsCacheError = e.message;
    return [];
  }
}

// ============ 随机诗词 ============
// 支持 count（数量，1~50）与 category（分类）参数；
// 抽题算法：从池中随机取不重复的下标，避免同一轮抽到重复题。
router.get('/poems/random', (req, res) => {
  const poems = loadPoems();
  if (poems.length === 0) {
    return res.status(500).json({ error: '题库未加载，请检查服务器 public/js/poems_data.js' });
  }

  const count = Math.min(50, Math.max(1, parseInt(req.query.count) || 10));
  const category = (req.query.category || '').trim();

  let pool = poems;
  if (category && category !== '全部') {
    pool = poems.filter((p) => p.c === category || p.category === category);   // 按分类筛选
    if (pool.length === 0) pool = poems;   // 分类无题时回退全部
  }

  const result = [];
  const used = new Set();
  while (result.length < count && used.size < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    const p = pool[idx];
    if (used.has(idx)) continue;            // 已抽过则跳过
    used.add(idx);
    result.push(p);
  }

  res.json({ poems: result, total: pool.length });
});

// ============ 排行榜 ============
// 按 (game_mode, difficulty) 精确查询，按分数降序、最大连击降序，最多 100 条。
router.get('/poem-leaderboard', (req, res) => {
  const db = getDb();
  const gameMode = (req.query.game_mode || '飞花令').toString();
  const difficulty = (req.query.difficulty || 'easy').toString();
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

  const rows = queryAll(db,
    `SELECT * FROM poem_leaderboard WHERE game_mode = ? AND difficulty = ?
     ORDER BY score DESC, combo_max DESC LIMIT ?`,
    [gameMode, difficulty, limit]
  );
  res.json({ leaderboard: rows || [] });
});

// ============ 提交成绩 ============
// 需要登录（apiAuth）；所有数值字段做下限钳制；
// 服务端二次校验分数的合理性，防止客户端直接提交任意高分作弊。
router.post('/poem-leaderboard', apiAuth, (req, res) => {
  const db = getDb();
  const user = req.apiUser;
  // 文本字段做长度截断（防超长字符串）
  const gameMode = (req.body.game_mode || '飞花令').toString().slice(0, 20);
  const difficulty = (req.body.difficulty || 'easy').toString().slice(0, 20);
  const category = (req.body.category || '全部').toString().slice(0, 20);
  // 数值字段钳制为非负整数
  const score = Math.max(0, parseInt(req.body.score) || 0);
  const comboMax = Math.max(0, parseInt(req.body.combo_max) || 0);
  const correctCount = Math.max(0, parseInt(req.body.correct_count) || 0);
  const totalCount = Math.max(0, parseInt(req.body.total_count) || 0);
  const duration = Math.max(0, parseInt(req.body.duration) || 0);

  // 服务端防作弊：分数合理性校验（防止客户端直接提交任意高分）
  if (totalCount <= 0) return res.status(400).json({ error: '题目数无效' });
  if (correctCount > totalCount) return res.status(400).json({ error: '正确数不能超过题目总数' });
  if (comboMax > correctCount) return res.status(400).json({ error: '最大连击不能超过正确数' });
  if (duration < 1) return res.status(400).json({ error: '游戏时长无效' });
  // 单题最高 100 分，总分上限 = 题目数 × 100
  const maxPossibleScore = totalCount * 100;
  if (score > maxPossibleScore) {
    return res.status(400).json({ error: '分数超过合理上限' });
  }

  // 写入排行榜
  db.run(
    'INSERT INTO poem_leaderboard (user_id, username, game_mode, difficulty, category, score, combo_max, correct_count, total_count, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.nickname || user.username, gameMode, difficulty, category, score, comboMax, correctCount, totalCount, duration]
  );
  saveDatabase();
  res.json({ success: true });
});

module.exports = router;
