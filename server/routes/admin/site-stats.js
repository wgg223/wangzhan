/**
 * 站点统计页路由（后台）
 * 展示：用户总数、进程运行时长、Node 内存占用（RSS/堆）、Node 版本、平台与架构。
 * 权限：需登录且拥有 site_stats.view 权限。
 * 说明：纯只读统计，无数据库写操作；内存/时长格式化复用 utils/format。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { queryOne } = require('../../config/database');
const { formatBytes, formatUptime } = require('../../utils/format');

// 站点统计页面
router.get('/site-stats', isAuthenticated, hasPermission('site_stats.view'), (req, res) => {
  const db = req.db;

  // 用户总数
  const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users')?.count || 0;

  // 进程运行时长与内存占用
  const processUptime = process.uptime();
  const memUsage = process.memoryUsage();

  res.render('admin/site-stats', {
    user: req.session.user,
    stats: {
      userCount,
      uptime: processUptime,                       // 原始秒数（供前端动态计算）
      uptimeFormatted: formatUptime(processUptime),// 人类可读时长
      memory: {
        rss: memUsage.rss,                         // 常驻内存（原始字节）
        heapUsed: memUsage.heapUsed,               // 已用堆内存
        heapTotal: memUsage.heapTotal,             // 堆总量
        rssFormatted: formatBytes(memUsage.rss),
        heapUsedFormatted: formatBytes(memUsage.heapUsed),
        heapTotalFormatted: formatBytes(memUsage.heapTotal)
      },
      nodeVersion: process.version,                // Node 版本
      platform: process.platform,                  // 操作系统平台
      cpuArch: process.arch                        // CPU 架构
    },
    settings: res.locals.settings || {}
  });
});

module.exports = router;
