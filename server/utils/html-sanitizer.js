/**
 * HTML 消毒工具（XSS 防护核心）
 * 作用：基于 sanitize-html 库，对用户提交/富文本编辑器产出的 HTML
 *       做白名单过滤——只保留允许的标签、属性和协议，剥离其余一切
 *       （包括 <script>、on* 事件属性、javascript: 协议等），
 *       从根本上防止存储型/反射型 XSS 攻击。
 */

const sanitizeHtml = require('sanitize-html'); // 第三方 HTML 清洗库

/**
 * 默认消毒白名单配置
 * - allowedTags    ：允许保留的 HTML 标签列表（富文本常用排版标签）
 * - allowedAttributes：各标签允许保留的属性；'*' 表示所有标签通用属性，
 *                     data-* / aria-* 用通配符放行
 * - allowedSchemes ：允许的链接协议（仅 http/https/mailto/tel，排除 javascript:）
 * - allowedSchemesByTag：img 额外放行 data: 与 blob:（用于 base64/对象URL图片）
 * - disallowedTagsMode：'discard' = 不在白名单的标签整段丢弃（而非转义）
 */
const DEFAULT_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',            // 标题与段落
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',       // 行内样式
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',                             // 列表
    'blockquote', 'pre', 'code',                                    // 引用与代码
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', // 表格
    'a', 'img', 'figure', 'figcaption',                             // 链接、图片、图文
    'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',    // 布局
    'details', 'summary',                                           // 折叠块
    'sup', 'sub', 'small', 'abbr', 'cite', 'q',                     // 语义行内元素
    'video', 'audio', 'source'                                      // 音视频（配合 src 白名单）
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*'],
    'a': ['href', 'target', 'rel'],                                  // rel 通常由库自动补 noreferrer
    'img': ['src', 'alt', 'width', 'height', 'loading'],
    'video': ['src', 'controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
    'audio': ['src', 'controls', 'autoplay', 'loop', 'muted'],
    'source': ['src', 'type'],
    'td': ['colspan', 'rowspan', 'headers'],
    'th': ['colspan', 'rowspan', 'scope', 'headers'],
    'col': ['span'],
    'colgroup': ['span'],
    'ol': ['start', 'type', 'reversed'],
    'blockquote': ['cite'],
    'q': ['cite']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],                // 禁止 javascript: 等危险协议
  allowedSchemesByTag: {
    'img': ['http', 'https', 'data', 'blob'],                        // 图片允许内联/对象 URL
    'video': ['http', 'https'],
    'audio': ['http', 'https'],
    'source': ['http', 'https']
  },
  disallowedTagsMode: 'discard'                                       // 白名单外标签直接丢弃
};

/**
 * 对 HTML 字符串执行消毒
 * @param {string} html - 原始 HTML 输入
 * @param {object} [options] - 可覆盖默认白名单的配置（一般不用传）
 * @returns {string} 消毒后的安全 HTML；非字符串/空值返回空串
 */
function sanitize(html, options) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, options || DEFAULT_OPTIONS);
}

// 导出消毒函数、库本体（供特殊场景自定义调用）与默认配置
module.exports = { sanitize, sanitizeHtml, DEFAULT_OPTIONS };
