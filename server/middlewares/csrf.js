/**
 * CSRF 中间件（已弃用）
 *
 * 此文件已被 server/middlewares/security.js 替代。
 * 新的安全方案使用：
 * - 双提交Cookie模式 (Double Submit Cookie)
 * - SameSite Cookie 属性
 * - 自定义请求头验证 (X-Requested-With)
 * - Origin/Referer 验证
 * - 一次性令牌机制 (Nonce)
 *
 * 保留此文件仅用于向后兼容，实际功能已委托给 securityMiddleware。
 */

const { securityMiddleware, generateToken } = require('./security');

// 导出兼容接口
const csrfProtection = securityMiddleware;

module.exports = { csrfProtection, generateToken };
