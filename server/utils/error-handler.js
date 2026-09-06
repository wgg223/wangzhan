/**
 * 错误安全封装工具
 * 作用：把"写操作日志"这个动作包上一层 try/catch，
 *       避免日志系统自身出错时反过来把主流程（如路由处理）搞崩。
 * 适用场景：任何"记录日志只是附加动作、失败不应影响主业务"的地方。
 */

// 引入活动日志模块（写入 activity_logs 表的函数）
const { logActivity } = require('../config/activity');

/**
 * 安全写入活动日志
 * @param {object} db - SQLite 数据库实例
 * @param {object} data - 待写入的日志数据（用户、动作、IP、路径等）
 * 说明：logActivity 内部出错时只打印错误，不向外抛出异常，
 *       保证调用方（路由/中间件）不会被日志写入失败打断。
 */
function safeLogActivity(db, data) {
  try {
    logActivity(db, data);
  } catch (err) {
    console.error('[activity-log] Error:', err.message);
  }
}

// 导出供其他模块使用的安全日志函数
module.exports = { safeLogActivity };
