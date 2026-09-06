/**
 * AI 聊天管理路由（后台，需 aichat.manage 权限）
 * 模块：
 *   - 总览页        GET  /admin/ai-chat                     （模型/官方角色/知识库/配额一览）
 *   - 模型管理      POST /admin/ai-chat/models/{save,delete,test}  （全局模型 CRUD + 连通性测试，Key 加密存储）
 *   - 角色管理      POST /admin/ai-chat/roles/{save,delete}         （官方角色 CRUD，system_prompt≤4000字）
 *   - 系统设置      POST /admin/ai-chat/settings/save               （开关/配额/RAG/记忆/Embedding/流式）
 *   - 知识库 RAG    POST /admin/ai-chat/knowledge/{upload,delete,reembed} （txt/md≤2MB，上传即分块嵌入）
 *   - 配额管理      GET /admin/ai-chat/quota  POST /admin/ai-chat/quota/update
 *   - 统计          GET /admin/ai-chat/stats
 * 说明：模型/角色均为全局（user_id IS NULL）；API Key 以 ENC: 前缀密文落库，永不回显明文；
 *       默认模型变更会同步写 settings.ai_default_model 并清缓存，前台立即生效。
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { isAuthenticated, hasPermission, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { encrypt } = require('../../config/crypto-secure');
const { getSettings, upsertSettings } = require('../../utils/settings');
const { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings } = require('../../services/ai-chat/provider');
const { embedDocument } = require('../../services/ai-chat/rag');
const { normalizeError } = require('../../services/ai-chat/utils');

// ============ AI 聊天管理（模型/角色/设置/知识库/配额） ============

function first(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ============ 总览页 ============

router.get('/ai-chat', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const models = queryAll(db, "SELECT * FROM ai_models WHERE user_id IS NULL ORDER BY is_default DESC, sort_order ASC, id ASC");
  models.forEach(m => { m.has_key = Boolean(m.api_key && m.api_key.indexOf('ENC:') === 0); });
  const roles = queryAll(db, "SELECT * FROM ai_roles WHERE is_official = 1 ORDER BY sort_order ASC, id ASC");
  const defaultWorldBook = queryAll(db, 'SELECT * FROM ai_default_world_book ORDER BY sort_order ASC, id ASC');
  const docs = queryAll(db, 'SELECT * FROM ai_knowledge_docs ORDER BY id DESC');
  const quotaRows = queryAll(db, `
    SELECT q.*, u.username, u.nickname, u.role
    FROM ai_quota q LEFT JOIN users u ON q.user_id = u.id
    ORDER BY q.id DESC LIMIT 100`);

  res.render('admin/ai-chat', {
    user: req.session.user,
    settings: res.locals.settings || {},
    aiSettings: settings,
    models,
    roles,
    defaultWorldBook,
    docs,
    quotaRows,
    hasEmbeddings: Boolean(settings.ai_embedding_api_base && settings.ai_embedding_model),
    userPermissions: res.locals.userPermissions || []
  });
});

// ============ 模型管理（全局模型，user_id IS NULL） ============

router.post('/ai-chat/models/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const name = (first(req.body.name) || '').trim().slice(0, 100);
  const modelKey = (first(req.body.model_key) || '').trim().slice(0, 100);
  const provider = (first(req.body.provider) || 'openai').trim().slice(0, 50);
  const apiEndpoint = (first(req.body.api_endpoint) || '').trim().slice(0, 300);
  const maxTokens = Math.min(Math.max(toInt(first(req.body.max_tokens), 4096), 256), 32768);
  const temperature = Math.min(Math.max(parseFloat(first(req.body.temperature)) || 0.7, 0), 2);
  const isDefault = first(req.body.is_default) === '1' || first(req.body.is_default) === 'on' ? 1 : 0;
  const enabled = first(req.body.enabled) === '0' ? 0 : 1;
  if (!name || !modelKey) return res.status(400).json({ error: '名称和模型标识不能为空' });

  const existing = id ? queryOne(db, 'SELECT * FROM ai_models WHERE id = ? AND user_id IS NULL', [id]) : null;
  let apiKey = existing ? (existing.api_key || '') : '';
  const rawKey = first(req.body.api_key);
  if (rawKey && rawKey.indexOf('ENC:') !== 0) {
    apiKey = encrypt(rawKey);
  }

  if (existing) {
    db.run('UPDATE ai_models SET name = ?, model_key = ?, provider = ?, api_endpoint = ?, api_key = ?, max_tokens = ?, temperature = ?, is_default = ?, is_enabled = ? WHERE id = ?',
      [name, modelKey, provider, apiEndpoint, apiKey, maxTokens, temperature, isDefault, enabled, existing.id]);
  } else {
    db.run('INSERT INTO ai_models (name, model_key, provider, api_endpoint, api_key, is_enabled, is_default, user_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)',
      [name, modelKey, provider, apiEndpoint, apiKey, enabled, isDefault]);
  }
  if (isDefault) {
    db.run('UPDATE ai_models SET is_default = 0 WHERE user_id IS NULL AND model_key != ?', [modelKey]);
    upsertSettings(db, { ai_default_model: modelKey }); // 清 settings 缓存，前台立即生效
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_model', target_title: name, detail: `保存 AI 聊天模型：${name}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/models/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, name FROM ai_models WHERE id = ? AND user_id IS NULL', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  db.run('DELETE FROM ai_models WHERE id = ?', [row.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_model', target_title: row.name, detail: `删除 AI 聊天模型：${row.name}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/models/test', isAuthenticated, hasPermission('aichat.manage'), async (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT * FROM ai_models WHERE id = ? AND user_id IS NULL', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  try {
    const { content } = await callChatCompletion({
      name: row.name, provider: row.provider, model_key: row.model_key,
      api_endpoint: row.api_endpoint, api_key: row.api_key ? (row.api_key.indexOf('ENC:') === 0 ? require('../../config/crypto-secure').decrypt(row.api_key) : row.api_key) : null,
      max_tokens: Math.min(toInt(row.max_tokens, 4096), 256),
      temperature: 0.3
    }, [{ role: 'user', content: '你好，请只回复"连接成功"四个字' }], { stream: false });
    res.json({ success: true, data: { reply: String(content || '').slice(0, 200) } });
  } catch (err) {
    res.status(400).json({ error: normalizeError(err) });
  }
});

// ============ 官方角色管理 ============

router.post('/ai-chat/roles/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const name = (first(req.body.name) || '').trim().slice(0, 50);
  const category = (first(req.body.category) || 'default').trim().slice(0, 50);
  const description = (first(req.body.description) || '').trim().slice(0, 200);
  const systemPrompt = (first(req.body.system_prompt) || '').trim().slice(0, 4000);
  const greeting = (first(req.body.greeting) || '').trim().slice(0, 1000);
  const personality = (first(req.body.personality) || '').trim().slice(0, 2000);
  const scenario = (first(req.body.scenario) || '').trim().slice(0, 2000);
  const examples = (first(req.body.examples) || '').trim().slice(0, 4000);
  if (!name) return res.status(400).json({ error: '角色名称不能为空' });
  if (!systemPrompt && !greeting) return res.status(400).json({ error: '角色设定或开场白至少填写一项' });
  // 官方角色去重：与其他官方角色同名（大小写不敏感，排除自身）时拒绝
  const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [name, id]);
  if (dup) return res.status(400).json({ error: '同名官方角色「' + dup.name + '」已存在，请换一个名称' });

  const existing = id ? queryOne(db, 'SELECT id FROM ai_roles WHERE id = ? AND is_official = 1', [id]) : null;
  if (existing) {
    db.run('UPDATE ai_roles SET name = ?, category = ?, description = ?, system_prompt = ?, greeting = ?, personality = ?, scenario = ?, examples = ? WHERE id = ?',
      [name, category, description, systemPrompt, greeting, personality, scenario, examples, existing.id]);
  } else {
    db.run('INSERT INTO ai_roles (name, description, system_prompt, greeting, personality, scenario, examples, category, is_official, user_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0)',
      [name, description, systemPrompt, greeting, personality, scenario, examples, category]);
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_role', target_title: name, detail: `保存 AI 聊天角色：${name}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/roles/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, name FROM ai_roles WHERE id = ? AND is_official = 1', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  db.run('DELETE FROM ai_roles WHERE id = ?', [row.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_role', target_title: row.name, detail: `删除 AI 聊天角色：${row.name}`, ip: req.ip });
  res.json({ success: true });
});

// ============ 默认世界书（全局模板，新会话自动复制） ============

const DEFAULT_WORLD_BOOK_POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top'];

router.post('/ai-chat/world-book-defaults/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const key = (first(req.body.key) || '').trim().slice(0, 200);
  let content = (first(req.body.content) || '').trim().slice(0, 8000);
  const position = DEFAULT_WORLD_BOOK_POSITIONS.indexOf(first(req.body.position)) !== -1 ? first(req.body.position) : 'before_char';
  const sortOrder = Math.max(toInt(first(req.body.sort_order), 0), 0);
  const enabled = first(req.body.enabled) === '0' ? 0 : 1;
  const constant = first(req.body.constant) === '1' || first(req.body.constant) === 'on' ? 1 : 0;
  if (id) {
    const existing = queryOne(db, 'SELECT * FROM ai_default_world_book WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: '条目不存在' });
    if (!content) content = existing.content; // 编辑/启停时内容留空保留原文
    db.run('UPDATE ai_default_world_book SET key = ?, content = ?, position = ?, sort_order = ?, enabled = ?, constant = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [key, content, position, sortOrder, enabled, constant, id]);
  } else {
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    db.run('INSERT INTO ai_default_world_book (key, content, position, sort_order, enabled, constant) VALUES (?, ?, ?, ?, ?, ?)',
      [key, content, position, sortOrder, enabled, constant]);
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'ai_default_world_book', target_title: key || '（常驻）', detail: `保存默认世界书条目：${key || '（常驻）'}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/world-book-defaults/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, key FROM ai_default_world_book WHERE id = ?', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '条目不存在' });
  db.run('DELETE FROM ai_default_world_book WHERE id = ?', [row.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_default_world_book', target_title: row.key || '（常驻）', detail: `删除默认世界书条目：${row.key || '（常驻）'}`, ip: req.ip });
  res.json({ success: true });
});

// ============ 系统设置 ============

router.post('/ai-chat/settings/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  const embeddingKey = first(req.body.ai_embedding_api_key);
  let encEmbeddingKey = settings.ai_embedding_api_key || '';
  if (embeddingKey && embeddingKey.indexOf('ENC:') !== 0) {
    encEmbeddingKey = encrypt(embeddingKey);
  }

  upsertSettings(db, {
    ai_enabled: first(req.body.ai_enabled) === '1' || first(req.body.ai_enabled) === 'on' ? '1' : '0',
    ai_default_model: (first(req.body.ai_default_model) || '').trim().slice(0, 100),
    ai_allow_user_models: first(req.body.ai_allow_user_models) === '1' || first(req.body.ai_allow_user_models) === 'on' ? '1' : '0',
    ai_default_daily_limit: String(Math.max(toInt(first(req.body.ai_default_daily_limit), 50), 0)),
    ai_default_total_limit: String(Math.max(toInt(first(req.body.ai_default_total_limit), 1000), 0)),
    ai_rag_enabled: first(req.body.ai_rag_enabled) === '1' || first(req.body.ai_rag_enabled) === 'on' ? '1' : '0',
    ai_rag_max_results: String(Math.min(Math.max(toInt(first(req.body.ai_rag_max_results), 5), 1), 20)),
    ai_rag_min_score: String(Math.min(Math.max(parseFloat(first(req.body.ai_rag_min_score)) || 0.3, 0), 1)),
    ai_memory_enabled: first(req.body.ai_memory_enabled) === '1' || first(req.body.ai_memory_enabled) === 'on' ? '1' : '0',
    ai_memory_mode: ['summary', 'vector', 'both', 'off'].indexOf(first(req.body.ai_memory_mode)) !== -1 ? first(req.body.ai_memory_mode) : 'summary',
    ai_memory_interval: String(Math.max(toInt(first(req.body.ai_memory_interval), 10), 2)),
    ai_embedding_api_base: (first(req.body.ai_embedding_api_base) || '').trim().slice(0, 300),
    ai_embedding_model: (first(req.body.ai_embedding_model) || '').trim().slice(0, 100),
    ai_embedding_api_key: encEmbeddingKey,
    ai_stream_enabled: first(req.body.ai_stream_enabled) === '1' || first(req.body.ai_stream_enabled) === 'on' ? '1' : '0'
  });
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_settings', target_title: 'AI聊天设置', detail: '更新 AI 聊天系统设置', ip: req.ip });
  res.json({ success: true });
});

// ============ 知识库（RAG） ============

// 上传限制：txt/md ≤ 2MB，每用户每小时 10 次（后台管理无需限流）
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.txt' && ext !== '.md') return cb(new Error('仅支持 .txt / .md 文件'));
    cb(null, true);
  }
});

router.post('/ai-chat/knowledge/upload', isAuthenticated, hasPermission('aichat.manage'), knowledgeUpload.single('file'), async (req, res) => {
  const db = req.db;
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const title = (req.body.title || req.file.originalname || '未命名文档').slice(0, 200);
  const content = req.file.buffer.toString('utf8').slice(0, 500000);
  if (!content.trim()) return res.status(400).json({ error: '文件内容为空' });

  db.run('INSERT INTO ai_knowledge_docs (title, content, source_type, source_id, created_by) VALUES (?, ?, ?, ?, ?)',
    [title, content, 'manual', '', req.session.user.id]);
  const doc = queryOne(db, 'SELECT * FROM ai_knowledge_docs WHERE id = last_insert_rowid()');

  const embCfg = resolveEmbeddings(db);
  const chunkCount = embCfg ? await embedDocument(db, doc, embCfg) : 0;

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'ai_knowledge', target_title: title, detail: `上传知识库文档：${title}（${chunkCount} 分块）`, ip: req.ip });
  res.json({ success: true, data: { chunkCount, embedded: Boolean(embCfg) } });
});

router.post('/ai-chat/knowledge/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, title FROM ai_knowledge_docs WHERE id = ?', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '文档不存在' });
  db.run('DELETE FROM ai_knowledge_docs WHERE id = ?', [row.id]); // 级联删除分块
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_knowledge', target_title: row.title, detail: `删除知识库文档：${row.title}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/knowledge/reembed', isAuthenticated, hasPermission('aichat.manage'), async (req, res) => {
  const db = req.db;
  const doc = queryOne(db, 'SELECT * FROM ai_knowledge_docs WHERE id = ?', [toInt(first(req.body.id), 0)]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  const embCfg = resolveEmbeddings(db);
  if (!embCfg) return res.status(400).json({ error: '未配置嵌入模型，无法重新嵌入' });
  const chunkCount = await embedDocument(db, doc, embCfg);
  saveDatabase();
  res.json({ success: true, data: { chunkCount } });
});

// ============ 配额管理 ============

router.get('/ai-chat/quota', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const rows = queryAll(db, `
    SELECT q.*, u.username, u.nickname, u.role
    FROM ai_quota q LEFT JOIN users u ON q.user_id = u.id
    ORDER BY q.daily_used DESC, q.id DESC LIMIT 200`);
  res.json({ success: true, data: rows });
});

router.post('/ai-chat/quota/update', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const userId = toInt(first(req.body.user_id), 0);
  if (!userId) return res.status(400).json({ error: '参数错误' });
  const row = queryOne(db, 'SELECT * FROM ai_quota WHERE user_id = ?', [userId]);
  if (!row) return res.status(404).json({ error: '用户配额不存在' });
  db.run('UPDATE ai_quota SET daily_limit = ?, total_limit = ? WHERE id = ?',
    [Math.max(toInt(first(req.body.daily_limit), row.daily_limit), 0),
      Math.max(toInt(first(req.body.total_limit), row.total_limit), 0), row.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_quota', target_title: '用户 #' + userId, detail: `调整 AI 聊天配额（用户 #${userId}）`, ip: req.ip });
  res.json({ success: true });
});

// ============ 统计 ============

router.get('/ai-chat/stats', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const convCount = queryOne(db, 'SELECT COUNT(*) AS c FROM ai_conversations');
  const msgCount = queryOne(db, 'SELECT COUNT(*) AS c FROM ai_messages');
  const userCount = queryOne(db, 'SELECT COUNT(DISTINCT user_id) AS c FROM ai_conversations');
  const todayConv = queryOne(db, "SELECT COUNT(*) AS c FROM ai_conversations WHERE date(created_at) = date('now')");
  const recent = queryAll(db, `
    SELECT c.id, c.title, c.message_count, c.created_at, u.username
    FROM ai_conversations c LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.id DESC LIMIT 20`);
  res.json({
    success: true,
    data: {
      convCount: convCount ? convCount.c : 0,
      msgCount: msgCount ? msgCount.c : 0,
      userCount: userCount ? userCount.c : 0,
      todayConv: todayConv ? todayConv.c : 0,
      recent
    }
  });
});

module.exports = router;
