const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { queryOne } = require('../../config/database');

router.get('/site-stats', isAuthenticated, hasPermission('site_stats.view'), (req, res) => {
  const db = req.db;

  const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users')?.count || 0;

  const processUptime = process.uptime();
  const memUsage = process.memoryUsage();

  const formatUptime = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    if (minutes > 0) return `${minutes}分钟 ${secs}秒`;
    return `${secs}秒`;
  };

  const formatBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  res.render('admin/site-stats', {
    user: req.session.user,
    stats: {
      userCount,
      uptime: processUptime,
      uptimeFormatted: formatUptime(processUptime),
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rssFormatted: formatBytes(memUsage.rss),
        heapUsedFormatted: formatBytes(memUsage.heapUsed),
        heapTotalFormatted: formatBytes(memUsage.heapTotal)
      },
      nodeVersion: process.version,
      platform: process.platform,
      cpuArch: process.arch
    },
    settings: res.locals.settings || {}
  });
});

module.exports = router;
