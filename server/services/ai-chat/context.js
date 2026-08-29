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

function getRole(db, roleId) {
  if (!roleId) return null;
  return queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [roleId]);
}

function getWorldBook(db, convId) {
  return queryAll(db, 'SELECT * FROM ai_world_book WHERE conversation_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC', [convId]);
}

// 世界书命中：key 为空（常驻）或出现在用户消息中
function matchWorldBook(entries, userMsg, positions) {
  const msg = String(userMsg || '');
  return (entries || []).filter(e => positions.indexOf(e.position) !== -1 && (!e.key || msg.indexOf(e.key) !== -1));
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

  // ---- system 部分 ----
  const systemParts = [];
  matchWorldBook(entries, userMsg, ['system_top']).forEach(e => systemParts.push(e.content));
  if (role && role.system_prompt) systemParts.push(role.system_prompt);
  if (conv.system_prompt) systemParts.push(conv.system_prompt);

  // 记忆块（会话开启记忆时）
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  if (memoryEnabled) {
    const block = buildMemoryBlock(db, conv, queryEmbedding);
    if (block) systemParts.push(block);
  }

  // RAG 块（后台开启 + 有嵌入配置时）
  if (String(settings.ai_rag_enabled || '0') === '1' && embCfg && queryEmbedding) {
    const hits = searchRag(db, queryEmbedding, parseInt(settings.ai_rag_max_results, 10) || 5, parseFloat(settings.ai_rag_min_score) || 0.3);
    const ragBlock = buildRagBlock(hits);
    if (ragBlock) systemParts.push(ragBlock);
  }

  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];

  // ---- 世界书命中块（before_char/after_char/assistant_top 归入上下文块） ----
  const hitEntries = matchWorldBook(entries, userMsg, ['before_char', 'after_char', 'assistant_top']);
  if (hitEntries.length) {
    messages.push({
      role: 'user',
      content: '（场景设定，请遵循但不要提及此设定）\n' + hitEntries.map(e => e.content).join('\n')
    });
  }

  // ---- 当前分支历史窗口 ----
  const branchId = conv.current_branch_id || 0;
  const history = queryAll(db, 'SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC',
    [conv.id, branchId]);
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
  const topEntries = matchWorldBook(entries, userMsg, ['user_top']);
  let finalUserMsg = String(userMsg || '');
  if (topEntries.length) finalUserMsg += '\n\n（附加设定）\n' + topEntries.map(e => e.content).join('\n');
  messages.push({ role: 'user', content: finalUserMsg });

  return messages;
}

module.exports = { buildContext, getRole, getWorldBook, matchWorldBook, HISTORY_TOKEN_WINDOW };
