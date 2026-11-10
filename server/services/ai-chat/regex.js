/**
 * AI 正则后处理脚本（SillyTavern Regex / RP-Hub 正则管线 式）
 * - prompt 侧：发送前对 messages 内容做替换（后端 runCompletion 调用）
 * - display 侧：渲染前对正文做替换（前端用 bootstrap 下发的脚本自行应用；后端测试路由亦用此）
 * 安全：flags 白名单、编译 try/catch、单脚本输入长度上限，避免畸形/恶意正则拖垮进程。
 * 替换串支持 $& / $1 等捕获组引用（String.replace 原生语义）。
 */
const { queryAll } = require('../../config/database');

const MAX_INPUT = 100000; // 单脚本单次替换输入字符上限（超长跳过，抑制 ReDoS 放大）
const ALLOWED_FLAGS = ['g', 'i', 'm', 's', 'u', 'y'];

function sanitizeFlags(flags) {
  const set = new Set(String(flags || 'g').split(''));
  let out = '';
  ALLOWED_FLAGS.forEach(f => { if (set.has(f)) out += f; });
  return out || 'g';
}

function compile(script) {
  const pattern = String(script.find_regex || '');
  if (!pattern) return null;
  try {
    return new RegExp(pattern, sanitizeFlags(script.flags));
  } catch (e) {
    return null; // 畸形正则跳过，不阻断生成
  }
}

function applyOne(text, script) {
  const re = compile(script);
  if (!re) return text;
  const input = String(text == null ? '' : text);
  if (input.length > MAX_INPUT) return input;
  try {
    return input.replace(re, String(script.replace_string == null ? '' : script.replace_string));
  } catch (e) {
    return input;
  }
}

// 取用户启用的脚本（按 sort_order, id 排序）
function getRegexScripts(db, userId) {
  return queryAll(db, 'SELECT * FROM ai_regex_scripts WHERE user_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC', [userId]);
}

function placementIncludes(script, side) {
  const p = String(script.placement || 'display');
  return p === 'both' || p === side;
}

// 深度范围：depthFromEnd = 距最后一条消息的距离（0 = 最后一条）
function depthAllows(script, depthFromEnd) {
  const min = script.min_depth == null ? null : parseInt(script.min_depth, 10);
  const max = script.max_depth == null ? null : parseInt(script.max_depth, 10);
  if (min != null && !isNaN(min) && depthFromEnd < min) return false;
  if (max != null && !isNaN(max) && depthFromEnd > max) return false;
  return true;
}

// prompt 侧：逐条应用（按深度范围），返回新数组，不改原数组
function applyPromptRegex(messages, scripts) {
  const list = (scripts || []).filter(s => placementIncludes(s, 'prompt'));
  if (!list.length) return messages;
  const len = messages.length;
  return messages.map((m, idx) => {
    const depthFromEnd = len - 1 - idx;
    let content = String(m.content == null ? '' : m.content);
    list.forEach(s => { if (depthAllows(s, depthFromEnd)) content = applyOne(content, s); });
    return content === m.content ? m : Object.assign({}, m, { content });
  });
}

// display 侧：对单段正文应用（后端测试路由用；前端有等价 JS 实现）
function applyDisplayRegex(text, scripts) {
  const list = (scripts || []).filter(s => placementIncludes(s, 'display'));
  let out = String(text == null ? '' : text);
  list.forEach(s => { out = applyOne(out, s); });
  return out;
}

module.exports = {
  getRegexScripts, applyPromptRegex, applyDisplayRegex, applyOne, sanitizeFlags, compile, MAX_INPUT
};