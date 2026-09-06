/**
 * 维护模式中间件
 * 作用：当后台开启"维护模式"时，所有前端页面（除豁免白名单）返回
 *       503 维护页；管理员、API、静态资源、健康检查等不受影响，
 *       保证维护期间后台仍可操作、站点不中断基础服务。
 */

const { queryOne, getDb, saveDatabase } = require('../config/database');

/**
 * 确保维护模式相关的设置项存在于 settings 表（首次运行自动初始化默认值）
 * @param {Object} db - 数据库实例
 * 说明：key/value 均为硬编码常量，拼接 SQL 安全；
 *       仅在缺项时插入，然后持久化一次。
 */
function ensureMaintenanceSettings(db) {
  const defaults = [
    ['maintenance_mode', 'false'],               // 维护开关（默认关闭）
    ['maintenance_title', '系统维护中'],          // 维护页标题
    ['maintenance_message', '系统正在进行维护升级，请稍后再试。'] // 维护页说明
  ];

  let changed = false;
  for (const [key, value] of defaults) {
    const existing = queryOne(db, `SELECT id FROM settings WHERE setting_key = '${key}'`);
    if (!existing) {
      db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('${key}', '${value}')`);
      changed = true;
    }
  }
  if (changed) {
    try { saveDatabase(); } catch (e) { /* ignore */ }
  }
}

/**
 * 获取当前维护模式状态
 * @returns {{ enabled: boolean, title: string, message: string }}
 * 说明：数据库不可用时按"未开启维护"处理，避免误伤线上服务。
 */
function getMaintenanceStatus() {
  try {
    const db = getDb();
    if (!db) return { enabled: false };

    ensureMaintenanceSettings(db);   // 保证设置项存在

    const setting = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_mode'");
    const message = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_message'");
    const title = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_title'");
    return {
      enabled: setting?.setting_value === 'true',   // 仅 'true' 视为开启
      title: title?.setting_value || '系统维护中',
      message: message?.setting_value || '系统正在进行维护升级，请稍后再试。'
    };
  } catch (err) {
    return { enabled: false };   // 读取异常按未开启处理
  }
}

/**
 * 维护模式中间件（Express）
 * 白名单（放行不受维护影响）：
 *   - /admin   后台管理
 *   - /api/    API 接口
 *   - /auth    登录/注册
 *   - /health  健康检查
 *   - /setup   初始化安装
 *   - /css/ /js/ /uploads/ /assets/  静态资源
 *   - XHR/AJAX 请求（前端局部刷新）
 * 其余路径统一渲染 503 维护页。
 */
function maintenanceMiddleware(req, res, next) {
  const status = getMaintenanceStatus();

  if (!status.enabled) {   // 未开启维护：直接放行
    return next();
  }

  const path = req.path;

  // Allow admin routes, health check, setup, static assets, API calls, and XHR
  if (path.startsWith('/admin') ||
      path.startsWith('/api/') ||
      path.startsWith('/auth') ||
      path.startsWith('/health') ||
      path.startsWith('/setup') ||
      path.startsWith('/css/') ||
      path.startsWith('/js/') ||
      path.startsWith('/uploads/') ||
      path.startsWith('/assets/') ||
      req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return next();
  }

  // Return maintenance page for all other routes
  res.status(503).render('maintenance', {
    title: status.title,
    message: status.message
  });
}

module.exports = { maintenanceMiddleware, getMaintenanceStatus };
