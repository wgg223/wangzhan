/**
 * 诗词游戏排行榜管理路由（后台）
 * 能力：
 *   GET  /admin/leaderboard           —— 排行榜列表（mode/difficulty 筛选 + 分页 + 统计概览）
 *   POST /admin/leaderboard/delete/:id —— 删除单条记录
 *   POST /admin/leaderboard/clear      —— 清空全部排行榜数据（返回 JSON）
 * 权限：需登录且拥有 leaderboard.manage 权限；删除/清空均写审计日志。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 排行榜管理 ============

// 排行榜列表页：支持 mode（游戏模式）与 difficulty（难度）筛选
router.get('/leaderboard', isAuthenticated, hasPermission('leaderboard.manage'), (req, res) => {
  const db = req.db;
  const { mode, difficulty, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // 动态 WHERE（参数化防注入）
  let where = '1=1';
  const params = [];

  if (mode && mode !== 'all') {
    where += ' AND game_mode = ?';
    params.push(mode);
  }
  if (difficulty && difficulty !== 'all') {
    where += ' AND difficulty = ?';
    params.push(difficulty);
  }

  // 总数 + 当前页记录（按分数降序）
  const total = queryOne(db, 'SELECT COUNT(*) as count FROM poem_leaderboard WHERE ' + where, params);
  const records = queryAll(db,
    'SELECT * FROM poem_leaderboard WHERE ' + where + ' ORDER BY score DESC LIMIT ? OFFSET ?',
    [...params, parseInt(limit), offset]
  );

  // 统计概览：总记录数/填字与飞花令数量/平均分
  const stats = {
    totalRecords: queryOne(db, 'SELECT COUNT(*) as count FROM poem_leaderboard')?.count || 0,
    fillCount: queryOne(db, "SELECT COUNT(*) as count FROM poem_leaderboard WHERE game_mode = 'fill'")?.count || 0,
    feihuaCount: queryOne(db, "SELECT COUNT(*) as count FROM poem_leaderboard WHERE game_mode = 'feihua'")?.count || 0,
    avgScore: queryOne(db, 'SELECT AVG(score) as avg FROM poem_leaderboard')?.avg || 0
  };

  res.render('admin/leaderboard', {
    user: req.session.user,
    records: records,
    stats: stats,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total ? total.count : 0,
      totalPages: Math.ceil((total ? total.count : 0) / parseInt(limit))
    },
    filters: { mode: mode || 'all', difficulty: difficulty || 'all' },
    settings: res.locals.settings || {}
  });
});

// 删除单条排行榜记录
router.post('/leaderboard/delete/:id', isAuthenticated, hasPermission('leaderboard.manage'), (req, res) => {
  const db = req.db;
  db.run('DELETE FROM poem_leaderboard WHERE id = ?', [req.params.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'leaderboard', target_id: parseInt(req.params.id), target_title: '排行榜记录', detail: '删除了一条排行榜记录', ip: req.ip });
  res.redirect('/admin/leaderboard');
});

// 清空全部排行榜（不可恢复，需谨慎；前端二次确认）
router.post('/leaderboard/clear', isAuthenticated, hasPermission('leaderboard.manage'), (req, res) => {
  const db = req.db;
  db.run('DELETE FROM poem_leaderboard');
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'leaderboard', target_id: null, target_title: '全部排行榜', detail: '清空了所有排行榜数据', ip: req.ip });
  res.json({ success: true, message: '排行榜数据已清空' });
});

module.exports = router;
