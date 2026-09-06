/**
 * 古诗词游戏（飞花令）路由
 * 接口：
 *   GET  /poem-game                  —— 游戏页面
 *   GET  /poem-game/api/poem-leaderboard —— 排行榜查询（支持 mode/difficulty 筛选 + 分页）
 *   POST /poem-game/api/poem-leaderboard —— 提交分数（每 IP 每分钟 30 次限流防刷榜）
 * 安全要点：分数服务端校验（0-10000 有限数字）；未登录用户用自定义用户名提交
 *           （存在匿名冒名风险，见检查报告）。
 */
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { hasFrontendPermission } = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { getSettings } = require('../utils/settings');

// 排行榜提交限流：每 IP 1 分钟 30 次，防止刷榜
const scoreSubmitLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.ip,
  message: '提交过于频繁，请稍后再试'
});

// 古诗词游戏页面
router.get('/', hasFrontendPermission('poem-game.access'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  res.render('frontend/poem-game', {
    user: req.session.user || null,
    settings: settings
  });
});

// 获取排行榜数据
router.get('/api/poem-leaderboard', (req, res) => {
  const db = req.db;
  const { mode, difficulty, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = '1=1';
  const params = [];

  if (mode) {
    where += ' AND game_mode = ?';
    params.push(mode);
  }
  if (difficulty) {
    where += ' AND difficulty = ?';
    params.push(difficulty);
  }

  const total = queryOne(db, `SELECT COUNT(*) as count FROM poem_leaderboard WHERE ${where}`, params);
  const records = queryAll(db,
    `SELECT * FROM poem_leaderboard WHERE ${where} ORDER BY score DESC LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), offset]
  );

  res.json({
    success: true,
    records: records,
    total: total ? total.count : 0,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

// 提交分数到排行榜
router.post('/api/poem-leaderboard', scoreSubmitLimiter, (req, res) => {
  const db = req.db;
  const {
    game_mode, difficulty, category,
    score, combo_max, correct_count, total_count, duration
  } = req.body;

  // 记录提交参数到日志（防刷审计）
  console.log('[poem-game] 排行榜提交参数:', JSON.stringify(req.body), 'IP:', req.ip);

  if (!game_mode || !difficulty || score === undefined) {
    return res.status(400).json({ success: false, error: '缺少必要参数' });
  }

  // 服务端校验分数：必须为有限数字且在 0-10000 范围内，取整
  const scoreNum = Number(score);
  if (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 10000) {
    return res.status(400).json({ success: false, error: '分数无效（需为 0-10000 之间的数字）' });
  }
  const finalScore = Math.round(scoreNum);

  const username = req.session.user ? req.session.user.username : (req.body.username || '匿名用户');
  const userId = req.session.user ? req.session.user.id : null;

  db.run(
    `INSERT INTO poem_leaderboard (user_id, username, game_mode, difficulty, category, score, combo_max, correct_count, total_count, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, username, game_mode, difficulty || 'easy', category || '全部', finalScore, combo_max || 0, correct_count || 0, total_count || 0, duration || 0]
  );

  saveDatabase();

  // 返回该用户的最高分
  const bestScore = queryOne(db,
    'SELECT MAX(score) as best FROM poem_leaderboard WHERE username = ? AND game_mode = ? AND difficulty = ?',
    [username, game_mode, difficulty]
  );

  res.json({
    success: true,
    message: '分数已记录到排行榜',
    bestScore: bestScore ? bestScore.best : finalScore
  });
});

module.exports = router;
