const express = require('express');
const router = express.Router();
const { isAuthenticated, canAccessAdmin, hasPermission, isAdmin } = require('../../middlewares/auth');

// 导入子路由模块
const dashboardRouter = require('./dashboard');
const activityLogsRouter = require('./activity-logs');
const settingsRouter = require('./settings');
const pagesRouter = require('./pages');
const articlesRouter = require('./articles');
const usersRouter = require('./users');
const permissionsRouter = require('./permissions');
const commentsRouter = require('./comments');
const profileRouter = require('./profile');
const novelsRouter = require('./novels');
const projectsRouter = require('./projects');
const resetRouter = require('./reset');
const leaderboardRouter = require('./leaderboard');
const imageShareRouter = require('./image-share');
const mediaRouter = require('./media');
const messagesRouter = require('./messages');
const settingsBasicRouter = require('./settings-basic');
const settingsSmtpRouter = require('./settings-smtp');
const settingsAgreementRouter = require('./settings-agreement');
const settingsPopupRouter = require('./settings-popup');
const systemUpdateRouter = require('./system-update');
const backupRouter = require('./backup');
const maintenanceRouter = require('./maintenance');
const siteStatsRouter = require('./site-stats');

// ---------- Admin 全局中间件 ----------
router.use(isAuthenticated);
router.use(canAccessAdmin);

// 注入侧边栏当前路径标识
router.use((req, res, next) => {
  // 确保 userPermissions 始终有默认值，防止 layout.ejs 报错
  if (!res.locals.userPermissions) {
    res.locals.userPermissions = [];
  }
  res.locals.currentPath = req.path;
  next();
});

// ---------- 挂载子路由 ----------
router.use(siteStatsRouter);

// 普通用户访问 /admin 时重定向到站点统计
router.get('/', (req, res, next) => {
  if (req.session.user.role !== 'super_admin') {
    return res.redirect('/admin/site-stats');
  }
  next();
});

router.use(dashboardRouter);
router.use(activityLogsRouter);
router.use(settingsRouter);
router.use(pagesRouter);
// ---------- 设置模块子路由（仅管理员可访问） ----------
router.use('/settings/basic', isAdmin, settingsBasicRouter);
router.use('/settings/smtp', isAdmin, settingsSmtpRouter);
router.use('/settings/agreement', isAdmin, settingsAgreementRouter);
router.use('/settings/popup', isAdmin, settingsPopupRouter);
router.use(articlesRouter);
router.use(usersRouter);
router.use(permissionsRouter);
router.use(commentsRouter);
router.use(profileRouter);
router.use(novelsRouter);
router.use(projectsRouter);
router.use(resetRouter);
router.use(leaderboardRouter);
router.use(imageShareRouter);
router.use(mediaRouter);
router.use(messagesRouter);
router.use('/system-update', hasPermission('settings.manage'), systemUpdateRouter);
router.use(backupRouter);
router.use(maintenanceRouter);

module.exports = router;
