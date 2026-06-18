const express = require('express');
const router = express.Router();
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { queryAll, queryOne } = require('../../config/database');
const { actionLabels, targetLabels, getActivityStats, getActiveUsers } = require('../../config/activity');

// ============ 操作日志管理 ============

router.get('/activity-logs', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 30));
  const offset = (page - 1) * limit;

  const { action, target_type, username, keyword, date_from, date_to, ip, route, method } = req.query;

  // 构建筛选条件
  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (target_type) {
    // 支持多目标类型筛选，用逗号分隔
    const types = target_type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      conditions.push('target_type = ?');
      params.push(types[0]);
    } else if (types.length > 1) {
      conditions.push(`target_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  if (username) {
    conditions.push('username LIKE ?');
    params.push(`%${username}%`);
  }
  if (keyword) {
    conditions.push('(detail LIKE ? OR target_title LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (date_from) {
    conditions.push('created_at >= ?');
    params.push(date_from);
  }
  if (date_to) {
    conditions.push('created_at <= ?');
    params.push(date_to);
  }
  if (ip) {
    conditions.push('ip LIKE ?');
    params.push(`%${ip}%`);
  }
  if (route) {
    conditions.push('route LIKE ?');
    params.push(`%${route}%`);
  }
  if (method) {
    conditions.push('method = ?');
    params.push(method);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 获取统计
  const total = queryOne(db, `SELECT COUNT(*) as count FROM activity_logs ${where}`, params)?.count || 0;
  const today = queryOne(db,
    "SELECT COUNT(*) as count FROM activity_logs WHERE created_at >= datetime('now', '-1 day', '+8 hours')"
  )?.count || 0;
  const auth = queryOne(db,
    "SELECT COUNT(*) as count FROM activity_logs WHERE target_type IN ('auth', 'password', 'email', 'captcha')"
  )?.count || 0;
  const others = total - auth;

  // 获取当前页日志
  const logs = queryAll(
    db,
    `SELECT * FROM activity_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // 添加中文标签
  const logsWithLabels = logs.map(log => ({
    ...log,
    action_label: actionLabels[log.action] || log.action,
    target_label: targetLabels[log.target_type] || log.target_type
  }));

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // 构建分页URL（含当前筛选参数）
  function buildPageUrl(p) {
    const query = new URLSearchParams(req.query);
    query.set('page', p);
    return '/admin/activity-logs?' + query.toString();
  }

  // 获取可用的操作类型列表（用于筛选下拉框）
  let availableActions = [];
  try {
    availableActions = queryAll(db,
      'SELECT action, COUNT(*) as count FROM activity_logs GROUP BY action ORDER BY count DESC LIMIT 100'
    ) || [];
  } catch (e) { /* ignore */ }

  // 获取可用目标类型列表
  let availableTargetTypes = [];
  try {
    availableTargetTypes = queryAll(db,
      'SELECT target_type, COUNT(*) as count FROM activity_logs GROUP BY target_type ORDER BY count DESC'
    ) || [];
  } catch (e) { /* ignore */ }

  // 获取可用路由列表
  let availableRoutes = [];
  try {
    availableRoutes = queryAll(db,
      'SELECT route, COUNT(*) as count FROM activity_logs WHERE route != \'\' GROUP BY route ORDER BY count DESC LIMIT 50'
    ) || [];
  } catch (e) { /* ignore */ }

  // 近7天统计数据
  const stats7d = getActivityStats(db, 7);

  res.render('admin/activity-logs', {
    user: req.session.user,
    settings: res.locals.settings || {},
    logs: logsWithLabels,
    stats: { total, today, auth, others },
    pagination: { page, limit, total, totalPages },
    filters: {
      action: action || '',
      target_type: target_type || '',
      username: username || '',
      keyword: keyword || '',
      date_from: date_from || '',
      date_to: date_to || '',
      ip: ip || '',
      route: route || '',
      method: method || ''
    },
    buildPageUrl: buildPageUrl,
    // 新增数据
    availableActions: availableActions,
    availableTargetTypes: availableTargetTypes,
    availableRoutes: availableRoutes,
    stats7d: stats7d,
    actionLabels: actionLabels,
    targetLabels: targetLabels
  });
});

module.exports = router;
