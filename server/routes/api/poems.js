const express = require('express');
const fs = require('fs');
const path = require('path');
const { queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');

const router = express.Router();

// ============ 诗词题库（懒加载 + 缓存） ============
let poemsCache = null;
let poemsCacheError = null;

function loadPoems() {
  if (poemsCache) return poemsCache;
  if (poemsCacheError) return [];
  try {
    const filePath = path.join(__dirname, '../../../public/js/poems_data.js');
    if (!fs.existsSync(filePath)) {
      poemsCacheError = 'poems_data.js 不存在';
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) {
      poemsCacheError = 'poems_data.js 格式错误';
      return [];
    }
    poemsCache = JSON.parse(raw.slice(start, end + 1));
    return poemsCache;
  } catch (e) {
    poemsCacheError = e.message;
    return [];
  }
}

// ============ 随机诗词 ============
router.get('/poems/random', (req, res) => {
  const poems = loadPoems();
  if (poems.length === 0) {
    return res.status(500).json({ error: '题库未加载，请检查服务器 public/js/poems_data.js' });
  }

  const count = Math.min(50, Math.max(1, parseInt(req.query.count) || 10));
  const category = (req.query.category || '').trim();

  let pool = poems;
  if (category && category !== '全部') {
    pool = poems.filter((p) => p.c === category || p.category === category);
    if (pool.length === 0) pool = poems;
  }

  const result = [];
  const used = new Set();
  while (result.length < count && used.size < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    const p = pool[idx];
    if (used.has(idx)) continue;
    used.add(idx);
    result.push(p);
  }

  res.json({ poems: result, total: pool.length });
});

// ============ 排行榜 ============
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
router.post('/poem-leaderboard', apiAuth, (req, res) => {
  const db = getDb();
  const user = req.apiUser;
  const gameMode = (req.body.game_mode || '飞花令').toString().slice(0, 20);
  const difficulty = (req.body.difficulty || 'easy').toString().slice(0, 20);
  const category = (req.body.category || '全部').toString().slice(0, 20);
  const score = Math.max(0, parseInt(req.body.score) || 0);
  const comboMax = Math.max(0, parseInt(req.body.combo_max) || 0);
  const correctCount = Math.max(0, parseInt(req.body.correct_count) || 0);
  const totalCount = Math.max(0, parseInt(req.body.total_count) || 0);
  const duration = Math.max(0, parseInt(req.body.duration) || 0);

  db.run(
    'INSERT INTO poem_leaderboard (user_id, username, game_mode, difficulty, category, score, combo_max, correct_count, total_count, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.nickname || user.username, gameMode, difficulty, category, score, comboMax, correctCount, totalCount, duration]
  );
  saveDatabase();
  res.json({ success: true });
});

module.exports = router;
