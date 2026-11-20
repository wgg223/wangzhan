/**
 * 头像 URL 安全校验（防属性注入型存储 XSS）
 * 背景：avatar 值会被前端拼进 <img src="..."> 属性，若含双引号/尖括号/空白
 *       可闭合属性注入 onerror 等事件处理器。历史校验只查前缀和 ".."，不够。
 * 规则：
 *   - 本地路径：仅允许 /uploads/avatars/ 与 /assets/ 下的安全字符（字母数字 . _ - /）
 *   - 外部 URL：仅允许 https，且不含引号、尖括号、空白、反斜杠（OAuth 头像）
 *   - 其余一律视为非法，返回 ''（调用方回退默认头像）
 */
function sanitizeAvatarUrl(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  if (v.includes('..')) return '';
  // 本地上传/静态资源路径
  if (/^\/(uploads\/avatars|assets)\/[A-Za-z0-9._\-/]+$/.test(v)) return v;
  // 外部 https 头像（RFC3986 字符集，显式排除 " ' < > 空白 \）
  if (/^https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$/.test(v)) return v;
  return '';
}

module.exports = { sanitizeAvatarUrl };