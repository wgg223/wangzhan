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
const zlib = require('zlib');
const crypto = require('crypto');
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
    roles,
    roleCategories,
    defaultWorldBook,
    docs,
    quotaRows,
    presets,
    promptTemplates,
    providers,
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
  const name = (first(req.body.name) || '').trim().slice(0, 50);
  const category = (first(req.body.category) || 'default').trim().slice(0, 50);
  const description = (first(req.body.description) || '').trim().slice(0, 200);
  const systemPrompt = (first(req.body.system_prompt) || '').trim().slice(0, 4000);
  const greeting = (first(req.body.greeting) || '').trim().slice(0, 1000);
  const personality = (first(req.body.personality) || '').trim().slice(0, 2000);
  const scenario = (first(req.body.scenario) || '').trim().slice(0, 2000);
  const examples = (first(req.body.examples) || '').trim().slice(0, 4000);
  const avatar = (first(req.body.avatar) || '').trim().slice(0, 2000);
  if (!name) return res.status(400).json({ error: '角色名称不能为空' });
  if (!systemPrompt && !greeting) return res.status(400).json({ error: '角色设定或开场白至少填写一项' });
  // 官方角色去重：与其他官方角色同名（大小写不敏感，排除自身）时拒绝
  const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND is_official = 1 AND id != ?', [name, id]);
  if (dup) return res.status(400).json({ error: '同名官方角色「' + dup.name + '」已存在，请换一个名称' });

  const existing = id ? queryOne(db, 'SELECT id FROM ai_roles WHERE id = ? AND is_official = 1', [id]) : null;
  if (existing) {
    db.run('UPDATE ai_roles SET name = ?, category = ?, description = ?, system_prompt = ?, greeting = ?, personality = ?, scenario = ?, examples = ?, avatar = ? WHERE id = ?',
      [name, category, description, systemPrompt, greeting, personality, scenario, examples, avatar, existing.id]);
  } else {
    db.run('INSERT INTO ai_roles (name, description, system_prompt, greeting, personality, scenario, examples, category, avatar, is_official, user_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0)',
      [name, description, systemPrompt, greeting, personality, scenario, examples, category, avatar]);
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

// ============ 角色卡导入 / 导出 / 批量管理 ============

const ROLE_AVATAR_DIR = path.join(__dirname, '../../../public/uploads/avatars');
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// CRC32（PNG chunk 校验）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 从 PNG tEXt chunk 提取 chara 字段（base64 JSON，SillyTavern 角色卡标准）
function extractPngChara(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + len > buf.length) break;
    if (type === 'tEXt') {
      const data = buf.subarray(start, start + len);
      const idx = data.indexOf(0);
      if (idx > 0 && data.toString('latin1', 0, idx) === 'chara') {
        try { return Buffer.from(data.toString('latin1', idx + 1), 'base64').toString('utf8'); } catch (e) { return null; }
      }
    }
    offset = start + len + 4;
    if (type === 'IEND') break;
  }
  return null;
}

// 重建 PNG：移除旧 chara tEXt，在 IEND 前嵌入新 chara
function rebuildPngWithChara(buf, jsonStr) {
  const payload = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(Buffer.from(jsonStr, 'utf8').toString('base64'), 'latin1')
  ]);
  const chunk = pngChunk('tEXt', payload);
  const parts = [buf.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + len + 4;
    if (end > buf.length) break;
    const isChara = type === 'tEXt' && buf.toString('latin1', offset + 8, offset + 8 + Math.min(len, 6)) === 'chara\0';
    if (!isChara) {
      if (type === 'IEND' && !inserted) { parts.push(chunk); inserted = true; }
      parts.push(buf.subarray(offset, end));
    }
    offset = end;
  }
  if (!inserted) parts.push(chunk);
  return Buffer.concat(parts);
}

// 无头像时的占位 PNG（128x128 粉色纯色图）
let placeholderPngCache = null;
function placeholderPng() {
  if (placeholderPngCache) return placeholderPngCache;
  const w = 128, h = 128;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = 236; row[2 + x * 3] = 72; row[3 + x * 3] = 153; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  placeholderPngCache = Buffer.concat([
    PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))
  ]);
  return placeholderPngCache;
}

// 头像二进制落盘（校验 magic，防任意文件写入），返回 URL
function saveRoleAvatarBuffer(buf) {
  if (!buf || buf.length < 12 || buf.length > 5 * 1024 * 1024) return '';
  let ext = '';
  if (buf.subarray(0, 8).equals(PNG_SIG)) ext = '.png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = '.webp';
  else return '';
  if (!fs.existsSync(ROLE_AVATAR_DIR)) fs.mkdirSync(ROLE_AVATAR_DIR, { recursive: true });
  const fname = 'role-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
  fs.writeFileSync(path.join(ROLE_AVATAR_DIR, fname), buf);
  return '/uploads/avatars/' + fname;
}

// 导入头像解析：data URL 落盘；本地/远程 URL 直接保留；其余回退 fallback
function resolveImportAvatar(raw, fallback) {
  const v = String(raw || '').trim();
  if (v.indexOf('data:image/') === 0) {
    const m = v.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (m) {
      const url = saveRoleAvatarBuffer(Buffer.from(m[2], 'base64'));
      if (url) return url;
    }
    return fallback || '';
  }
  if (v && v.length <= 2000 && (v.indexOf('/') === 0 || v.indexOf('https://') === 0 || v.indexOf('http://') === 0)) return v;
  return fallback || '';
}

// 角色卡字段归一（兼容 SillyTavern v1/v2 与本项目格式，限额与 roles/save 一致）
function normalizeRoleCard(card, fileName) {
  const data = card && card.data ? card.data : card;
  if (!data || typeof data !== 'object') return null;
  const name = String(data.name || '').trim().slice(0, 50) ||
    String(fileName || '').replace(/\.(json|png)$/i, '').trim().slice(0, 50);
  const systemPrompt = String(data.system_prompt || data.system || data.personality || '').trim().slice(0, 4000);
  const greeting = String(data.first_mes || data.greeting || '').trim().slice(0, 1000);
  if (!name || (!systemPrompt && !greeting)) return null;
  const tags = Array.isArray(data.tags) && data.tags.length ? String(data.tags[0]).trim().slice(0, 50) : '';
  return {
    name,
    description: String(data.description || data.char_desc || '').trim().slice(0, 200),
    system_prompt: systemPrompt,
    greeting,
    personality: String(data.personality || '').trim().slice(0, 2000),
    scenario: String(data.scenario || '').trim().slice(0, 2000),
    examples: String(data.mes_example || data.examples || data.mesExample || '').trim().slice(0, 4000),
    category: String(data.category || tags || 'default').trim().slice(0, 50) || 'default',
    avatar: String(data.avatar || data.avatar_url || data.image || '').trim()
  };
}

// 导出格式（与前台 exportRole 一致，chara_card_v2）
function roleToCard(row) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: row.name,
      description: row.description || '',
      personality: row.personality || '',
      scenario: row.scenario || '',
      first_mes: row.greeting || '',
      mes_example: row.examples || '',
      system_prompt: row.system_prompt || '',
      avatar: row.avatar || '',
      category: row.category || 'default',
      tags: [row.category || 'default'],
      creator_notes: 'Exported from Website Admin',
      character_version: '1.0'
    }
  };
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
    const existingNames = new Set(queryAll(db, 'SELECT name FROM ai_roles WHERE is_official = 1').map(r => r.name.toLowerCase()));
    let imported = 0;
    let skipped = 0;
    const errors = [];
    files.forEach(file => {
      const fname = file.originalname || 'file';
      const ext = path.extname(fname).toLowerCase();
      let cards = [];
      let pngAvatarUrl = '';
      try {
        if (ext === '.png') {
          const json = extractPngChara(file.buffer);
          if (!json) { errors.push(fname + '：PNG 不含 chara 字段，不是角色卡'); return; }
          cards = [JSON.parse(json)];
          pngAvatarUrl = saveRoleAvatarBuffer(file.buffer);
        } else {
          const parsed = JSON.parse(file.buffer.toString('utf8'));
          if (Array.isArray(parsed)) cards = parsed;
          else if (parsed && Array.isArray(parsed.roles)) cards = parsed.roles;
          else if (parsed && Array.isArray(parsed.characters)) cards = parsed.characters;
          else cards = [parsed];
        }
      } catch (e) { errors.push(fname + '：解析失败（' + e.message + '）'); return; }
      cards.forEach(card => {
        const norm = normalizeRoleCard(card, fname);
        if (!norm) { skipped++; errors.push(fname + '：缺少名称或设定/开场白，跳过'); return; }
        if (existingNames.has(norm.name.toLowerCase())) { skipped++; return; }
        existingNames.add(norm.name.toLowerCase());
        const avatar = resolveImportAvatar(norm.avatar, pngAvatarUrl);
        db.run('INSERT INTO ai_roles (name, description, system_prompt, greeting, personality, scenario, examples, category, avatar, is_official, user_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0)',
          [norm.name, norm.description, norm.system_prompt, norm.greeting, norm.personality, norm.scenario, norm.examples, norm.category, avatar]);
        imported++;
      });
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

module.exports = router;
