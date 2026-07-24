const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { queryOne } = require('../../config/database');
const { formatBytes, formatUptime } = require('../../utils/format');

router.get('/site-stats', isAuthenticated, hasPermission('site_stats.view'), (req, res) => {
  const db = req.db;

  const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users')?.count || 0;

  const processUptime = process.uptime();
  const memUsage = process.memoryUsage();

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
