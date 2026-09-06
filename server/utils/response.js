/**
 * HTTP 响应工具函数
 * 作用：统一 AJAX 判断与错误页面渲染逻辑，
 *       让各路由对"页面请求"和"接口请求"给出一致、正确的响应。
 */

/**
 * 判断请求是否为 AJAX 请求
 * @param {Object} req - Express 请求对象
 * @returns {boolean} true=AJAX 请求
 * 说明：Express 的 req.xhr 与 X-Requested-With 头两种方式等价，
 *       前端 jQuery/fetch 自定义头均会命中。
 */
function isAjaxRequest(req) {
  return req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';
}

/**
 * 渲染错误页面（统一 404/403 等错误页面渲染）
 * @param {Object} res - Express 响应对象
 * @param {number} statusCode - HTTP 状态码（404/403/500 等）
 * @param {string} message - 页面主标题文案
 * @param {Object} req - Express 请求对象（用于取 session 用户）
 * @param {string} [error] - 错误详情文案（可选）
 */
function renderError(res, statusCode, message, req, error) {
  res.status(statusCode).render('frontend/error', {
    message: message,
    error: error || '',
    user: req.session ? req.session.user || null : null,   // 保持导航栏登录态
    settings: res.locals.settings || {}
  });
}

module.exports = { isAjaxRequest, renderError };
