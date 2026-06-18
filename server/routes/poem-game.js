const express = require('express');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { hasFrontendPermission } = require('../middlewares/auth');
const { getSettings } = require('../utils/settings');

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
router.post('/api/poem-leaderboard', (req, res) => {
  const db = req.db;
  const {
    game_mode, difficulty, category,
    score, combo_max, correct_count, total_count, duration
  } = req.body;

  if (!game_mode || !difficulty || score === undefined) {
    return res.status(400).json({ success: false, error: '缺少必要参数' });
  }

  const username = req.session.user ? req.session.user.username : (req.body.username || '匿名用户');
  const userId = req.session.user ? req.session.user.id : null;

  db.run(
    `INSERT INTO poem_leaderboard (user_id, username, game_mode, difficulty, category, score, combo_max, correct_count, total_count, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, username, game_mode, difficulty || 'easy', category || '全部', score || 0, combo_max || 0, correct_count || 0, total_count || 0, duration || 0]
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
    bestScore: bestScore ? bestScore.best : score
  });
});

module.exports = router;
