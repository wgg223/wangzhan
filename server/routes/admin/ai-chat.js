/**
 * AI 聊天管理路由（后台，需 aichat.manage 权限）
 * 模块：
 *   - 总览页        GET  /admin/ai-chat                     （模型/官方角色/知识库/配额一览）
 *   - 模型管理      POST /admin/ai-chat/models/{save,delete,test}  （全局模型 CRUD + 连通性测试，Key 加密存储）
 *   - 角色管理      POST /admin/ai-chat/roles/{save,delete}         （官方角色 CRUD，system_prompt≤4000字）
 *   - 角色卡导入    POST /admin/ai-chat/roles/import                （PNG chara / JSON，支持多文件批量）
 *   - 角色卡导出    GET  /admin/ai-chat/roles/export[?id]           （单角色/全部，chara_card_v2 JSON）
 *                   GET  /admin/ai-chat/roles/export-png?id         （SillyTavern 兼容 PNG 角色卡）
 *   - 角色批量管理  POST /admin/ai-chat/roles/{batch-delete,duplicate,move,avatar}
 *   - 默认世界书    POST /admin/ai-chat/world-book-defaults/{save,delete,import} （全局模板；import 支持 lorebook JSON / Markdown 批量）
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
const fs = require('fs');
const router = express.Router();
const { isAuthenticated, hasPermission, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { encrypt } = require('../../config/crypto-secure');
const { getSettings, upsertSettings } = require('../../utils/settings');
const { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings, fetchModelList } = require('../../services/ai-chat/provider');
const { embedDocument, invalidateRagCache } = require('../../services/ai-chat/rag');
const { normalizeError } = require('../../services/ai-chat/utils');
const { parseWorldBook } = require('../../utils/world-book-parse');
const characterCards = require('../../services/ai-chat/characters');

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
  const roleCategories = Array.from(new Set(roles.map(r => r.category || 'default')));
  // 官方卡可能有上百张，页面只渲染摘要；完整正文按需通过 /ai-chat/roles/detail 拉取
  const rolesLean = roles.map(r => ({
    id: r.id,
    name: r.name,
    avatar: r.avatar || '',
    category: r.category || 'default',
    description: r.description || '',
    sort_order: r.sort_order || 0,
    creator: r.creator || '',
    character_version: r.character_version || '',
    license: r.license || '',
    source_type: r.source_type || 'official',
    is_shared: r.is_shared ? 1 : 0,
    import_count: r.import_count || 0,
    view_count: r.view_count || 0,
    book_entries: (() => {
      const b = characterCards.parseWorldBook(r);
      return b ? b.entries.length : 0;
    })(),
    alternate_count: characterCards.strArray(r.alternate_greetings, 2000, 5).length,
    excerpt: String(r.description || r.personality || r.system_prompt || '').slice(0, 140)
  }));
  const defaultWorldBook = queryAll(db, 'SELECT * FROM ai_default_world_book ORDER BY sort_order ASC, id ASC');
  const docs = queryAll(db, 'SELECT * FROM ai_knowledge_docs ORDER BY id DESC');
  const quotaRows = queryAll(db, `
    SELECT q.*, u.username, u.nickname, u.role
    FROM ai_quota q LEFT JOIN users u ON q.user_id = u.id
    ORDER BY q.id DESC LIMIT 100`);
  const presets = queryAll(db, 'SELECT * FROM ai_presets WHERE is_global = 1 ORDER BY is_default DESC, id ASC');
  const promptTemplates = queryAll(db, 'SELECT * FROM ai_prompt_templates WHERE is_global = 1 ORDER BY sort_order ASC, id ASC');
  const providers = queryAll(db, 'SELECT provider_key, name, api_base, default_model, models, api_key_url FROM ai_chat_providers ORDER BY sort_order ASC, id ASC');
  providers.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.requires_key = p.provider_key !== 'pollinations';
  });

  res.render('admin/ai-chat', {
    user: req.session.user,
    settings: res.locals.settings || {},
    aiSettings: settings,
    models,
    roles: rolesLean,
    roleCategories,
    defaultWorldBook,
    docs,
    quotaRows,
    presets,
    promptTemplates,
    providers,
    isSuperAdmin: req.session.user.role === 'super_admin',
    hasEmbeddings: Boolean(settings.ai_embedding_api_base && settings.ai_embedding_model),
    userPermissions: res.locals.userPermissions || []
  });
});

// 官方角色卡完整详情（编辑表单按需拉取，避免上百张卡把后台页面撑爆）
router.get('/ai-chat/roles/detail', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND is_official = 1', [toInt(req.query.id, 0)]);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  res.json({
    success: true,
    data: {
      id: row.id,
      name: row.name,
      category: row.category || 'default',
      description: row.description || '',
      system_prompt: row.system_prompt || '',
      post_history_instructions: row.post_history_instructions || '',
      greeting: row.greeting || '',
      alternate_greetings: characterCards.strArray(row.alternate_greetings, 2000, 5),
      personality: row.personality || '',
      scenario: row.scenario || '',
      examples: row.examples || '',
      creator_notes: row.creator_notes || '',
      creator: row.creator || '',
      character_version: row.character_version || '',
      tags: characterCards.strArray(row.tags, 30, 10),
      license: row.license || '',
      avatar: row.avatar || '',
      world_book: characterCards.parseWorldBook(row)
    }
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

// 获取模型列表（按端点 + Key 调 OpenAI 兼容 /models）
router.post('/ai-chat/api/models/fetch', isAuthenticated, hasPermission('aichat.manage'), async (req, res) => {
  const endpoint = String(req.body.api_endpoint || '').trim();
  const apiKey = String(req.body.api_key || '').trim();
  try {
    const list = await fetchModelList(endpoint, apiKey);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(400).json({ error: normalizeError(err) });
  }
});

// ============ 官方角色管理 ============

router.post('/ai-chat/roles/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  // 世界书：表单传 JSON 字符串，先解析再交给归一层（非法 JSON 直接报错，避免静默丢内容）
  let characterBook = null;
  const bookRaw = first(req.body.world_book);
  if (bookRaw) {
    try {
      characterBook = JSON.parse(bookRaw);
    } catch (e) {
      return res.status(400).json({ error: '世界书不是合法 JSON：' + e.message });
    }
  }
  // 全字段走角色卡服务归一（V2/V3 兼容 + 限额裁剪 + 世界书规范化）
  const norm = characterCards.parseRolePayload({
    name: first(req.body.name),
    description: first(req.body.description),
    personality: first(req.body.personality),
    scenario: first(req.body.scenario),
    greeting: first(req.body.greeting),
    alternate_greetings: req.body.alternate_greetings,
    system_prompt: first(req.body.system_prompt),
    post_history_instructions: first(req.body.post_history_instructions),
    examples: first(req.body.examples),
    creator_notes: first(req.body.creator_notes),
    creator: first(req.body.creator),
    character_version: first(req.body.character_version),
    tags: req.body.tags,
    character_book: characterBook,
    avatar: first(req.body.avatar),
    category: first(req.body.category)
  });
  if (!norm) return res.status(400).json({ error: '角色名称不能为空，且设定/开场白至少填写一项' });
  const name = norm.name;
  const category = norm.category || 'default';
  // 官方角色去重：与其他官方角色同名（大小写不敏感，排除自身）时拒绝
  const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [name, id]);
  if (dup) return res.status(400).json({ error: '同名官方角色「' + dup.name + '」已存在，请换一个名称' });

  const cols = characterCards.cardToColumns(norm);
  const existing = id ? queryOne(db, 'SELECT id FROM ai_roles WHERE id = ? AND is_official = 1', [id]) : null;
  if (existing) {
    const keys = Object.keys(cols);
    db.run(`UPDATE ai_roles SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      keys.map(k => cols[k]).concat([existing.id]));
  } else {
    const payload = Object.assign({}, cols, {
      is_official: 1, user_id: null, sort_order: 0, source_type: 'official'
    });
    const columns = Object.keys(payload);
    db.run(`INSERT INTO ai_roles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(c => payload[c]));
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_role', target_title: name, detail: `保存 AI 聊天角色：${name}（分类 ${category}）`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/roles/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, name FROM ai_roles WHERE id = ? AND is_official = 1', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [row.id]);
  db.run('DELETE FROM ai_roles WHERE id = ?', [row.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_role', target_id: row.id, target_title: row.name, detail: `删除 AI 聊天角色：${row.name}`, ip: req.ip });
  res.json({ success: true });
});

// ============ 角色卡导入 / 导出 / 批量管理 ============

// 角色卡文件解析 / PNG chara 提取 / 头像落盘 等助手已抽到共享服务，供后台与广场上传复用
const {
  PNG_SIG, rebuildPngWithChara, placeholderPng, saveRoleAvatarBuffer, parseCardFiles
} = require('../../services/ai-chat/card-import');

// 导出格式：chara_card_v2（含 character_book），与前台导出保持一致
function roleToCard(row) {
  return characterCards.roleToCard(row);
}

function sendAttachment(res, filename, mime) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', "attachment; filename=\"" + fallback + "\"; filename*=UTF-8''" + encodeURIComponent(filename));
}

// 导出 PNG 的底图：本地头像 PNG > data URL PNG > 占位图（不 fetch 远程 URL，防 SSRF）
function loadRolePngBase(row) {
  const av = String(row.avatar || '');
  const publicDir = path.join(__dirname, '../../../public');
  if (av.indexOf('/uploads/') === 0) {
    const p = path.resolve(publicDir, '.' + av);
    if (p.startsWith(publicDir + path.sep) && fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      if (buf.subarray(0, 8).equals(PNG_SIG)) return buf;
    }
  } else if (av.indexOf('data:image/png;base64,') === 0) {
    const buf = Buffer.from(av.slice('data:image/png;base64,'.length), 'base64');
    if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return buf;
  }
  return placeholderPng();
}

const roleImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.json' && ext !== '.png') return cb(new Error('仅支持 .json / .png 角色卡'));
    cb(null, true);
  }
});

router.post('/ai-chat/roles/import', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  roleImportUpload.array('files', 20)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const db = req.db;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '请选择角色卡文件' });
    // 解析交给共享服务（PNG chara / JSON 数组 / 头像落盘），本路由只负责官方卡落库与去重
    const parsed = parseCardFiles(files);
    const errors = parsed.errors;
    const existingNames = new Set(queryAll(db, 'SELECT name FROM ai_roles WHERE is_official = 1').map(r => r.name.toLowerCase()));
    let imported = 0;
    let skipped = 0;
    parsed.items.forEach(item => {
      const norm = item.norm;
      if (existingNames.has(norm.name.toLowerCase())) { skipped++; return; }
      existingNames.add(norm.name.toLowerCase());
      // 完整落库：V2/V3 全字段 + 内嵌世界书（character_book）随卡保存，
      // 前台建会话时会弹窗让用户勾选注入（详见 /ai-chat/api/conversations/book-apply）
      const cols = characterCards.cardToColumns(norm);
      const payload = Object.assign({}, cols, {
        is_official: 1, user_id: null, sort_order: 0,
        source_type: 'official', source_url: '', license: ''
      });
      const columns = Object.keys(payload);
      db.run(`INSERT INTO ai_roles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(c => payload[c]));
      imported++;
    });
    saveDatabase();
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'ai_role', target_title: '批量导入', detail: `导入角色卡：成功 ${imported}，跳过 ${skipped}`, ip: req.ip });
    res.json({ success: true, data: { imported, skipped, errors } });
  });
});

router.get('/ai-chat/roles/export', isAuthenticated, hasPermission('aichat.export'), (req, res) => {
  const db = req.db;
  const id = toInt(req.query.id, 0);
  if (id) {
    const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND is_official = 1', [id]);
    if (!row) return res.status(404).json({ error: '角色不存在' });
    sendAttachment(res, (row.name || 'character') + '.json', 'application/json');
    return res.send(JSON.stringify(roleToCard(row), null, 2));
  }
  const rows = queryAll(db, 'SELECT * FROM ai_roles WHERE is_official = 1 ORDER BY sort_order ASC, id ASC');
  sendAttachment(res, 'ai-roles-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
  res.send(JSON.stringify(rows.map(roleToCard), null, 2));
});

router.get('/ai-chat/roles/export-png', isAuthenticated, hasPermission('aichat.export'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND is_official = 1', [toInt(req.query.id, 0)]);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  const png = rebuildPngWithChara(loadRolePngBase(row), JSON.stringify(roleToCard(row)));
  sendAttachment(res, (row.name || 'character') + '.png', 'image/png');
  res.send(png);
});

router.post('/ai-chat/roles/batch-delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const raw = Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || '').split(',');
  const ids = raw.map(v => toInt(v, 0)).filter(v => v > 0);
  if (!ids.length) return res.status(400).json({ error: '请选择要删除的角色' });
  const rows = queryAll(db, 'SELECT id, name FROM ai_roles WHERE is_official = 1 AND id IN (' + ids.map(() => '?').join(',') + ')', ids);
  rows.forEach(r => db.run('DELETE FROM ai_roles WHERE id = ?', [r.id]));
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'ai_role', target_title: '批量删除', detail: `批量删除角色 ${rows.length} 个：${rows.map(r => r.name).join('、')}`, ip: req.ip });
  res.json({ success: true, data: { deleted: rows.length } });
});

router.post('/ai-chat/roles/duplicate', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND is_official = 1', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  let name = row.name + '（副本）';
  let n = 2;
  while (queryOne(db, 'SELECT id FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1', [name])) {
    name = row.name + '（副本' + n + '）';
    n++;
  }
  db.run('INSERT INTO ai_roles (name, description, system_prompt, greeting, personality, scenario, examples, category, avatar, is_official, user_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)',
    [name, row.description, row.system_prompt, row.greeting, row.personality, row.scenario, row.examples, row.category, row.avatar, row.sort_order]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'ai_role', target_title: name, detail: `复制角色：${row.name} → ${name}`, ip: req.ip });
  res.json({ success: true, data: { name } });
});

router.post('/ai-chat/roles/move', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const dir = first(req.body.dir) === 'up' ? -1 : 1;
  const rows = queryAll(db, 'SELECT id FROM ai_roles WHERE is_official = 1 ORDER BY sort_order ASC, id ASC');
  const idx = rows.findIndex(r => r.id === id);
  const target = idx + dir;
  if (idx === -1 || target < 0 || target >= rows.length) return res.json({ success: true });
  const tmp = rows[idx];
  rows[idx] = rows[target];
  rows[target] = tmp;
  rows.forEach((r, i) => db.run('UPDATE ai_roles SET sort_order = ? WHERE id = ?', [i, r.id]));
  saveDatabase();
  res.json({ success: true });
});

const roleAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].indexOf(ext) === -1) return cb(new Error('仅支持 png / jpg / webp 图片'));
    cb(null, true);
  }
});

router.post('/ai-chat/roles/avatar', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  roleAvatarUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '请选择图片' });
    const url = saveRoleAvatarBuffer(req.file.buffer);
    if (!url) return res.status(400).json({ error: '图片格式无效' });
    res.json({ success: true, data: { url } });
  });
});

// ============ 默认世界书（全局模板，新会话自动复制） ============

const DEFAULT_WORLD_BOOK_POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'in_chat'];

router.post('/ai-chat/world-book-defaults/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const key = (first(req.body.key) || '').trim().slice(0, 200);
  let content = (first(req.body.content) || '').trim().slice(0, 8000);
  const position = DEFAULT_WORLD_BOOK_POSITIONS.indexOf(first(req.body.position)) !== -1 ? first(req.body.position) : 'before_char';
  const sortOrder = Math.max(toInt(first(req.body.sort_order), 0), 0);
  const enabled = first(req.body.enabled) === '0' ? 0 : 1;
  const constant = first(req.body.constant) === '1' || first(req.body.constant) === 'on' ? 1 : 0;
  const secondaryKeys = (first(req.body.secondary_keys) || '').trim().slice(0, 300);
  const selective = first(req.body.selective) === '1' || first(req.body.selective) === 'on' ? 1 : 0;
  const probability = Math.min(Math.max(toInt(first(req.body.probability), 100), 0), 100);
  const depth = Math.min(Math.max(toInt(first(req.body.depth), 4), 0), 200);
  if (id) {
    const existing = queryOne(db, 'SELECT * FROM ai_default_world_book WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: '条目不存在' });
    if (!content) content = existing.content; // 编辑/启停时内容留空保留原文
    db.run(`UPDATE ai_default_world_book SET key = ?, content = ?, position = ?, sort_order = ?, enabled = ?, constant = ?,
      secondary_keys = ?, selective = ?, probability = ?, depth = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [key, content, position, sortOrder, enabled, constant, secondaryKeys, selective, probability, depth, id]);
  } else {
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    db.run(`INSERT INTO ai_default_world_book (key, content, position, sort_order, enabled, constant,
        secondary_keys, selective, probability, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, content, position, sortOrder, enabled, constant, secondaryKeys, selective, probability, depth]);
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

// ---- 默认世界书批量操作（勾选后统一处理） ----

// 批量删除
router.post('/ai-chat/world-book-defaults/batch-delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要删除的条目' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, key FROM ai_default_world_book WHERE id IN (${ph})`, ids);
  rows.forEach(r => db.run('DELETE FROM ai_default_world_book WHERE id = ?', [r.id]));
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-delete', target_type: 'ai_default_world_book', target_id: r.id, target_title: r.key || '（常驻）', detail: `批量删除默认世界书条目（本批 ${rows.length} 条）：${r.key || '（常驻）'}`, ip: req.ip }));
  res.json({ success: true, message: `已删除 ${rows.length} 条`, data: { deleted: rows.length } });
});

// 批量启用 / 停用
router.post('/ai-chat/world-book-defaults/batch-enabled', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的条目' });
  const enabled = String(first(req.body.enabled)) === '0' ? 0 : 1;
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, key FROM ai_default_world_book WHERE id IN (${ph})`, ids);
  rows.forEach(r => db.run('UPDATE ai_default_world_book SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [enabled, r.id]));
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: enabled ? 'batch-enable' : 'batch-disable', target_type: 'ai_default_world_book', target_id: r.id, target_title: r.key || '（常驻）', detail: `批量${enabled ? '启用' : '停用'}默认世界书条目（本批 ${rows.length} 条）：${r.key || '（常驻）'}`, ip: req.ip }));
  res.json({ success: true, message: `已${enabled ? '启用' : '停用'} ${rows.length} 条`, data: { updated: rows.length, enabled } });
});

// 批量常驻 / 取消常驻（常驻 = 无需触发词始终注入）
router.post('/ai-chat/world-book-defaults/batch-constant', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的条目' });
  const constant = String(first(req.body.constant)) === '1' || String(first(req.body.constant)) === 'on' ? 1 : 0;
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, key FROM ai_default_world_book WHERE id IN (${ph})`, ids);
  rows.forEach(r => db.run('UPDATE ai_default_world_book SET constant = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [constant, r.id]));
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-constant', target_type: 'ai_default_world_book', target_id: r.id, target_title: r.key || '（常驻）', detail: `批量${constant ? '设为常驻' : '取消常驻'}默认世界书条目（本批 ${rows.length} 条）：${r.key || '（常驻）'}`, ip: req.ip }));
  res.json({ success: true, message: `已${constant ? '设为常驻' : '取消常驻'} ${rows.length} 条`, data: { updated: rows.length, constant } });
});

// 批量修改注入位置
router.post('/ai-chat/world-book-defaults/batch-position', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的条目' });
  const raw = first(req.body.position);
  const position = DEFAULT_WORLD_BOOK_POSITIONS.indexOf(raw) !== -1 ? raw : '';
  if (!position) return res.status(400).json({ error: '无效的注入位置' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, key FROM ai_default_world_book WHERE id IN (${ph})`, ids);
  rows.forEach(r => db.run('UPDATE ai_default_world_book SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [position, r.id]));
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-position', target_type: 'ai_default_world_book', target_id: r.id, target_title: r.key || '（常驻）', detail: `批量修改默认世界书注入位置为 ${position}（本批 ${rows.length} 条）：${r.key || '（常驻）'}`, ip: req.ip }));
  res.json({ success: true, message: `已修改 ${rows.length} 条位置`, data: { updated: rows.length, position } });
});

// 默认世界书文件导入（SillyTavern lorebook JSON / Markdown，支持多文件批量，按 key 去重）
const worldBookImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.json' && ext !== '.md' && ext !== '.markdown') return cb(new Error('仅支持 .json / .md 世界书文件'));
    cb(null, true);
  }
});

router.post('/ai-chat/world-book-defaults/import', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  worldBookImportUpload.array('files', 20)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const db = req.db;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '请选择世界书文件' });
    const existing = new Set(queryAll(db, 'SELECT key FROM ai_default_world_book').map(r => String(r.key).trim().toLowerCase()));
    let imported = 0;
    let skipped = 0;
    const errors = [];
    files.forEach(file => {
      const fname = file.originalname || 'file';
      let entries = [];
      try { entries = parseWorldBook(file.buffer, fname); } catch (e) { errors.push(fname + '：解析失败（' + e.message + '）'); return; }
      if (!entries.length) { errors.push(fname + '：未找到可导入的条目'); return; }
      entries.forEach((e, i) => {
        const key = String(e.key || '').trim().slice(0, 200);
        const content = String(e.content || '').trim().slice(0, 8000);
        if (!content || (key && existing.has(key.toLowerCase()))) { skipped++; return; }
        const position = DEFAULT_WORLD_BOOK_POSITIONS.indexOf(e.position) !== -1 ? e.position : 'before_char';
        const enabled = e.enabled === 0 ? 0 : 1;
        const constant = e.constant === 1 ? 1 : 0;
        const sortOrder = parseInt(e.sort_order, 10) || i;
        const secondaryKeys = String(e.secondary_keys || '').trim().slice(0, 300);
        const selective = e.selective === 1 ? 1 : 0;
        const probability = Math.min(Math.max(parseInt(e.probability, 10) || 100, 0), 100);
        const depth = Math.min(Math.max(parseInt(e.depth, 10) || 4, 0), 200);
        db.run(`INSERT INTO ai_default_world_book (key, content, position, sort_order, enabled, constant,
            secondary_keys, selective, probability, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [key, content, position, sortOrder, enabled, constant, secondaryKeys, selective, probability, depth]);
        if (key) existing.add(key.toLowerCase());
        imported++;
      });
    });
    saveDatabase();
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'ai_default_world_book', target_title: '批量导入', detail: `导入默认世界书：成功 ${imported}，跳过 ${skipped}`, ip: req.ip });
    res.json({ success: true, data: { imported, skipped, errors } });
  });
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
    ai_memory_keep_recent: String(Math.min(Math.max(toInt(first(req.body.ai_memory_keep_recent), 10), 1), 100)),
    ai_memory_recall_min_score: String(Math.min(Math.max(parseFloat(first(req.body.ai_memory_recall_min_score)) || 0.48, 0), 1)),
    ai_memory_recall_max: String(Math.min(Math.max(toInt(first(req.body.ai_memory_recall_max), 10), 1), 50)),
    ai_memory_group_recent: String(Math.min(Math.max(toInt(first(req.body.ai_memory_group_recent), 25), 0), 500)),
    ai_memory_group_size: String(Math.min(Math.max(toInt(first(req.body.ai_memory_group_size), 5), 1), 50)),
    ai_embedding_api_base: (first(req.body.ai_embedding_api_base) || '').trim().slice(0, 300),
    ai_embedding_model: (first(req.body.ai_embedding_model) || '').trim().slice(0, 100),
    ai_embedding_api_key: encEmbeddingKey,
    ai_stream_enabled: first(req.body.ai_stream_enabled) === '1' || first(req.body.ai_stream_enabled) === 'on' ? '1' : '0',
    // 世界书增强（SillyTavern 式）
    ai_world_recursion: first(req.body.ai_world_recursion) === '1' || first(req.body.ai_world_recursion) === 'on' ? '1' : '0',
    ai_world_recursion_steps: String(Math.min(Math.max(toInt(first(req.body.ai_world_recursion_steps), 4), 1), 10)),
    ai_world_budget_percent: String(Math.min(Math.max(toInt(first(req.body.ai_world_budget_percent), 25), 0), 100)),
    ai_world_scan_depth: String(Math.min(Math.max(toInt(first(req.body.ai_world_scan_depth), 6), 1), 50)),
    // 上下文预算与抗截断续写
    ai_context_size: String(Math.min(Math.max(toInt(first(req.body.ai_context_size), 16000), 2000), 1000000)),
    ai_history_window: String(Math.min(Math.max(toInt(first(req.body.ai_history_window), 3000), 500), 200000)),
    ai_auto_continue: first(req.body.ai_auto_continue) === '1' || first(req.body.ai_auto_continue) === 'on' ? '1' : '0',
    ai_auto_continue_max: String(Math.min(Math.max(toInt(first(req.body.ai_auto_continue_max), 3), 0), 5)),
    ai_reasoning_enabled: first(req.body.ai_reasoning_enabled) === '1' || first(req.body.ai_reasoning_enabled) === 'on' ? '1' : '0',
    // 预测建议回复
    ai_predict_enabled: first(req.body.ai_predict_enabled) === '1' || first(req.body.ai_predict_enabled) === 'on' ? '1' : '0',
    ai_predict_count: String(Math.min(Math.max(toInt(first(req.body.ai_predict_count), 3), 1), 5))
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
  invalidateRagCache(); // 分块向量缓存失效
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

// ============ 全局生成参数预设 ============

router.post('/ai-chat/presets/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const name = (first(req.body.name) || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: '预设名称不能为空' });
  const temperature = Math.min(Math.max(parseFloat(first(req.body.temperature)) || 0.7, 0), 2);
  const topP = Math.min(Math.max(parseFloat(first(req.body.top_p)) || 1, 0), 1);
  const topK = Math.max(toInt(first(req.body.top_k), 0), 0);
  const freqPen = Math.min(Math.max(parseFloat(first(req.body.frequency_penalty)) || 0, -2), 2);
  const presPen = Math.min(Math.max(parseFloat(first(req.body.presence_penalty)) || 0, -2), 2);
  const maxTokens = Math.min(Math.max(toInt(first(req.body.max_tokens), 4096), 256), 32768);
  const isDefault = first(req.body.is_default) === '1' || first(req.body.is_default) === 'on' ? 1 : 0;
  if (id) {
    const existing = queryOne(db, 'SELECT id FROM ai_presets WHERE id = ? AND is_global = 1', [id]);
    if (!existing) return res.status(404).json({ error: '预设不存在' });
    db.run('UPDATE ai_presets SET name=?, temperature=?, top_p=?, top_k=?, frequency_penalty=?, presence_penalty=?, max_tokens=?, is_default=? WHERE id=?',
      [name, temperature, topP, topK, freqPen, presPen, maxTokens, isDefault, id]);
  } else {
    db.run('INSERT INTO ai_presets (user_id, name, temperature, top_p, top_k, frequency_penalty, presence_penalty, max_tokens, is_default, is_global) VALUES (NULL,?,?,?,?,?,?,?,?,1)',
      [name, temperature, topP, topK, freqPen, presPen, maxTokens, isDefault]);
  }
  if (isDefault) db.run('UPDATE ai_presets SET is_default = 0 WHERE is_global = 1 AND name != ?', [name]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_preset', target_title: name, detail: `保存全局预设：${name}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/presets/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, name FROM ai_presets WHERE id = ? AND is_global = 1', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '预设不存在' });
  db.run('DELETE FROM ai_presets WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 全局提示词模板 ============

router.post('/ai-chat/prompt-templates/save', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const name = (first(req.body.name) || '').trim().slice(0, 100);
  const content = (first(req.body.content) || '').trim().slice(0, 8000);
  const description = (first(req.body.description) || '').trim().slice(0, 200);
  if (!name || !content) return res.status(400).json({ error: '名称和内容不能为空' });
  if (id) {
    const existing = queryOne(db, 'SELECT id FROM ai_prompt_templates WHERE id = ? AND is_global = 1', [id]);
    if (!existing) return res.status(404).json({ error: '模板不存在' });
    db.run('UPDATE ai_prompt_templates SET name=?, content=?, description=? WHERE id=?', [name, content, description, id]);
  } else {
    db.run('INSERT INTO ai_prompt_templates (user_id, name, content, description, is_global) VALUES (NULL,?,?,?,1)', [name, content, description]);
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'ai_prompt_template', target_title: name, detail: `保存提示词模板：${name}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/ai-chat/prompt-templates/delete', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id, name FROM ai_prompt_templates WHERE id = ? AND is_global = 1', [toInt(first(req.body.id), 0)]);
  if (!row) return res.status(404).json({ error: '模板不存在' });
  db.run('DELETE FROM ai_prompt_templates WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 全站角色卡查询与治理（仅超级管理员） ============
// 需求：超管可查询所有用户创建/导入/分享的角色卡；普通用户未分享时只能看到自己的卡。
// 治理动作（强制下架、重置分享链接、提升为官方卡、强制删除）全部写审计日志。

function requireSuperAdminJson(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'super_admin') return next();
  return res.status(403).json({ error: '仅超级管理员可访问全站角色卡数据' });
}

// 列表视图列（不含长文本正文，详情接口才给全文）
const ALL_ROLE_LIST_COLUMNS = `r.id, r.name, r.avatar, r.description, r.category, r.tags, r.creator,
  r.character_version, r.license, r.is_official, r.is_shared, r.source_type, r.source_role_id, r.share_token,
  r.import_count, r.view_count, r.user_id, r.shared_at, r.created_at, r.updated_at,
  LENGTH(r.system_prompt) AS system_prompt_length, LENGTH(r.world_book) AS world_book_length,
  u.username AS owner_name, u.email AS owner_email, u.role AS owner_role`;

/**
 * 全站角色卡列表
 * query: q user_id source_type(self|external|hub|official) shared(0|1) official(0|1) sort page per_page
 */
router.get('/ai-chat/roles/all', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const where = [];
  const params = [];
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    where.push('(r.name LIKE ? OR r.description LIKE ? OR r.creator LIKE ? OR r.tags LIKE ? OR u.username LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const userId = toInt(req.query.user_id, 0);
  if (userId) { where.push('r.user_id = ?'); params.push(userId); }
  const sourceType = String(req.query.source_type || '').trim();
  if (characterCards.SOURCE_TYPES.indexOf(sourceType) !== -1) { where.push('r.source_type = ?'); params.push(sourceType); }
  if (req.query.shared === '1') where.push('r.is_shared = 1');
  else if (req.query.shared === '0') where.push('r.is_shared = 0');
  if (req.query.official === '1') where.push('r.is_official = 1');
  else if (req.query.official === '0') where.push('r.is_official = 0');
  const category = String(req.query.category || '').trim().slice(0, 40);
  if (category) { where.push('r.category = ?'); params.push(category); }
  // 屏蔽状态筛选（治理面板专用：广场对被屏蔽卡仅上传者可见）
  if (req.query.blocked === '1') where.push('b.id IS NOT NULL');
  else if (req.query.blocked === '0') where.push('b.id IS NULL');

  const sortMap = {
    new: 'r.created_at DESC, r.id DESC',
    updated: 'r.updated_at DESC, r.id DESC',
    hot: 'r.import_count DESC, r.view_count DESC, r.id DESC',
    name: 'r.name ASC, r.id ASC',
    owner: 'r.user_id ASC, r.id ASC'
  };
  const orderBy = sortMap[String(req.query.sort || 'updated')] || sortMap.updated;
  const page = Math.max(toInt(req.query.page, 1), 1);
  const perPage = Math.min(Math.max(toInt(req.query.per_page, 24), 1), 100);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = 'FROM ai_roles r LEFT JOIN users u ON u.id = r.user_id ' +
    'LEFT JOIN ai_role_blocks b ON b.role_id = r.id ' + whereSql;

  const totalRow = queryOne(db, `SELECT COUNT(*) AS c ${fromSql}`, params);
  const rows = queryAll(db, `SELECT ${ALL_ROLE_LIST_COLUMNS},
      CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS is_blocked, COALESCE(b.reason, '') AS block_reason
    ${fromSql}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params.concat([perPage, (page - 1) * perPage]));

  res.json({
    success: true,
    data: {
      items: rows.map(r => Object.assign({}, r, {
        has_book: r.world_book_length > 0 ? 1 : 0,
        share_url: r.is_shared && r.share_token ? '/characters?card=' + r.share_token : ''
      })),
      page,
      per_page: perPage,
      total: totalRow ? totalRow.c : 0
    }
  });
});

// 全站角色卡统计（治理面板首屏）
router.get('/ai-chat/roles/all/stats', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const one = (sql, params) => { const r = queryOne(db, sql, params || []); return r ? r.c : 0; };
  res.json({
    success: true,
    data: {
      total: one('SELECT COUNT(*) AS c FROM ai_roles'),
      official: one('SELECT COUNT(*) AS c FROM ai_roles WHERE is_official = 1'),
      shared: one('SELECT COUNT(*) AS c FROM ai_roles WHERE is_shared = 1'),
      blocked: one('SELECT COUNT(*) AS c FROM ai_role_blocks'),
      by_source: characterCards.SOURCE_TYPES.map(t => ({
        source_type: t,
        count: one('SELECT COUNT(*) AS c FROM ai_roles WHERE source_type = ?', [t])
      })),
      with_book: one("SELECT COUNT(*) AS c FROM ai_roles WHERE world_book <> ''"),
      imports: one('SELECT COALESCE(SUM(import_count), 0) AS c FROM ai_roles'),
      views: one('SELECT COALESCE(SUM(view_count), 0) AS c FROM ai_roles'),
      top_shared: queryAll(db, `SELECT r.id, r.name, r.import_count, r.view_count, u.username AS owner_name
        FROM ai_roles r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.is_shared = 1 ORDER BY r.import_count DESC, r.view_count DESC LIMIT 10`),
      top_owners: queryAll(db, `SELECT u.id, u.username, COUNT(r.id) AS cards,
          SUM(r.is_shared) AS shared, SUM(r.import_count) AS imports
        FROM ai_roles r JOIN users u ON u.id = r.user_id
        GROUP BY u.id, u.username ORDER BY cards DESC LIMIT 10`)
    }
  });
});

// 全站角色卡详情（含全文与世界书；仅超管）
router.get('/ai-chat/roles/all/detail', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const row = queryOne(db, `SELECT r.*, u.username AS owner_name, u.email AS owner_email
    FROM ai_roles r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`, [toInt(req.query.id, 0)]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  const view = characterCards.ownerCardView(row);
  view.owner_name = row.owner_name || '';
  view.owner_email = row.owner_email || '';
  view.system_prompt_length = String(row.system_prompt || '').length;
  res.json({ success: true, data: view });
});

// 强制下架（取消分享并重置链接，已导入的副本不受影响）
router.post('/ai-chat/roles/all/unshare', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const row = queryOne(db, 'SELECT id, name, user_id FROM ai_roles WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  db.run("UPDATE ai_roles SET is_shared = 0, share_token = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'unshare', target_type: 'character_card', target_id: id, target_title: row.name, detail: `管理员强制下架角色卡：${row.name}（作者 user_id=${row.user_id || 0}）`, ip: req.ip });
  res.json({ success: true, message: '已下架，分享链接立即失效' });
});

// 提升/取消官方卡（官方卡对所有人可见，且可被后台统一治理）
router.post('/ai-chat/roles/all/promote', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const official = first(req.body.official) === '1' || req.body.official === true ? 1 : 0;
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  if (official) {
    const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [row.name, id]);
    if (dup) return res.status(400).json({ error: '同名官方角色「' + dup.name + '」已存在' });
    db.run("UPDATE ai_roles SET is_official = 1, source_type = 'official', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  } else {
    db.run("UPDATE ai_roles SET is_official = 0, source_type = 'self', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  }
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: official ? 'promote' : 'demote', target_type: 'character_card', target_id: id, target_title: row.name, detail: `${official ? '提升为官方角色卡' : '取消官方角色卡'}：${row.name}`, ip: req.ip });
  res.json({ success: true });
});

// 强制删除（同时解除所有会话对该卡的引用）
router.post('/ai-chat/roles/all/delete', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const row = queryOne(db, 'SELECT id, name, user_id FROM ai_roles WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  db.run('UPDATE ai_conversations SET role_id = NULL WHERE role_id = ?', [id]);
  db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [id]);
  db.run('DELETE FROM ai_roles WHERE id = ?', [id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'character_card', target_id: id, target_title: row.name, detail: `管理员强制删除角色卡：${row.name}（作者 user_id=${row.user_id || 0}）`, ip: req.ip });
  res.json({ success: true });
});

// ============ 批量管理（官方角色卡列表） ============

// 解析批量 id 列表（数组或逗号串），过滤非法值
function parseBatchIds(body) {
  const raw = Array.isArray(body.ids) ? body.ids : String(body.ids || '').split(',');
  return raw.map(v => toInt(v, 0)).filter(v => v > 0);
}

// 批量修改分类（官方角色卡列表勾选后统一归类）
router.post('/ai-chat/roles/batch-category', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的角色' });
  let category = String(req.body.category == null ? '' : req.body.category).trim().slice(0, 40);
  if (!category) category = 'default';
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name FROM ai_roles WHERE id IN (${ph})`, ids);
  rows.forEach(r => db.run('UPDATE ai_roles SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [category, r.id]));
  saveDatabase();
  // 逐条留痕：活动日志要求 target_id，批量操作按每个受影响角色各记一条
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-category', target_type: 'ai_role', target_id: r.id, target_title: r.name, detail: `批量修改分类为「${category}」（本批 ${rows.length} 个）：${r.name}`, ip: req.ip }));
  res.json({ success: true, data: { updated: rows.length, category } });
});

// 批量设置官方标记（0=取消官方降为自建，1=提升为官方；提升时跳过同名冲突）
router.post('/ai-chat/roles/batch-official', isAuthenticated, hasPermission('aichat.manage'), (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的角色' });
  const official = String(req.body.official) === '1' || req.body.official === true ? 1 : 0;
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name FROM ai_roles WHERE id IN (${ph})`, ids);
  let updated = 0; const skipped = []; const changed = [];
  rows.forEach(r => {
    if (official) {
      const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [r.name, r.id]);
      if (dup) { skipped.push(r.name); return; }
      db.run("UPDATE ai_roles SET is_official = 1, source_type = 'official', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    } else {
      db.run("UPDATE ai_roles SET is_official = 0, source_type = 'self', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    }
    updated++;
    changed.push(r);
  });
  saveDatabase();
  changed.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: official ? 'batch-promote' : 'batch-demote', target_type: 'ai_role', target_id: r.id, target_title: r.name, detail: `批量${official ? '提升为官方' : '取消官方'}（本批 ${updated} 个${skipped.length ? '，跳过同名 ' + skipped.join('、') : ''}）：${r.name}`, ip: req.ip }));
  res.json({ success: true, data: { updated, skipped } });
});

// ============ 批量管理（全站角色卡治理，仅超管） ============

// 批量强制下架分享
router.post('/ai-chat/roles/all/batch-unshare', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要下架的角色卡' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id FROM ai_roles WHERE id IN (${ph}) AND is_shared = 1`, ids);
  rows.forEach(r => db.run("UPDATE ai_roles SET is_shared = 0, share_token = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]));
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-unshare', target_type: 'character_card', target_id: r.id, target_title: r.name, detail: `管理员批量强制下架（本批 ${rows.length} 张，作者 user_id=${r.user_id || 0}）：${r.name}`, ip: req.ip }));
  res.json({ success: true, data: { updated: rows.length } });
});

// 批量提升/取消官方
router.post('/ai-chat/roles/all/batch-promote', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的角色卡' });
  const official = String(req.body.official) === '1' || req.body.official === true ? 1 : 0;
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name FROM ai_roles WHERE id IN (${ph})`, ids);
  let updated = 0; const skipped = []; const changed = [];
  rows.forEach(r => {
    if (official) {
      const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [r.name, r.id]);
      if (dup) { skipped.push(r.name); return; }
      db.run("UPDATE ai_roles SET is_official = 1, source_type = 'official', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    } else {
      db.run("UPDATE ai_roles SET is_official = 0, source_type = 'self', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    }
    updated++;
    changed.push(r);
  });
  saveDatabase();
  changed.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: official ? 'batch-promote' : 'batch-demote', target_type: 'character_card', target_id: r.id, target_title: r.name, detail: `批量${official ? '提升为官方' : '取消官方'}（本批 ${updated} 张${skipped.length ? '，跳过同名 ' + skipped.join('、') : ''}）：${r.name}`, ip: req.ip }));
  res.json({ success: true, data: { updated, skipped } });
});

// 批量强制删除（解除会话引用）
router.post('/ai-chat/roles/all/batch-delete', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要删除的角色卡' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id FROM ai_roles WHERE id IN (${ph})`, ids);
  rows.forEach(r => {
    db.run('UPDATE ai_conversations SET role_id = NULL WHERE role_id = ?', [r.id]);
    db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [r.id]);
    db.run('DELETE FROM ai_roles WHERE id = ?', [r.id]);
  });
  saveDatabase();
  rows.forEach(r => logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'batch-delete', target_type: 'character_card', target_id: r.id, target_title: r.name, detail: `管理员批量强制删除（本批 ${rows.length} 张，作者 user_id=${r.user_id || 0}）：${r.name}`, ip: req.ip }));
  res.json({ success: true, data: { deleted: rows.length } });
});

// 批量屏蔽 / 解除屏蔽（屏蔽后广场仅上传者本人可见，分享链接同时失效；已导入的副本不受影响）
router.post('/ai-chat/roles/all/batch-block', isAuthenticated, requireSuperAdminJson, (req, res) => {
  const db = req.db;
  const ids = parseBatchIds(req.body);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的角色卡' });
  const blocked = String(req.body.blocked) === '1' || req.body.blocked === true;
  const reason = String(req.body.reason == null ? '' : req.body.reason).trim().slice(0, 200);
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id FROM ai_roles WHERE id IN (${ph})`, ids);
  let changed = 0;
  rows.forEach(r => {
    const exists = queryOne(db, 'SELECT id FROM ai_role_blocks WHERE role_id = ?', [r.id]);
    if (blocked) {
      if (exists) return;
      db.run('INSERT INTO ai_role_blocks (role_id, reason, blocked_by) VALUES (?, ?, ?)', [r.id, reason, req.session.user.id]);
      // 屏蔽即断掉公开入口：取消分享并作废 token，旧链接立即失效
      db.run("UPDATE ai_roles SET is_shared = 0, share_token = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    } else {
      if (!exists) return;
      db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [r.id]);
    }
    changed++;
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: blocked ? 'block' : 'unblock', target_type: 'character_card',
      target_id: r.id, target_title: r.name,
      detail: `管理员批量${blocked ? '屏蔽（仅上传者可见）' : '解除屏蔽'}（本批 ${rows.length} 张，作者 user_id=${r.user_id || 0}）${reason ? '，原因：' + reason : ''}：${r.name}`,
      ip: req.ip
    });
  });
  saveDatabase();
  res.json({ success: true, message: blocked ? `已屏蔽 ${changed} 张卡（仅上传者可见）` : `已解除 ${changed} 张卡的屏蔽`, data: { changed, skipped: rows.length - changed } });
});

module.exports = router;
