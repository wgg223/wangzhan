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
// 群聊其余成员卡注入总预算（字符）：按人数均分，避免大群撑爆上下文。
// 10500 = 7 × 1500，保证 8 人及以下群聊每成员仍可获得完整 1500 字摘要（与旧行为一致）。
const GROUP_CARD_BUDGET = 10500;
// 单条消息 token 上限：超过则截断（节省上下文 token）
const MSG_TOKEN_LIMIT = 500;
// 世界书条目内容长度上限（字符）
const WORLD_BOOK_CONTENT_LIMIT = 2000;

/**
 * 压缩单条消息：超过 MSG_TOKEN_LIMIT 时截断并添加标记
 */
function compressMessage(content) {
  const text = String(content || '');
  const tokens = estimateTokens(text);
  if (tokens <= MSG_TOKEN_LIMIT) return text;
  // 按字符估算截断位置（1 token ≈ 1.5 字符 for CJK, 4 chars for others）
  const maxChars = Math.floor(MSG_TOKEN_LIMIT * 2.5);
  return text.slice(0, maxChars) + '\n\n[... 消息已截断，原文 ' + tokens + ' tokens]';
}

/**
 * 压缩世界书条目：去重 + 截断长内容
 */
function compressWorldBookEntries(entries) {
  const seen = new Set();
  return (entries || []).filter(e => {
    const key = (e.key || '').trim().toLowerCase();
    const content = String(e.content || '').trim();
    if (!content) return false;
    // 按 key+content 前 100 字符去重
    const dedupKey = key + '|' + content.slice(0, 100);
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    // 截断长内容
    if (content.length > WORLD_BOOK_CONTENT_LIMIT) {
      e.content = content.slice(0, WORLD_BOOK_CONTENT_LIMIT) + '\n[... 已截断]';
    }
    return true;
  });
}

function getRole(db, roleId) {
  if (!roleId) return null;
  return queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [roleId]);
}

// 群聊成员（按 group_members JSON 顺序，过滤已删除角色）
function getGroupMembers(db, conv) {
  let ids = [];
  try { ids = JSON.parse(conv.group_members || '[]'); } catch (e) { ids = []; }
  if (!Array.isArray(ids)) return [];
  return ids.map(id => getRole(db, parseInt(id, 10))).filter(Boolean);
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
  const { excludeMsgId, embCfg, queryEmbedding, speakerRoleId, noUserMsg } = opts;
  const settings = getSettings(db);
  const isGroup = !!conv.is_group;
  const members = isGroup ? getGroupMembers(db, conv) : [];
  const speaker = isGroup ? (members.find(m => m.id === speakerRoleId) || members[0] || null) : null;
  const role = isGroup ? speaker : getRole(db, conv.role_id);
  const rawEntries = getWorldBook(db, conv.id);
  const entries = compressWorldBookEntries(rawEntries);

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
    // 提示词模板：有模板时用模板替代默认角色卡组装
    if (conv.prompt_template_id) {
      const tpl = queryOne(db, 'SELECT content FROM ai_prompt_templates WHERE id = ?', [conv.prompt_template_id]);
      if (tpl && tpl.content) {
        const userRow = queryOne(db, 'SELECT username FROM users WHERE id = ?', [conv.user_id]);
        const userName = (userRow && userRow.username) || '用户';
        const rendered = tpl.content
          .replace(/\{\{char\}\}/gi, role.name || '')
          .replace(/\{\{user\}\}/gi, userName)
          .replace(/\{\{scenario\}\}/gi, role.scenario || '')
          .replace(/\{\{personality\}\}/gi, role.personality || '')
          .replace(/\{\{description\}\}/gi, role.description || '')
          .replace(/\{\{greeting\}\}/gi, role.greeting || '')
          .replace(/\{\{examples\}\}/gi, role.examples || '');
        systemParts.push(rendered);
      }
    } else {
      // 默认角色卡组装
      const roleParts = [];
      if (role.system_prompt) roleParts.push(role.system_prompt);
      if (role.personality) roleParts.push('【角色性格】\n' + role.personality);
      if (role.scenario) roleParts.push('【当前场景】\n' + role.scenario);
      if (role.examples) roleParts.push('【示例对话（仅供模仿风格，不要复述）】\n' + role.examples);
      if (roleParts.length) systemParts.push(roleParts.join('\n\n'));
    }
  }
  if (conv.system_prompt) systemParts.push(conv.system_prompt);

  // 群聊框架：扮演当前说话人，其余成员卡摘要注入（SillyTavern Group Chats 语义）
  if (isGroup && members.length) {
    const groupLines = ['【群聊设定】这是多角色群聊。你现在扮演「' + (role ? role.name : '未知角色') + '」，只以该角色的身份回复，不要替其他角色或用户发言，回复不要带名字前缀。'];
    groupLines.push('群成员：' + members.map(m => m.name).join('、'));
    const others = members.filter(m => !role || m.id !== role.id);
    const perCard = others.length ? Math.min(1500, Math.floor(GROUP_CARD_BUDGET / others.length)) : 1500;
    others.forEach(m => {
      const card = [m.system_prompt, m.personality, m.description].filter(Boolean).join('\n');
      if (card) groupLines.push('成员「' + m.name + '」的设定：\n' + card.slice(0, perCard));
    });
    systemParts.push(groupLines.join('\n'));
  }

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
    if (m.is_active === 0) continue; // 跳过非活跃 alternate
    // 压缩长消息以节省 token
    const compressed = compressMessage(m.content);
    tokens += estimateTokens(compressed);
    windowMsgs.unshift({ ...m, content: compressed });
    if (tokens > HISTORY_TOKEN_WINDOW) break;
  }

  // 作者注释（Author's Note）：插入到历史窗口的指定深度位置
  const authorNote = String(conv.author_note || '').trim();
  const noteDepth = Math.max(parseInt(conv.author_note_depth, 10) || 4, 0);
  let noteInserted = false;

  windowMsgs.forEach((m, idx) => {
    // 在倒数第 noteDepth 条消息前插入作者注释
    if (authorNote && !noteInserted && idx === Math.max(0, windowMsgs.length - noteDepth)) {
      messages.push({ role: 'system', content: '[Author\'s Note: ' + authorNote + ']' });
      noteInserted = true;
    }
    // 群聊中其他角色的发言归入 user 侧并带名字前缀，当前说话人的历史保持 assistant
    if (isGroup && m.role === 'assistant' && m.speaker_role_id && role && m.speaker_role_id !== role.id) {
      const sp = members.find(x => x.id === m.speaker_role_id);
      messages.push({ role: 'user', content: (sp ? sp.name : '角色') + ': ' + String(m.content || '') });
    } else {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
    }
  });
  // 如果历史太短没插入，放在历史最前面
  if (authorNote && !noteInserted) {
    messages.splice(1, 0, { role: 'system', content: '[Author\'s Note: ' + authorNote + ']' });
  }

  // ---- 用户消息（user_top 世界书条目附加到消息尾部；noUserMsg 用于群聊手动顶帖） ----
  if (!noUserMsg) {
    const topEntries = matchWorldBook(entries, userMsg, recentForScan, ['user_top']);
    let finalUserMsg = String(userMsg || '');
    if (topEntries.length) finalUserMsg += '\n\n（附加设定）\n' + topEntries.map(e => e.content).join('\n');
    messages.push({ role: 'user', content: finalUserMsg });
  }

  return messages;
}

module.exports = { buildContext, getRole, getGroupMembers, getWorldBook, matchWorldBook, HISTORY_TOKEN_WINDOW };
