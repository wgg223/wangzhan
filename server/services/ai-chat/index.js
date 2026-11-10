/**
 * AI 聊天服务门面：sendMessage 总编排 + 会话/消息/分支操作
 * 流式：provider 逐段回调 onDelta，流结束后一次性落库（sql.js 同步写盘，流中不写库）
 */
const { queryOne, queryAll, saveDatabase } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings } = require('./provider');
const { checkQuota, consumeQuota } = require('./quota');
const { buildContext, getGroupMembers } = require('./context');
const { summarizeRound, embedRound, getRounds, markReplyStart, markReplyEnd } = require('./memory');
const { estimateTokens, normalizeError } = require('./utils');
const characterCards = require('./characters');

// ============ 会话 ============

function createConversation(db, user, data = {}) {
  // 新会话默认知识库开关：跟随全局 RAG 设置
  const ragSetting = queryOne(db, "SELECT value FROM ai_settings WHERE key = 'ai_rag_enabled'");
  const ragEnabled = ragSetting && String(ragSetting.value) === '1' ? 1 : 0;
  const isGroup = data.is_group ? 1 : 0;
  const members = isGroup ? validateGroupMembers(db, user, data.group_members) : [];
  if (isGroup && members.length < 2) {
    throw Object.assign(new Error('群聊至少需要 2 个角色'), { status: 400 });
  }
  db.run(`INSERT INTO ai_conversations (user_id, title, model, system_prompt, role_id, rag_enabled, is_group, group_members, group_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [user.id, String(data.title || (isGroup ? '新群聊' : '新对话')).trim().slice(0, 100),
    String(data.model || '').slice(0, 100),
    String(data.system_prompt || '').slice(0, 4000),
    !isGroup && data.role_id ? parseInt(data.role_id, 10) : null,
    ragEnabled, isGroup, JSON.stringify(members),
    data.group_mode === 'manual' ? 'manual' : 'round']);
  const conv = queryOne(db, 'SELECT * FROM ai_conversations WHERE id = last_insert_rowid()');

  // 默认世界书：新会话自动复制启用中的全局默认条目（副本，会话内可自由编辑）
  const defaultEntries = queryAll(db, `SELECT key, content, position, sort_order, enabled, constant,
      secondary_keys, selective, probability, depth FROM ai_default_world_book WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`);
  defaultEntries.forEach(e => {
    db.run(`INSERT INTO ai_world_book (conversation_id, key, content, position, sort_order, enabled, constant,
        secondary_keys, selective, probability, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, e.key, e.content, e.position, e.sort_order, e.enabled, e.constant,
      e.secondary_keys || '', e.selective || 0, e.probability == null ? 100 : e.probability, e.depth == null ? 4 : e.depth]);
  });

  // 角色开场白：新会话选择带开场白的角色时，自动注入第一条 AI 消息（支持备选开场白）
  if (conv.role_id) {
    const role = queryOne(db, 'SELECT greeting, alternate_greetings FROM ai_roles WHERE id = ?', [conv.role_id]);
    const greeting = role ? characterCards.pickGreeting(role, data.greeting_index) : '';
    if (greeting) {
      db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status)
        VALUES (?, 0, 'assistant', ?, ?, '', 'done')`,
      [conv.id, greeting, estimateTokens(greeting)]);
      db.run('UPDATE ai_conversations SET message_count = message_count + 1 WHERE id = ?', [conv.id]);
    }
  }
  return queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [conv.id]);
}

function getOwnConversation(db, user, convId) {
  const conv = queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [convId]);
  if (!conv || conv.user_id !== user.id) return null;
  return conv;
}

function renameConversation(db, conv, title) {
  db.run('UPDATE ai_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(title || '').trim().slice(0, 100), conv.id]);
  saveDatabase();
}

// 群聊成员校验：仅官方或本人角色，去重，上限 16 个
function validateGroupMembers(db, user, ids) {
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach(v => {
    const id = parseInt(v, 10);
    if (!id || out.indexOf(id) !== -1 || out.length >= 16) return;
    const role = queryOne(db, 'SELECT id FROM ai_roles WHERE id = ? AND (is_official = 1 OR user_id = ?)', [id, user.id]);
    if (role) out.push(id);
  });
  return out;
}

function updateGroup(db, user, conv, data = {}) {
  if (!conv.is_group) throw Object.assign(new Error('该会话不是群聊'), { status: 400 });
  const members = validateGroupMembers(db, user, data.members);
  if (members.length < 2) throw Object.assign(new Error('群聊至少需要 2 个角色'), { status: 400 });
  const mode = data.mode === 'manual' ? 'manual' : 'round';
  const title = data.title ? String(data.title).trim().slice(0, 100) : conv.title;
  db.run('UPDATE ai_conversations SET group_members = ?, group_mode = ?, title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(members), mode, title, conv.id]);
  saveDatabase();
  return queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [conv.id]);
}

function deleteConversation(db, conv) {
  db.run('DELETE FROM ai_conversations WHERE id = ?', [conv.id]); // 级联删除消息/世界书/记忆/分支
  saveDatabase();
}

// ============ 消息 ============

function getOwnMessage(db, user, msgId) {
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ?', [msgId]);
  if (!msg) return null;
  const conv = getOwnConversation(db, user, msg.conversation_id);
  if (!conv) return null;
  return { msg, conv };
}

function deleteMessage(db, conv, msg) {
  const branchId = msg.branch_id || 0;
  // 删除该消息及之后同分支消息
  db.run('DELETE FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND id >= ?', [conv.id, branchId, msg.id]);
  // 删除以该消息为父的分支（父消息已删）
  db.run('DELETE FROM ai_branches WHERE conversation_id = ? AND parent_message_id >= ?', [conv.id, msg.id]);
  if (conv.current_branch_id && branchId === (conv.current_branch_id || 0)) {
    db.run('UPDATE ai_conversations SET current_branch_id = 0 WHERE id = ?', [conv.id]);
  }
  saveDatabase();
}

function editMessage(db, conv, msg, content) {
  db.run('UPDATE ai_messages SET content = ? WHERE id = ?', [String(content || '').slice(0, 8000), msg.id]);
  saveDatabase();
}

// ============ 分支 ============

function forkConversation(db, conv, msg) {
  const branchId = (conv.current_branch_id || 0);
  // 复制父消息之后的所有消息到新分支
  db.run('INSERT INTO ai_branches (conversation_id, name, parent_message_id) VALUES (?, ?, ?)',
    [conv.id, '新分支', msg.id]);
  const branch = queryOne(db, 'SELECT * FROM ai_branches WHERE id = last_insert_rowid()');
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status, error, created_at)
    SELECT conversation_id, ?, role, content, tokens, model, status, error, created_at
    FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND id > ?`,
  [branch.id, conv.id, branchId, msg.id]);
  db.run('UPDATE ai_conversations SET current_branch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [branch.id, conv.id]);
  saveDatabase();
  return branch;
}

function switchBranch(db, conv, branchId) {
  const target = branchId === 0 ? 0 : queryOne(db, 'SELECT id FROM ai_branches WHERE id = ? AND conversation_id = ?', [branchId, conv.id]);
  if (branchId !== 0 && !target) return false;
  db.run('UPDATE ai_conversations SET current_branch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [branchId, conv.id]);
  saveDatabase();
  return true;
}

function deleteBranch(db, conv, branchId) {
  if (branchId === 0) return false;
  const branch = queryOne(db, 'SELECT id FROM ai_branches WHERE id = ? AND conversation_id = ?', [branchId, conv.id]);
  if (!branch) return false;
  db.run('DELETE FROM ai_messages WHERE conversation_id = ? AND branch_id = ?', [conv.id, branchId]);
  db.run('DELETE FROM ai_branches WHERE id = ?', [branchId]);
  if ((conv.current_branch_id || 0) === branchId) {
    db.run('UPDATE ai_conversations SET current_branch_id = 0 WHERE id = ?', [conv.id]);
  }
  saveDatabase();
  return true;
}

// ============ 发送 ============

function extractGenParams(conv) {
  const gp = {};
  if (conv.gen_temperature != null) gp.temperature = conv.gen_temperature;
  if (conv.gen_top_p != null) gp.top_p = conv.gen_top_p;
  if (conv.gen_top_k != null) gp.top_k = conv.gen_top_k;
  if (conv.gen_frequency_penalty != null) gp.frequency_penalty = conv.gen_frequency_penalty;
  if (conv.gen_presence_penalty != null) gp.presence_penalty = conv.gen_presence_penalty;
  if (conv.gen_max_tokens != null) gp.max_tokens = conv.gen_max_tokens;
  return Object.keys(gp).length ? gp : undefined;
}

/**
 * 调用模型 + 结果落库 + 配额消耗（sendMessage / regenerateMessage 共用）
 * 主动停止：保留半截内容，status=stopped，不计配额；失败：status=error，只计次数
 * 抗截断：finish_reason=length 时自动追加 assistant 前缀续写（RP-Hub 式，最多 N 次）
 */
async function runCompletion(db, user, conv, modelInfo, messages, opts, quotaCheck) {
  const { stream = true, signal, onDelta, onReasoning, onContinue } = opts;
  const genParams = extractGenParams(conv);
  const settings = getSettings(db);
  const autoContinue = String(settings.ai_auto_continue ?? '1') !== '0';
  const maxContinue = Math.min(Math.max(parseInt(settings.ai_auto_continue_max, 10) || 3, 0), 5);
  let full = '';
  let reasoning = '';
  let usage = null; // 存储 API 返回的实际 token 消耗
  let finishReason = 'stop';
  let continuePasses = 0;
  try {
    // prompt 侧正则后处理已统一在 buildContext（context.js）中应用，此处直接使用传入 messages
    const workMsgs = messages.slice();
    for (;;) {
      const result = await callChatCompletion(modelInfo, workMsgs, {
        stream,
        signal,
        onDelta: stream ? (delta) => { if (onDelta) onDelta(delta); } : undefined,
        onReasoning: stream && onReasoning ? onReasoning : undefined,
        genParams
      });
      full += result.content || '';
      if (result.reasoning) reasoning += result.reasoning;
      if (result.usage) usage = result.usage;
      finishReason = result.finishReason || 'stop';
      // 抗截断自动续写：把已生成内容作为 assistant 前缀，请求模型接着写
      if (autoContinue && finishReason === 'length' && continuePasses < maxContinue &&
          !(signal && signal.aborted) && full) {
        continuePasses++;
        workMsgs.push({ role: 'assistant', content: full });
        if (onContinue) onContinue({ pass: continuePasses });
        continue;
      }
      break;
    }
    if (!full) throw new Error('模型未返回内容，请重试');
  } catch (err) {
    // 主动停止：保留半截内容，status=stopped，不计配额
    if (signal && signal.aborted) {
      const inputTokens = usage ? usage.prompt_tokens : estimateTokens(messages.map(m => m.content).join('\n'));
      const outputTokens = usage ? usage.completion_tokens : estimateTokens(full);
      const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'stopped', '', opts.speakerRoleId, inputTokens, outputTokens,
        { reasoning, genInfo: buildGenInfo(modelInfo, genParams, finishReason, continuePasses) });
      return {
        messageId: msgId, content: full, tokens: inputTokens + outputTokens,
        inputTokens, outputTokens, aborted: true, reasoning,
        model: modelInfo.model_key, quota: quotaCheck.quota
      };
    }
    const reason = normalizeError(err);
    const msgId = saveAssistantMessage(db, conv, '', modelInfo, 'error', reason, opts.speakerRoleId, 0, 0);
    consumeQuota(db, user, { tokens: 0, count: true, ownApi: modelInfo.is_own }); // 失败计次数
    throw Object.assign(new Error(reason), { status: 502, messageId: msgId });
  }

  // 优先使用 API 返回的实际 token 数，否则估算
  const inputTokens = usage ? usage.prompt_tokens : estimateTokens(messages.map(m => m.content).join('\n'));
  const outputTokens = usage ? usage.completion_tokens : estimateTokens(full);
  const totalTokens = inputTokens + outputTokens;

  const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'done', '', opts.speakerRoleId, inputTokens, outputTokens,
    { reasoning, genInfo: buildGenInfo(modelInfo, genParams, finishReason, continuePasses) });
  consumeQuota(db, user, { tokens: totalTokens, count: true, ownApi: modelInfo.is_own });
  return {
    messageId: msgId, content: full, tokens: totalTokens,
    inputTokens, outputTokens, aborted: false, reasoning, finishReason, continuePasses,
    model: modelInfo.model_key, quota: checkQuota(db, user).quota
  };
}

// 生成参数快照（SillyTavern swipe_info 语义）：记录本条回复的模型/参数/截断续写次数
function buildGenInfo(modelInfo, genParams, finishReason, continuePasses) {
  return Object.assign({
    model: modelInfo ? modelInfo.model_key : '',
    finish_reason: finishReason || 'stop',
    continued: continuePasses || 0,
    ts: Date.now()
  }, genParams || {});
}

/**
 * 对用户消息计算嵌入（向量记忆/RAG 检索用；配置缺失或不需要时 queryEmbedding 为 null）
 */
async function embedUserMessage(db, conv, settings, content) {
  const embCfg = resolveEmbeddings(db);
  if (!embCfg) return { embCfg: null, queryEmbedding: null };
  const needEmbed = String(settings.ai_rag_enabled || '0') === '1' ||
    (conv.memory_enabled !== 0 && (conv.memory_mode === 'vector' || conv.memory_mode === 'both'));
  if (!needEmbed) return { embCfg, queryEmbedding: null };
  const embs = await callEmbeddings(embCfg, [content]);
  return { embCfg, queryEmbedding: (embs && embs[0]) || null };
}

/**
 * 发送消息（流式/非流式）
 * @returns {Promise<{messageId, content, tokens, aborted, quota}>}
 * 成功/错误均计配额（错误只计次数）；主动停止不计
 */
async function sendMessage(db, user, conv, userContent, opts = {}) {
  markReplyStart(conv.id);
  try {
    return await sendMessageInner(db, user, conv, userContent, opts);
  } finally {
    markReplyEnd(conv.id);
  }
}

async function sendMessageInner(db, user, conv, userContent, opts = {}) {
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }

  const modelInfo = resolveModel(db, user.id, conv.model);
  const quotaCheck = checkQuota(db, user, { ownApi: modelInfo.is_own });
  if (!quotaCheck.ok) {
    throw Object.assign(new Error(quotaCheck.reason), { status: 429 });
  }

  const content = String(userContent || '').trim();
  if (!content) throw Object.assign(new Error('消息内容不能为空'), { status: 400 });
  if (content.length > 8000) throw Object.assign(new Error('消息过长（最多 8000 字）'), { status: 400 });

  // 用户消息落库
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, status) VALUES (?, ?, 'user', ?, 'done')`,
    [conv.id, conv.current_branch_id || 0, content]);
  const userMsg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');

  // 向量记忆 / RAG 用：对用户消息做嵌入（配置缺失自动跳过）
  const { embCfg, queryEmbedding } = await embedUserMessage(db, conv, settings, content);

  // 群聊：round=成员按序各回一条；manual=仅落用户消息，由用户点角色触发回复
  if (conv.is_group) {
    if (conv.group_mode === 'manual' && !opts.speakerRoleId) {
      db.run('UPDATE ai_conversations SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
      saveDatabase();
      return { noReply: true, aborted: false };
    }
    return sendGroupRound(db, user, conv, content, opts, {
      excludeMsgId: userMsg.id, embCfg, queryEmbedding
    });
  }

  const messages = buildContext(db, conv, content, {
    excludeMsgId: userMsg.id,
    embCfg,
    queryEmbedding
  });

  const result = await runCompletion(db, user, conv, modelInfo, messages, opts, quotaCheck);

  // 异步记忆后处理（不阻塞响应）：为最新一轮生成逐轮总结 +（增强模式）逐轮向量
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  if (!result.aborted && memoryEnabled) {
    Promise.resolve()
      .then(async () => {
        const rounds = getRounds(db, conv.id, conv.current_branch_id || 0);
        const last = rounds[rounds.length - 1];
        if (!last) return;
        const summary = await summarizeRound(db, conv, modelInfo, last);
        if ((conv.memory_mode === 'vector' || conv.memory_mode === 'both') && embCfg && summary) {
          await embedRound(db, conv, embCfg, last, summary);
        }
      })
      .catch(err => console.error('[ai-chat] 逐轮记忆失败:', err.message));
  }

  return result;
}

/**
 * 群聊一轮：按成员顺序（或指定说话人）逐个生成回复，SSE 通过 onSpeaker/onResult 上报
 */
async function sendGroupRound(db, user, conv, userMsg, opts, ctxOpts) {
  const members = getGroupMembers(db, conv);
  if (!members.length) throw Object.assign(new Error('群聊没有可用成员，请先添加角色'), { status: 400 });
  const speakers = opts.speakerRoleId ? members.filter(m => m.id === opts.speakerRoleId) : members;
  if (!speakers.length) throw Object.assign(new Error('指定的角色不在群成员中'), { status: 400 });
  const modelInfo = resolveModel(db, user.id, conv.model);
  let last = null;
  for (const sp of speakers) {
    if (opts.signal && opts.signal.aborted) break;
    const quotaCheck = checkQuota(db, user, { ownApi: modelInfo.is_own });
    if (!quotaCheck.ok) {
      if (!last) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });
      break;
    }
    if (opts.onSpeaker) opts.onSpeaker({ role_id: sp.id, name: sp.name, avatar: sp.avatar || '' });
    const messages = buildContext(db, conv, userMsg, Object.assign({}, ctxOpts, { speakerRoleId: sp.id }));
    last = await runCompletion(db, user, conv, modelInfo, messages,
      Object.assign({}, opts, { speakerRoleId: sp.id }), quotaCheck);
    if (opts.onResult) opts.onResult(last, sp);
    if (last.aborted) break;
  }
  if (!last) throw Object.assign(new Error('没有生成任何回复'), { status: 502 });
  return last;
}

/**
 * 群聊手动顶帖：不新增用户消息，指定角色对当前上下文回复一条
 */
async function groupReply(db, user, conv, roleId, opts = {}) {
  markReplyStart(conv.id);
  try {
    return await groupReplyInner(db, user, conv, roleId, opts);
  } finally {
    markReplyEnd(conv.id);
  }
}

async function groupReplyInner(db, user, conv, roleId, opts = {}) {
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }
  if (!conv.is_group) throw Object.assign(new Error('该会话不是群聊'), { status: 400 });
  const members = getGroupMembers(db, conv);
  const sp = members.find(m => m.id === parseInt(roleId, 10));
  if (!sp) throw Object.assign(new Error('指定的角色不在群成员中'), { status: 400 });
  const modelInfo = resolveModel(db, user.id, conv.model);
  const quotaCheck = checkQuota(db, user, { ownApi: modelInfo.is_own });
  if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });
  const lastUser = queryOne(db, "SELECT content FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
    [conv.id, conv.current_branch_id || 0]);
  const messages = buildContext(db, conv, lastUser ? lastUser.content : '', { speakerRoleId: sp.id, noUserMsg: true });
  if (opts.onSpeaker) opts.onSpeaker({ role_id: sp.id, name: sp.name, avatar: sp.avatar || '' });
  const result = await runCompletion(db, user, conv, modelInfo, messages,
    Object.assign({}, opts, { speakerRoleId: sp.id }), quotaCheck);
  return { result, speaker: sp };
}

function saveAssistantMessage(db, conv, content, modelInfo, status, error, speakerRoleId, inputTokens, outputTokens, extra) {
  const ex = extra || {};
  const totalTokens = (inputTokens || 0) + (outputTokens || 0) || estimateTokens(content);
  const genInfoStr = ex.genInfo ? JSON.stringify(ex.genInfo) : '';
  const reasoningStr = String(ex.reasoning || '').slice(0, 20000);
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, input_tokens, output_tokens, model, status, error, speaker_role_id, reasoning, gen_info)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [conv.id, conv.current_branch_id || 0, content, totalTokens, inputTokens || 0, outputTokens || 0,
    modelInfo ? modelInfo.model_key : '', status, error, speakerRoleId || null, reasoningStr, genInfoStr]);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
  db.run('UPDATE ai_conversations SET message_count = message_count + 2, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
  saveDatabase();
  return msg.id;
}

/**
 * 重新生成：以目标 assistant 消息的前一条用户消息为输入，追加一条新回复
 */
async function regenerateMessage(db, user, conv, targetMsgId, opts = {}) {
  markReplyStart(conv.id);
  try {
    return await regenerateMessageInner(db, user, conv, targetMsgId, opts);
  } finally {
    markReplyEnd(conv.id);
  }
}

async function regenerateMessageInner(db, user, conv, targetMsgId, opts = {}) {
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }
  const modelInfo = resolveModel(db, user.id, conv.model);
  const quotaCheck = checkQuota(db, user, { ownApi: modelInfo.is_own });
  if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });

  const target = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ? AND conversation_id = ?', [targetMsgId, conv.id]);
  if (!target || target.role !== 'assistant') {
    throw Object.assign(new Error('消息不存在或无法重新生成'), { status: 404 });
  }
  const branchId = target.branch_id || 0;
  const prevUser = queryOne(db, `SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    [conv.id, branchId, target.id]);
  if (!prevUser) throw Object.assign(new Error('找不到对应的用户消息'), { status: 400 });

  // 与 sendMessage 一致：重新生成同样做向量记忆/RAG 检索；群聊保留原说话人
  const { embCfg, queryEmbedding } = await embedUserMessage(db, conv, settings, prevUser.content);
  const messages = buildContext(db, conv, prevUser.content, {
    excludeMsgId: prevUser.id,
    embCfg,
    queryEmbedding,
    speakerRoleId: target.speaker_role_id || undefined
  });

  return runCompletion(db, user, conv, modelInfo, messages,
    Object.assign({}, opts, { speakerRoleId: target.speaker_role_id || undefined }), quotaCheck);
}

/**
 * 预测用户接下来最可能发送的 N 条消息（RP-Hub / SillyTavern「建议回复」式）
 * 轻量上下文：仅取当前分支最近若干条历史 + 角色简介，低 max_tokens、非流式，
 * 要求模型严格输出 JSON 字符串数组；不落库、不触发记忆，仅按实际用量计配额。
 * @returns {Promise<{suggestions: string[]}>}
 */
async function predictReplies(db, user, conv, opts = {}) {
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }
  if (String(settings.ai_predict_enabled ?? '1') === '0') {
    throw Object.assign(new Error('预测功能已被管理员关闭'), { status: 403 });
  }
  const modelInfo = resolveModel(db, user.id, conv.model);
  const quotaCheck = checkQuota(db, user, { ownApi: modelInfo.is_own });
  if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });

  const count = Math.min(Math.max(parseInt(settings.ai_predict_count, 10) || 3, 1), 5);
  const branchId = conv.current_branch_id || 0;
  const history = queryAll(db, `SELECT role, content, speaker_role_id FROM ai_messages
    WHERE conversation_id = ? AND branch_id = ? AND status = 'done' ORDER BY id DESC LIMIT 16`,
    [conv.id, branchId]).reverse();
  if (!history.length) return { suggestions: [] };

  // 角色简介（群聊取会话标题即可，单聊附带角色名/性格，帮助预测贴合语境）
  let roleBrief = '';
  const speakerNames = {};
  if (!conv.is_group && conv.role_id) {
    const role = queryOne(db, 'SELECT name, personality, scenario FROM ai_roles WHERE id = ?', [conv.role_id]);
    if (role) {
      roleBrief = '正在对话的角色：' + (role.name || '') +
        (role.personality ? '。性格：' + String(role.personality).slice(0, 200) : '') +
        (role.scenario ? '。场景：' + String(role.scenario).slice(0, 200) : '');
    }
  } else if (conv.is_group) {
    // 群聊：一次性解析说话人角色名，用于对话记录标注
    queryAll(db, 'SELECT id, name FROM ai_roles').forEach(r => { speakerNames[r.id] = r.name; });
  }

  const transcript = history.map(m => {
    const who = m.role === 'user' ? '用户' : (speakerNames[m.speaker_role_id] || 'AI');
    return who + '：' + String(m.content || '').slice(0, 500);
  }).join('\n');

  // 本轮重点：明确最近一条 AI 回复与用户上一句，避免建议脱离当前楼层
  const lastAi = history.filter(m => m.role !== 'user').pop();
  const lastUser = history.filter(m => m.role === 'user').pop();
  const focusLines = [];
  if (lastUser) focusLines.push('用户上一句：' + String(lastUser.content || '').slice(0, 300));
  if (lastAi) focusLines.push('AI 最新回复：' + String(lastAi.content || '').slice(0, 500));

  const askCount = Math.min(count + 2, 6); // 多要两条候选，过滤掉与用户已说过的话重复后仍有足够可用条目
  const sys = '你是 RP 对话预测助手。站在【用户】的立场，预测用户看到 AI 最新回复后接下来最可能发送的消息。' +
    '要求：' +
    '1) 紧扣【本轮重点】与最近一两轮的具体内容（回应对方刚说的话、追问细节、推进剧情），不要写放之四海皆准的套话；' +
    '2) 严禁复用、改写或概括用户已经说过的话；' +
    '3) 每条口语化、第一人称，不超过 30 字，可用括号写简短动作，但不要旁白解说；' +
    '4) ' + askCount + ' 条之间意图要不同（如追问信息、情绪或立场表达、主动推进剧情、轻微岔开话题），不要近义改写；' +
    '5) 符合当前角色性格与该角色所在场景，不要 OOC。' +
    '只输出一个 JSON 字符串数组，形如 ["...","..."]，不要任何解释或多余文字。';
  const messages = [
    { role: 'system', content: sys + (roleBrief ? '\n' + roleBrief : '') },
    { role: 'user', content: '以下是当前对话记录（越靠后越新）：\n' + transcript +
      (focusLines.length ? '\n\n【本轮重点】\n' + focusLines.join('\n') : '') +
      '\n\n请预测用户看到 AI 最新回复后，接下来最可能发送的 ' + askCount + ' 条消息（JSON 数组）：' }
  ];

  let full = '';
  let usage = null;
  try {
    const result = await callChatCompletion(modelInfo, messages, {
      stream: false,
      signal: opts.signal,
      timeout: 30000,
      genParams: { temperature: 0.75, max_tokens: 480 }
    });
    full = result.content || '';
    usage = result.usage || null;
  } catch (err) {
    if (opts.signal && opts.signal.aborted) return { suggestions: [] };
    throw Object.assign(new Error(normalizeError(err)), { status: 502 });
  }

  const suggestions = parseSuggestions(full, count, {
    // 最近用户已发过的内容：形态不同的近义改写也一起挡掉
    blocklist: history.filter(m => m.role === 'user').slice(-6).map(m => String(m.content || ''))
  });
  const inputTokens = usage ? usage.prompt_tokens : estimateTokens(messages.map(m => m.content).join('\n'));
  const outputTokens = usage ? usage.completion_tokens : estimateTokens(full);
  consumeQuota(db, user, { tokens: inputTokens + outputTokens, count: false, ownApi: modelInfo.is_own });
  return { suggestions };
}

// 从模型输出中稳健提取字符串数组（容忍 ```json 包裹、前后缀噪声、逐行输出等）
function parseSuggestions(text, count, opts = {}) {
  const block = (opts.blocklist || []).map(x => String(x || '')).filter(Boolean);
  const raw = String(text || '').trim();
  if (!raw) return [];
  let arr = null;
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) { try { arr = JSON.parse(m[0]); } catch (e) { arr = null; } }
  if (!Array.isArray(arr)) {
    // JSON 被截断时的兜底：只捞成对的引号片段，绝不把半截 JSON 当成一条建议
    const quoted = [];
    const re = /["“]([^"“”]{1,80})["”]/g;
    let hit = null;
    while ((hit = re.exec(raw)) !== null) quoted.push(hit[1]);
    if (quoted.length) {
      arr = quoted;
    } else {
      arr = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '')
        .split('\n').map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/^[\d\-.、)）*\s]+/, '').replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, ''))
        .filter(s => s && !/^[\[\]{}]+$/.test(s));
    }
  }
  const seen = {};
  return arr
    .map(s => String(typeof s === 'string' ? s : (s && s.content) || '').trim().slice(0, 60))
    .filter(s => {
      if (!s || seen[s.toLowerCase()]) return false;
      if (block.length && block.some(b => isSimilarText(s, b))) return false; // 与用户刚说过的话雷同
      seen[s.toLowerCase()] = 1;
      return true;
    })
    .slice(0, count);
}

// 归一化：去掉空白、标点、引号、装饰符号，只留实义字符
function normReplyText(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；："'“”‘’（）()\[\]{}<>《》~～·…—\-—_*^`|\\/]/g, '');
}

// 两条建议是否与用户已发内容重复：完全相同 / 互相包含 / 字符或二元组重合度过高
// 覆盖「换个语序讲同一句」的改写，但不误伤只是用词有交集的正常回复
function isSimilarText(a, b) {
  const x = normReplyText(a), y = normReplyText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shortLen = Math.min(x.length, y.length);
  const longLen = Math.max(x.length, y.length);
  if (shortLen >= 4 && (x.includes(y) || y.includes(x))) return true;
  if (shortLen < 4) return false;
  if (shortLen / longLen < 0.55) return false; // 长度差太多，多半不是同一句改写

  const setX = new Set(Array.from(x));
  const setY = new Set(Array.from(y));
  const small = setX.size <= setY.size ? setX : setY;
  const big = setX.size <= setY.size ? setY : setX;
  let common = 0;
  small.forEach(ch => { if (big.has(ch)) common++; });
  if (common / small.size >= 0.8) return true; // 字符重合度：容忍语序调整

  if (shortLen < 5) return false;
  const grams = (str) => {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const A = grams(x), B = grams(y);
  let hit = 0;
  A.forEach(g => { if (B.has(g)) hit++; });
  return hit / A.size >= 0.7;
}

// 判断某会话（或默认）解析出的模型是否为用户自填模型（走自己的 API，不受站内配额限制）
function isOwnModel(db, userId, convModel) {
  const m = resolveModel(db, userId, convModel);
  return !!(m && m.is_own);
}

module.exports = {
  createConversation, getOwnConversation, renameConversation, deleteConversation,
  updateGroup, getOwnMessage, deleteMessage, editMessage,
  forkConversation, switchBranch, deleteBranch,
  sendMessage, regenerateMessage, groupReply, extractGenParams, predictReplies, isOwnModel
};
