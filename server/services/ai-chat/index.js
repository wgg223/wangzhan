/**
 * AI 聊天服务门面：sendMessage 总编排 + 会话/消息/分支操作
 * 流式：provider 逐段回调 onDelta，流结束后一次性落库（sql.js 同步写盘，流中不写库）
 */
const { queryOne, queryAll, saveDatabase } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings } = require('./provider');
const { checkQuota, consumeQuota } = require('./quota');
const { buildContext } = require('./context');
const { maybeSummarize, embedRecentPairs } = require('./memory');
const { estimateTokens, normalizeError } = require('./utils');

// ============ 会话 ============

function createConversation(db, user, data = {}) {
  // 新会话默认知识库开关：跟随全局 RAG 设置
  const ragSetting = queryOne(db, "SELECT value FROM ai_settings WHERE key = 'ai_rag_enabled'");
  const ragEnabled = ragSetting && String(ragSetting.value) === '1' ? 1 : 0;
  db.run(`INSERT INTO ai_conversations (user_id, title, model, system_prompt, role_id, rag_enabled)
    VALUES (?, ?, ?, ?, ?, ?)`,
  [user.id, String(data.title || '新对话').slice(0, 100),
    String(data.model || '').slice(0, 100),
    String(data.system_prompt || '').slice(0, 4000),
    data.role_id ? parseInt(data.role_id, 10) : null,
    ragEnabled]);
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
  db.run('UPDATE ai_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(title || '').slice(0, 100), conv.id]);
  saveDatabase();
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

/**
 * 发送消息（流式/非流式）
 * @returns {Promise<{messageId, content, tokens, aborted, quota}>}
 * 成功/错误均计配额（错误只计次数）；主动停止不计
 */
async function sendMessage(db, user, conv, userContent, opts = {}) {
  const { stream = true, signal, onDelta } = opts;
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
  const embCfg = resolveEmbeddings(db);
  let queryEmbedding = null;
  const needEmbed = embCfg && (String(settings.ai_rag_enabled || '0') === '1' ||
    (conv.memory_enabled !== 0 && (conv.memory_mode === 'vector' || conv.memory_mode === 'both')));
  if (needEmbed) {
    const embs = await callEmbeddings(embCfg, [content]);
    if (embs && embs[0]) queryEmbedding = embs[0];
  }

  const messages = buildContext(db, conv, content, {
    excludeMsgId: userMsg.id,
    embCfg,
    queryEmbedding
  });

  let full = '';
  try {
    const result = await callChatCompletion(modelInfo, messages, {
      stream,
      signal,
      onDelta: stream ? (delta) => { full += delta; if (onDelta) onDelta(delta); } : undefined
    });
    full = result.content;
    if (!full) {
      throw new Error('模型未返回内容，请重试');
    }
  } catch (err) {
    // 主动停止：保留半截内容，status=stopped，不计配额
    if (signal && signal.aborted) {
      const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'stopped', '');
      return {
        messageId: msgId, content: full, tokens: estimateTokens(full), aborted: true,
        model: modelInfo.model_key, quota: quotaCheck.quota
      };
    }
    const reason = normalizeError(err);
    const msgId = saveAssistantMessage(db, conv, '', modelInfo, 'error', reason);
    consumeQuota(db, user, { tokens: 0, count: true }); // 失败计次数
    throw Object.assign(new Error(reason), { status: 502, messageId: msgId });
  }

  const tokens = estimateTokens(full);
  const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'done', '');
  consumeQuota(db, user, { tokens, count: true });

  // 异步记忆后处理（不阻塞响应）：摘要记忆 + 向量记忆
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  if (memoryEnabled) {
    Promise.resolve()
      .then(() => maybeSummarize(db, conv, modelInfo))
      .catch(err => console.error('[ai-chat] 摘要记忆失败:', err.message));
    if ((conv.memory_mode === 'vector' || conv.memory_mode === 'both') && embCfg) {
      Promise.resolve()
        .then(() => embedRecentPairs(db, conv, embCfg))
        .catch(err => console.error('[ai-chat] 向量记忆失败:', err.message));
    }
  }

  return {
    messageId: msgId, content: full, tokens, aborted: false,
    model: modelInfo.model_key, quota: checkQuota(db, user).quota
  };
}

function saveAssistantMessage(db, conv, content, modelInfo, status, error) {
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status, error)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
  [conv.id, conv.current_branch_id || 0, content, estimateTokens(content),
    modelInfo ? modelInfo.model_key : '', status, error]);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
  db.run('UPDATE ai_conversations SET message_count = message_count + 2, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
  saveDatabase();
  return msg.id;
}

/**
 * 重新生成：以目标 assistant 消息的前一条用户消息为输入，追加一条新回复
 */
async function regenerateMessage(db, user, conv, targetMsgId, opts = {}) {
  const { stream = true, signal, onDelta } = opts;
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
  const messages = buildContext(db, conv, prevUser.content, {
    excludeMsgId: prevUser.id,
    embCfg: null,
    queryEmbedding: null
  });

  let full = '';
  try {
    const result = await callChatCompletion(modelInfo, messages, {
      stream,
      signal,
      onDelta: stream ? (delta) => { full += delta; if (onDelta) onDelta(delta); } : undefined
    });
    full = result.content;
  } catch (err) {
    if (signal && signal.aborted) {
      const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'stopped', '');
      return {
        messageId: msgId, content: full, tokens: estimateTokens(full), aborted: true,
        model: modelInfo.model_key, quota: quotaCheck.quota
      };
    }
    const reason = normalizeError(err);
    const msgId = saveAssistantMessage(db, conv, '', modelInfo, 'error', reason);
    consumeQuota(db, user, { tokens: 0, count: true });
    throw Object.assign(new Error(reason), { status: 502, messageId: msgId });
  }

  const msgId = saveAssistantMessage(db, conv, full, modelInfo, 'done', '');
  consumeQuota(db, user, { tokens: estimateTokens(full), count: true });
  return {
    messageId: msgId, content: full, tokens: estimateTokens(full), aborted: false,
    model: modelInfo.model_key, quota: checkQuota(db, user).quota
  };
}

module.exports = {
  createConversation, getOwnConversation, renameConversation, deleteConversation,
  getOwnMessage, deleteMessage, editMessage,
  forkConversation, switchBranch, deleteBranch,
  sendMessage, regenerateMessage
};
