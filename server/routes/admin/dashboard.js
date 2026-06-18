const express = require('express');
const router = express.Router();
const { isAuthenticated, isSuperAdmin, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const activityModule = require('../../config/activity');
const { getRecentActivities, getActivityStats, getActiveUsers } = activityModule;
const actionLabels = activityModule.actionLabels;
const targetLabels = activityModule.targetLabels;
const logger = require('../../utils/logger');

// 后台首页（仅超级管理员）
router.get('/', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const isAdmin = isAdminRole(req.session.user);
  const userId = req.session.user.id;

  let articleCount;
  if (isAdmin) {
    articleCount = queryOne(db, 'SELECT COUNT(*) as count FROM articles')?.count || 0;
  } else {
    articleCount = queryOne(db, 'SELECT COUNT(*) as count FROM articles WHERE author_id = ?', [userId])?.count || 0;
  }
  const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users')?.count || 0;
  const pageCount = queryOne(db, 'SELECT COUNT(*) as count FROM pages')?.count || 0;
  const articleCommentPending = queryOne(db, "SELECT COUNT(*) as count FROM comments WHERE status = 'pending'")?.count || 0;
  const mediaCommentPending = queryOne(db, "SELECT COUNT(*) as count FROM media_comments WHERE status = 'pending'")?.count || 0;
  const commentCount = articleCommentPending + mediaCommentPending;
  const novelCount = queryOne(db, 'SELECT COUNT(*) as count FROM novels')?.count || 0;

  // 扩展统计数据
  let mediaCount = 0;
  let imageCount = 0;
  let imageCategoryCount = 0;
  let poemGameCount = 0;
  let novelChapterCount = 0;
  try { mediaCount = queryOne(db, 'SELECT COUNT(*) as count FROM images')?.count || 0; } catch (e) { /* ignore */ }
  try { imageCount = queryOne(db, 'SELECT COUNT(*) as count FROM images')?.count || 0; } catch (e) { /* ignore */ }
  try { imageCategoryCount = queryOne(db, 'SELECT COUNT(*) as count FROM image_categories')?.count || 0; } catch (e) { /* ignore */ }
  try { poemGameCount = queryOne(db, 'SELECT COUNT(*) as count FROM poem_leaderboard')?.count || 0; } catch (e) { /* ignore */ }
  try { novelChapterCount = queryOne(db, 'SELECT COUNT(*) as count FROM novel_chapters')?.count || 0; } catch (e) { /* ignore */ }

  // 系统运行状态
  const processUptime = process.uptime();
  const memUsage = process.memoryUsage();
  const processMemory = {
    rss: memUsage.rss,
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    external: memUsage.external
  };

  // 最近7天活动趋势
  let activityTrend = [];
  try {
    activityTrend = queryAll(db,
      "SELECT DATE(created_at) as date, COUNT(*) as count FROM activity_logs WHERE created_at >= datetime('now', '-7 days') GROUP BY DATE(created_at) ORDER BY date"
    ) || [];
  } catch (e) { /* ignore */ }

  const recentActivities = getRecentActivities(db, 50);
  logger.debug('[admin dashboard] 查询到活动日志数量:', recentActivities ? recentActivities.length : 0);
  if (recentActivities && recentActivities.length > 0) {
    const actionCounts = {};
    recentActivities.forEach(function(log) {
      const key = log.action || '未知';
      actionCounts[key] = (actionCounts[key] || 0) + 1;
    });
    logger.debug('[admin dashboard] 日志类型分布:', JSON.stringify(actionCounts));
  } else {
    logger.warn('[admin dashboard] 警告: 活动日志为空!');
  }

  // 获取图片分享站最近日志（仅当用户有 image_share.manage 权限时）
  let imageShareLogs = [];
  try {
    imageShareLogs = queryAll(db, `
      SELECT l.*, u.username as admin_name
      FROM image_logs l
      LEFT JOIN users u ON l.admin_id = u.id
      ORDER BY l.created_at DESC LIMIT 20
    `) || [];
  } catch (e) { /* ignore */ }

  // ===== 新增：服务器运维日志查询 =====
  let serverLogs = [];
  try {
    serverLogs = queryAll(db,
      `SELECT * FROM activity_logs 
       WHERE target_type = 'server' 
       ORDER BY created_at DESC LIMIT 20`
    ) || [];
  } catch (e) { /* ignore */ }

  // ===== 新增：用户认证操作日志 =====
  let authLogs = [];
  try {
    authLogs = queryAll(db,
      `SELECT * FROM activity_logs 
       WHERE target_type IN ('auth', 'password', 'email', 'captcha', 'user_status', 'user_account') 
       ORDER BY created_at DESC LIMIT 20`
    ) || [];
  } catch (e) { /* ignore */ }

  // ===== 新增：最近7天活动统计数据 =====
  const stats7d = getActivityStats(db, 7);

  // ===== 新增：活跃用户排行 =====
  const activeUsers = getActiveUsers(db, 7, 10);

  // ===== 新增：今日各类操作统计 =====
  let todayActionStats = [];
  try {
    todayActionStats = queryAll(db,
      `SELECT target_type, COUNT(*) as count FROM activity_logs 
       WHERE created_at >= datetime('now', '-1 day', '+8 hours')
       GROUP BY target_type ORDER BY count DESC`
    ) || [];
  } catch (e) { /* ignore */ }

  // ===== 新增：各类系统资源统计 =====
  let totalActivityCount = 0;
  try {
    totalActivityCount = queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0;
  } catch (e) { /* ignore */ }
  let activityLogCount = 0;
  try {
    activityLogCount = queryOne(db, "SELECT COUNT(*) as count FROM activity_logs WHERE created_at >= datetime('now', '-24 hours', '+8 hours')")?.count || 0;
  } catch (e) { /* ignore */ }

  // ===== 新增：获取不同目标类型的计数 =====
  let targetTypeDistribution = [];
  try {
    targetTypeDistribution = queryAll(db,
      `SELECT target_type, COUNT(*) as count FROM activity_logs 
       WHERE created_at >= datetime('now', '-30 days', '+8 hours')
       GROUP BY target_type ORDER BY count DESC`
    ) || [];
  } catch (e) { /* ignore */ }

  res.render('admin/dashboard', {
    user: req.session.user,
    stats: {
      articleCount,
      userCount,
      pageCount,
      commentCount,
      novelCount,
      mediaCount,
      imageCount,
      imageCategoryCount,
      poemGameCount,
      novelChapterCount,
      processUptime,
      processMemory,
      activityTrend,
      // 新增统计字段
      totalActivityCount,
      activityLogCount,
      serverLogsCount: serverLogs.length,
      authLogsCount: authLogs.length,
    },
    recentActivities: recentActivities,
    imageShareLogs: imageShareLogs,
    // 新增数据
    serverLogs: serverLogs,
    authLogs: authLogs,
    stats7d: stats7d,
    activeUsers: activeUsers,
    todayActionStats: todayActionStats,
    targetTypeDistribution: targetTypeDistribution,
    actionLabels: actionLabels,
    targetLabels: targetLabels,
    settings: res.locals.settings || {}
  });
});

module.exports = router;
