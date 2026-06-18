const sanitizeHtml = require('sanitize-html');

const DEFAULT_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'figure', 'figcaption',
    'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
    'details', 'summary',
    'sup', 'sub', 'small', 'abbr', 'cite', 'q',
    'iframe',
    'video', 'audio', 'source',
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'use', 'symbol'
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*'],
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'width', 'height', 'loading'],
    'iframe': ['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'allow', 'sandbox'],
    'video': ['src', 'controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
    'audio': ['src', 'controls', 'autoplay', 'loop', 'muted'],
    'source': ['src', 'type'],
    'td': ['colspan', 'rowspan', 'headers'],
    'th': ['colspan', 'rowspan', 'scope', 'headers'],
    'col': ['span'],
    'colgroup': ['span'],
    'ol': ['start', 'type', 'reversed'],
    'blockquote': ['cite'],
    'q': ['cite'],
    'svg': ['viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'width', 'height'],
    'path': ['d', 'fill', 'stroke', 'stroke-width'],
    'circle': ['cx', 'cy', 'r', 'fill', 'stroke'],
    'rect': ['x', 'y', 'width', 'height', 'fill', 'stroke', 'rx', 'ry'],
    'line': ['x1', 'y1', 'x2', 'y2', 'stroke'],
    'polyline': ['points', 'fill', 'stroke'],
    'polygon': ['points', 'fill', 'stroke'],
    'g': ['transform', 'fill', 'stroke'],
    'use': ['href', 'xlink:href'],
    'symbol': ['viewBox', 'id']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
  allowedSchemesByTag: {
    'img': ['http', 'https', 'data', 'blob'],
    'iframe': ['http', 'https'],
    'video': ['http', 'https'],
    'audio': ['http', 'https'],
    'source': ['http', 'https']
  },
  allowedIframeHostnames: ['www.youtube.com', 'player.bilibili.com', 'www.bilibili.com'],
  disallowedTagsMode: 'discard'
};

function sanitize(html, options) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, options || DEFAULT_OPTIONS);
}

module.exports = { sanitize, sanitizeHtml, DEFAULT_OPTIONS };
