/**
 * 后台管理路由聚合入口
 * 职责：
 *   1. 全局鉴权链：isAuthenticated（必须登录）→ canAccessAdmin（必须可进后台）
 *      → doubleSubmitCookie（CSRF 双提交 Cookie，所有写操作需带 _csrf / X-CSRF-Token）；
 *   2. 注入模板变量 userPermissions（默认空数组）与 currentPath（侧边栏高亮）；
 *   3. 挂载全部后台子路由模块（各模块内部再按需叠加 hasPermission / isSuperAdmin）。
 * 说明：普通用户访问 /admin 根路径时重定向到 /admin/site-stats（仅超管可见仪表盘）。
 */
const express = require('express');
const router = express.Router();
const { isAuthenticated, canAccessAdmin, isAdmin, isSuperAdmin, hasPermission } = require('../../middlewares/auth');
const { doubleSubmitCookie } = require('../../middlewares/security');

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
const attachmentsRouter = require('./attachments');
const serverLogsRouter = require('./server-logs');
const promptsRouter = require('./prompts');
const aiImageRouter = require('./ai-image');
const aiChatRouter = require('./ai-chat');
const sharesRouter = require('./shares');

// ---------- Admin 全局中间件 ----------
router.use(isAuthenticated);
router.use(canAccessAdmin);
// CSRF 双提交 Cookie 防护：所有 admin 写操作需携带 _csrf 或 X-CSRF-Token
router.use(doubleSubmitCookie);

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
// ---------- 设置模块子路由（需 settings.manage 权限，与主 settings.js 对齐） ----------
router.use('/settings/basic', hasPermission('settings.manage'), settingsBasicRouter);
router.use('/settings/smtp', hasPermission('settings.manage'), settingsSmtpRouter);
router.use('/settings/agreement', hasPermission('settings.manage'), settingsAgreementRouter);
router.use('/settings/popup', hasPermission('settings.manage'), settingsPopupRouter);
router.use(articlesRouter);
router.use(promptsRouter);
router.use(aiImageRouter);
router.use(aiChatRouter);
router.use('/attachments', attachmentsRouter);
router.use(usersRouter);
router.use(permissionsRouter);
router.use(commentsRouter);
router.use(profileRouter);
router.use(novelsRouter);
router.use(projectsRouter);
router.use(resetRouter);
router.use(imageShareRouter);
router.use(sharesRouter);
router.use(mediaRouter);
router.use(messagesRouter);
router.use('/system-update', isSuperAdmin, systemUpdateRouter);
router.use(backupRouter);
router.use(maintenanceRouter);
router.use(serverLogsRouter);

module.exports = router;
