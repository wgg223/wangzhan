/**
 * 世界书文件解析（服务端，后台默认世界书导入用）
 * 兼容 SillyTavern lorebook JSON（entries 对象/数组、自有格式）与 Markdown（按标题拆条目）。
 * 语义与前台 public/js/ai-chat.js 的 parseWorldJson/parseWorldMarkdown 保持一致；
 * 此处不做长度截断/去重，由调用方按各自存储上限处理。
 */

const POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'in_chat'];
// SillyTavern position 数值 → 本站位置（V2: 0=before char defs, 1=after char defs；旧映射保留兼容）
const POS_MAP = { 0: 'before_char', 1: 'after_char', 2: 'system_top', 3: 'system_top', 4: 'user_top', 5: 'assistant_top' };
// SillyTavern V3 position 字符串 → 本站位置
const POS_STR_MAP = {
  beforeChar: 'before_char', afterChar: 'after_char',
  beforeEM: 'system_top', afterEM: 'system_top',
  beforeAN: 'user_top', afterAN: 'assistant_top',
  atDepth: 'in_chat'
};

function normalizeKeys(v) {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean).join(',');
  return String(v || '').split(/[,，]/).map(k => k.trim()).filter(Boolean).join(',');
}

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
    let key = normalizeKeys(e.key != null ? e.key : e.keys);
    if (!key && e.comment) key = String(e.comment).trim();
    const content = String(e.content || '').trim();
    if (!content) return;
    // 位置：本站名称 → V3 字符串 → injection_position=2(固定深度) → V2 数值
    let position;
    if (POSITIONS.indexOf(e.position) !== -1) position = e.position;
    else if (POS_STR_MAP[e.position]) position = POS_STR_MAP[e.position];
    else if (e.injection_position === 2 || e.injection_position === '2') position = 'in_chat';
    else position = POS_MAP[Number(e.position)] || 'before_char';
    const depth = Math.min(Math.max(parseInt(e.depth != null ? e.depth : e.injection_depth, 10) || 4, 0), 200);
    out.push({
      key,
      content,
      position,
      enabled: (e.disable === true || e.enabled === false || e.enabled === 0) ? 0 : 1,
      constant: e.constant ? 1 : 0,
      secondary_keys: normalizeKeys(e.secondary_keys),
      selective: (e.selective === true || e.selective === 1) ? 1 : 0,
      probability: Math.min(Math.max(parseInt(e.probability, 10) || 100, 0), 100),
      depth,
      sort_order: parseInt(e.insertion_order, 10) || parseInt(e.order, 10) || parseInt(e.sort_order, 10) || i
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
