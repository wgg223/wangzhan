/**
 * AI 聊天上下文组装管线：
 * system（角色 prompt + 会话 prompt + 世界书 system_top）→ 记忆块 → RAG 块
 * → 世界书命中（before_char 等）→ 当前分支历史窗口 → 用户消息
 */
const { queryAll, queryOne } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { estimateTokens } = require('./utils');
const { buildMemoryBlock } = require('./memory');
const { searchRag, buildRagBlock } = require('./rag');

const HISTORY_TOKEN_WINDOW = 3000;
// 世界书触发词扫描深度：同时检查当前消息与最近 N 条消息，避免关键词出现在上一条就失配
const WORLD_SCAN_DEPTH = 6;

function getRole(db, roleId) {
  if (!roleId) return null;
  return queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [roleId]);
}

function getWorldBook(db, convId) {
  return queryAll(db, 'SELECT * FROM ai_world_book WHERE conversation_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC', [convId]);
}

/**
 * 世界书命中判定：
 *  - constant=1 或 key 为空 → 常驻注入，始终命中
 *  - 否则按 key 拆分多关键词（支持逗号/顿号/分号/空格分隔），大小写不敏感，
 *    在「当前用户消息 + 最近 WORLD_SCAN_DEPTH 条消息」中命中任一关键词即触发
 */
function matchWorldBook(entries, userMsg, recentMsgs, positions) {
  const msg = String(userMsg || '');
  const recent = (recentMsgs || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => String(m.content || ''))
    .join('\n');
  const haystack = (msg + '\n' + recent).toLowerCase();
  return (entries || []).filter(e => {
    if (positions.indexOf(e.position) === -1) return false;
    if (e.constant) return true; // 显式常驻
    const keys = String(e.key || '').split(/[,，、;；\s]+/).map(k => k.trim().toLowerCase()).filter(Boolean);
    if (!keys.length) return true; // 无触发词 → 视作常驻注入（向后兼容）
    return keys.some(k => haystack.indexOf(k) !== -1);
  });
}

/**
 * 组装发给模型的 messages 数组
 * @param {Object} db
 * @param {Object} conv
 * @param {string} userMsg - 当前用户消息
 * @param {Object} opts - { excludeMsgId, modelInfo, embCfg, queryEmbedding }
 */
function buildContext(db, conv, userMsg, opts = {}) {
  const { excludeMsgId, embCfg, queryEmbedding } = opts;
  const settings = getSettings(db);
  const role = getRole(db, conv.role_id);
  const entries = getWorldBook(db, conv.id);

  // ---- 当前分支历史（先取历史，供世界书触发词扫描与对话窗口复用） ----
  const branchId = conv.current_branch_id || 0;
  const history = queryAll(db, 'SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC',
    [conv.id, branchId]);
  const recentForScan = history
    .filter(m => !(excludeMsgId && m.id === excludeMsgId))
    .slice(-WORLD_SCAN_DEPTH);

  // ---- system 部分 ----
  const systemParts = [];
  matchWorldBook(entries, userMsg, recentForScan, ['system_top']).forEach(e => systemParts.push(e.content));
  if (role) {
    // 角色卡：system_prompt + 性格 + 场景 + 示例对话 组装为完整角色上下文
    const roleParts = [];
    if (role.system_prompt) roleParts.push(role.system_prompt);
    if (role.personality) roleParts.push('【角色性格】\n' + role.personality);
    if (role.scenario) roleParts.push('【当前场景】\n' + role.scenario);
    if (role.examples) roleParts.push('【示例对话（仅供模仿风格，不要复述）】\n' + role.examples);
    if (roleParts.length) systemParts.push(roleParts.join('\n\n'));
  }
  if (conv.system_prompt) systemParts.push(conv.system_prompt);

  // 记忆块（会话开启记忆时）
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  if (memoryEnabled) {
    const block = buildMemoryBlock(db, conv, queryEmbedding);
    if (block) systemParts.push(block);
  }

  // RAG 块（全局开启 + 会话开启 + 有嵌入配置时）
  const ragOn = conv.rag_enabled !== 0 && String(settings.ai_rag_enabled || '0') === '1' && embCfg && queryEmbedding;
  if (ragOn) {
    const hits = searchRag(db, queryEmbedding, parseInt(settings.ai_rag_max_results, 10) || 5, parseFloat(settings.ai_rag_min_score) || 0.3);
    const ragBlock = buildRagBlock(hits);
    if (ragBlock) systemParts.push(ragBlock);
  }

  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];

  // ---- 世界书命中块（before_char/after_char/assistant_top 归入上下文块） ----
  const hitEntries = matchWorldBook(entries, userMsg, recentForScan, ['before_char', 'after_char', 'assistant_top']);
  if (hitEntries.length) {
    messages.push({
      role: 'user',
      content: '（场景设定，请遵循但不要提及此设定）\n' + hitEntries.map(e => e.content).join('\n')
    });
  }

  // ---- 当前分支历史窗口 ----
  let windowMsgs = [];
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (excludeMsgId && m.id === excludeMsgId) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.status === 'error' || m.status === 'stopped') continue;
    tokens += estimateTokens(m.content);
    windowMsgs.unshift(m);
    if (tokens > HISTORY_TOKEN_WINDOW) break;
  }
  windowMsgs.forEach(m => {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  });

  // ---- 用户消息（user_top 世界书条目附加到消息尾部） ----
  const topEntries = matchWorldBook(entries, userMsg, recentForScan, ['user_top']);
  let finalUserMsg = String(userMsg || '');
  if (topEntries.length) finalUserMsg += '\n\n（附加设定）\n' + topEntries.map(e => e.content).join('\n');
  messages.push({ role: 'user', content: finalUserMsg });

  return messages;
}

module.exports = { buildContext, getRole, getWorldBook, matchWorldBook, HISTORY_TOKEN_WINDOW };
