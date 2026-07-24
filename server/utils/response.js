/**
 * HTTP 响应工具函数
 */

/**
 * 判断请求是否为 AJAX 请求
 * @param {Object} req
 * @returns {boolean}
 */
function isAjaxRequest(req) {
  return req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';
}

/**
 * 渲染错误页面（统一 404/403 等错误页面渲染）
 * @param {Object} res
 * @param {number} statusCode
 * @param {string} message
 * @param {Object} req
 * @param {string} [error]
 */
function renderError(res, statusCode, message, req, error) {
  res.status(statusCode).render('frontend/error', {
    message: message,
    error: error || '',
    user: req.session ? req.session.user || null : null,
    settings: res.locals.settings || {}
  });
}

module.exports = { isAjaxRequest, renderError };
