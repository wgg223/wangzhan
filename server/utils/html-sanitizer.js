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
    'video', 'audio', 'source'
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*'],
    'a': ['href', 'target', 'rel'],
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
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    'img': ['http', 'https', 'data', 'blob'],
    'video': ['http', 'https'],
    'audio': ['http', 'https'],
    'source': ['http', 'https']
  },
  disallowedTagsMode: 'discard'
};

function sanitize(html, options) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeHtml(html, options || DEFAULT_OPTIONS);
}

module.exports = { sanitize, sanitizeHtml, DEFAULT_OPTIONS };
