/**
 * AI 聊天服务门面：sendMessage 总编排 + 会话/消息/分支操作
 * 流式：provider 逐段回调 onDelta，流结束后一次性落库（sql.js 同步写盘，流中不写库）
 */
const { queryOne, queryAll, saveDatabase } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings } = require('./provider');
const { checkQuota, consumeQuota } = require('./quota');
const { buildContext, getGroupMembers } = require('./context');
const { maybeSummarize, embedRecentPairs } = require('./memory');
const { estimateTokens, normalizeError } = require('./utils');

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
  const defaultEntries = queryAll(db, 'SELECT key, content, position, sort_order, enabled, constant FROM ai_default_world_book WHERE enabled = 1 ORDER BY sort_order ASC, id ASC');
  defaultEntries.forEach(e => {
    db.run('INSERT INTO ai_world_book (conversation_id, key, content, position, sort_order, enabled, constant) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, e.key, e.content, e.position, e.sort_order, e.enabled, e.constant]);
  });

  // 角色开场白：新会话选择带开场白的角色时，自动注入第一条 AI 消息
  if (conv.role_id) {
    const role = queryOne(db, 'SELECT greeting FROM ai_roles WHERE id = ?', [conv.role_id]);
    const greeting = role && role.greeting ? String(role.greeting).trim() : '';
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

// 群聊成员校验：仅官方或本人角色，去重，上限 8 个
function validateGroupMembers(db, user, ids) {
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach(v => {
    const id = parseInt(v, 10);
    if (!id || out.indexOf(id) !== -1 || out.length >= 8) return;
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
 */
async function runCompletion(db, user, conv, modelInfo, messages, opts, quotaCheck) {
  const { stream = true, signal, onDelta } = opts;
  const genParams = extractGenParams(conv);
  let full = '';
  try {
    const result = await callChatCompletion(modelInfo, messages, {
      stream,
      signal,
      onDelta: stream ? (delta) => { full += delta; if (onDelta) onDelta(delta); } : undefined,
      genParams
    });
    full = result.content;
    if (!full) throw new Error('模型未返回内容，请重试');
  } catch (err) {
    // 主动停止：保留半截内容，status=stopped，不计配额
    if (signal && signal.aborted) {
      const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'stopped', '', opts.speakerRoleId);
      return {
        messageId: msgId, content: full, tokens: estimateTokens(full), aborted: true,
        model: modelInfo.model_key, quota: quotaCheck.quota
      };
    }
    const reason = normalizeError(err);
    const msgId = saveAssistantMessage(db, conv, '', modelInfo, 'error', reason, opts.speakerRoleId);
    consumeQuota(db, user, { tokens: 0, count: true }); // 失败计次数
    throw Object.assign(new Error(reason), { status: 502, messageId: msgId });
  }

  const tokens = estimateTokens(full);
  const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'done', '', opts.speakerRoleId);
  consumeQuota(db, user, { tokens, count: true });
  return {
    messageId: msgId, content: full, tokens, aborted: false,
    model: modelInfo.model_key, quota: checkQuota(db, user).quota
  };
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
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }

  const modelInfo = resolveModel(db, user.id, conv.model);
  const quotaCheck = checkQuota(db, user);
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

  // 异步记忆后处理（不阻塞响应）：摘要记忆 + 向量记忆
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  if (!result.aborted && memoryEnabled) {
    Promise.resolve()
      .then(() => maybeSummarize(db, conv, modelInfo))
      .catch(err => console.error('[ai-chat] 摘要记忆失败:', err.message));
    if ((conv.memory_mode === 'vector' || conv.memory_mode === 'both') && embCfg) {
      Promise.resolve()
        .then(() => embedRecentPairs(db, conv, embCfg))
        .catch(err => console.error('[ai-chat] 向量记忆失败:', err.message));
    }
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
  let last = null;
  for (const sp of speakers) {
    if (opts.signal && opts.signal.aborted) break;
    const quotaCheck = checkQuota(db, user);
    if (!quotaCheck.ok) {
      if (!last) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });
      break;
    }
    if (opts.onSpeaker) opts.onSpeaker({ role_id: sp.id, name: sp.name, avatar: sp.avatar || '' });
    const modelInfo = resolveModel(db, user.id, conv.model);
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
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }
  if (!conv.is_group) throw Object.assign(new Error('该会话不是群聊'), { status: 400 });
  const members = getGroupMembers(db, conv);
  const sp = members.find(m => m.id === parseInt(roleId, 10));
  if (!sp) throw Object.assign(new Error('指定的角色不在群成员中'), { status: 400 });
  const quotaCheck = checkQuota(db, user);
  if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });
  const lastUser = queryOne(db, "SELECT content FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
    [conv.id, conv.current_branch_id || 0]);
  const modelInfo = resolveModel(db, user.id, conv.model);
  const messages = buildContext(db, conv, lastUser ? lastUser.content : '', { speakerRoleId: sp.id, noUserMsg: true });
  if (opts.onSpeaker) opts.onSpeaker({ role_id: sp.id, name: sp.name, avatar: sp.avatar || '' });
  const result = await runCompletion(db, user, conv, modelInfo, messages,
    Object.assign({}, opts, { speakerRoleId: sp.id }), quotaCheck);
  return { result, speaker: sp };
}

function saveAssistantMessage(db, conv, content, modelInfo, status, error, speakerRoleId) {
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status, error, speaker_role_id)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
  [conv.id, conv.current_branch_id || 0, content, estimateTokens(content),
    modelInfo ? modelInfo.model_key : '', status, error, speakerRoleId || null]);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
  db.run('UPDATE ai_conversations SET message_count = message_count + 2, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
  saveDatabase();
  return msg.id;
}

/**
 * 重新生成：以目标 assistant 消息的前一条用户消息为输入，追加一条新回复
 */
async function regenerateMessage(db, user, conv, targetMsgId, opts = {}) {
  const settings = getSettings(db);
  if (String(settings.ai_enabled ?? '1') === '0') {
    throw Object.assign(new Error('AI 聊天功能暂未开放'), { status: 403 });
  }
  const quotaCheck = checkQuota(db, user);
  if (!quotaCheck.ok) throw Object.assign(new Error(quotaCheck.reason), { status: 429 });

  const target = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ? AND conversation_id = ?', [targetMsgId, conv.id]);
  if (!target || target.role !== 'assistant') {
    throw Object.assign(new Error('消息不存在或无法重新生成'), { status: 404 });
  }
  const branchId = target.branch_id || 0;
  const prevUser = queryOne(db, `SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    [conv.id, branchId, target.id]);
  if (!prevUser) throw Object.assign(new Error('找不到对应的用户消息'), { status: 400 });

  const modelInfo = resolveModel(db, user.id, conv.model);
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

module.exports = {
  createConversation, getOwnConversation, renameConversation, deleteConversation,
  updateGroup, getOwnMessage, deleteMessage, editMessage,
  forkConversation, switchBranch, deleteBranch,
  sendMessage, regenerateMessage, groupReply, extractGenParams
};
