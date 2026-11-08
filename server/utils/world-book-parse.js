/**
 * 世界书文件解析（服务端，后台默认世界书导入用）
 * 兼容 SillyTavern lorebook JSON（entries 对象/数组、自有格式）与 Markdown（按标题拆条目）。
 * 语义与前台 public/js/ai-chat.js 的 parseWorldJson/parseWorldMarkdown 保持一致；
 * 此处不做长度截断/去重，由调用方按各自存储上限处理。
 */

const POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top'];
// SillyTavern position 数值 → 本站位置
const POS_MAP = { 0: 'system_top', 1: 'before_char', 2: 'after_char', 3: 'after_char', 4: 'user_top', 5: 'assistant_top' };

function parseJson(data) {
  let raw = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.entries)) raw = data.entries;
    else if (data.entries && typeof data.entries === 'object') raw = Object.keys(data.entries).map(k => data.entries[k]);
    else if (data.content) raw = [data];
  }
  const out = [];
  raw.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const keys = Array.isArray(e.key) ? e.key : String(e.key || '').split(/[,，]/);
    let key = keys.map(k => String(k).trim()).filter(Boolean).join(',');
    if (!key && e.comment) key = String(e.comment).trim();
    const content = String(e.content || '').trim();
    if (!content) return;
    out.push({
      key,
      content,
      position: POSITIONS.indexOf(e.position) !== -1 ? e.position : (POS_MAP[Number(e.position)] || 'before_char'),
      enabled: (e.disable === true || e.enabled === false || e.enabled === 0) ? 0 : 1,
      constant: e.constant ? 1 : 0,
      sort_order: parseInt(e.order, 10) || parseInt(e.sort_order, 10) || i
    });
  });
  return out;
}

function parseMarkdown(text, fileName) {
  const parts = String(text).split(/^#{1,3}[ \t]+(.+)$/m);
  const base = String(fileName || '').replace(/\.(md|markdown)$/i, '');
  const out = [];
  if (parts[0] && parts[0].trim()) out.push({ key: base, content: parts[0].trim() });
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const body = (parts[i + 1] || '').trim();
    if (body) out.push({ key: parts[i].trim(), content: body });
  }
  if (!out.length && String(text).trim()) out.push({ key: base, content: String(text).trim() });
  return out;
}

/**
 * 解析世界书文件 buffer 为标准化条目数组
 * @param {Buffer} buffer - 文件内容
 * @param {string} fileName - 文件名（用于判断 .md/.markdown 与 Markdown 条目默认 key）
 * @returns {Array<{key,content,position,enabled,constant,sort_order}>}
 */
function parseWorldBook(buffer, fileName) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (/\.(md|markdown)$/i.test(String(fileName || ''))) return parseMarkdown(text, fileName);
  return parseJson(JSON.parse(text));
}

module.exports = { parseWorldBook, parseJson, parseMarkdown, POSITIONS };
