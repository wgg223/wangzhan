/**
 * AI 生图管理路由（后台，需 imagegen.manage 权限）
 * 模块：
 *   - 总览页        GET  /admin/ai-image                     （服务商列表/每日限额/提示词优化配置/最近记录）
 *   - 服务商配置    POST /admin/ai-image/providers/{save,fetch-models}  （密钥加密存储；填新 Key 自动拉取模型列表）
 *   - 设置          POST /admin/ai-image/settings/save       （每日限额1-500/自动换服务商/提示词优化 LLM 配置）
 *   - 生成记录      GET  /admin/ai-image/records             （分页+按服务商/状态/用户筛选）
 *                  POST /admin/ai-image/records/delete       （删除记录+图片文件+关联分享；路径白名单校验防穿越）
 * 说明：API Key 一律 ENC: 前缀加密落库；删除文件前用 isSafeAiImagePath 校验
 *       必须位于 /uploads/ai-images/ 目录内，防路径穿越删除。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { encrypt } = require('../../config/crypto-secure');
const { getSettings, upsertSettings } = require('../../utils/settings');
const { fetchProviderModels, fetchProviderBalance, getProviderConfig, providers, getDefaultImageProviderKey, syncProviderModels, listTemplates, resolveAdapterKey } = require('../../services/image-gen');
const { UPLOAD_ROOT } = require('../../services/image-gen/utils');

// ============ AI 生图管理（服务商/密钥/限额/记录） ============

// 取数组字段首元素（防御重复表单字段）
function first(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

// 解析 models JSON 输入（接受 JSON 数组文本，逗号/换行分隔）
function parseModelsInput(value) {
  if (!value) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(String).filter(Boolean);
    }
  } catch (e) { /* fallthrough */ }
  return trimmed.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

// 校验删除文件路径是否在 ai-images 目录内（防路径穿越）
function isSafeAiImagePath(webPath) {
  if (typeof webPath !== 'string') return false;
  if (!webPath.startsWith('/uploads/ai-images/')) return false;
  const abs = path.normalize(path.join(UPLOAD_ROOT, '..', webPath.replace(/^\/uploads\/ai-images\//, '')));
  const root = path.normalize(UPLOAD_ROOT);
  return abs === root || abs.startsWith(root + path.sep);
}

// ============ 总览页 ============

router.get('/ai-image', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const providerRows = queryAll(db, 'SELECT * FROM ai_image_providers ORDER BY sort_order ASC, id ASC');
  providerRows.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.has_key = Boolean(p.api_key_enc && p.api_key_enc.indexOf('ENC:') === 0);
    // 注意：这里必须用适配器表（providers）判断能力，不能被同名数组变量遮蔽。
    const adapter = providers[p.provider_key];
    p.adapter_key = resolveAdapterKey(p.provider_key) || '';
    p.supports_verify = Boolean(adapter && typeof adapter.verify === 'function');
    p.supports_balance = Boolean(adapter && typeof adapter.fetchBalance === 'function');
    p.is_instance = p.provider_key.indexOf('__') !== -1;
    // 上次查询到的余额（保存 Key / 手动查询后落 settings，页面无需再打网关即可显示）
    try {
      const cachedBalance = settings['ai_image_balance_' + p.provider_key];
      p.last_balance = cachedBalance ? JSON.parse(cachedBalance) : null;
    } catch (e) {
      p.last_balance = null;
    }
  });

  const recentRows = queryAll(db, `
    SELECT r.*, u.username
    FROM ai_image_records r
    LEFT JOIN users u ON r.user_id = u.id
    ORDER BY r.id DESC LIMIT 20`);

  res.render('admin/ai-image', {
    user: req.session.user,
    settings: res.locals.settings || {},
    providers: providerRows,
    providerTemplates: listTemplates(),
    dailyLimit: parseInt(settings.ai_image_daily_limit, 10) || 20,
    fallbackEnabled: settings.ai_image_fallback !== '0',
    defaultProvider: getDefaultImageProviderKey(db),
    comfyuiWorkflow: settings.ai_image_comfyui_workflow || '',
    comfyuiNodeMap: settings.ai_image_comfyui_node_map || '',
    enhanceBase: settings.prompt_enhance_api_base || 'https://text.pollinations.ai/openai',
    enhanceModel: settings.prompt_enhance_model || 'openai',
    enhanceReferer: settings.prompt_enhance_referer || '',
    enhanceHasKey: Boolean(settings.prompt_enhance_api_key && settings.prompt_enhance_api_key.indexOf('ENC:') === 0),
    recentRows,
    userPermissions: res.locals.userPermissions || []
  });
});

// ============ 服务商配置 ============

router.post('/ai-image/providers/save', isAuthenticated, hasPermission('imagegen.manage'), async (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  const providerKey = (first(req.body.provider_key) || '').trim();
  if (!providerKey) return res.status(400).json({ error: '服务商标识不能为空' });

  const existing = queryOne(db, 'SELECT * FROM ai_image_providers WHERE id = ? OR provider_key = ?', [id || 0, providerKey]);
  if (!existing) return res.status(404).json({ error: '服务商不存在' });

  const name = (first(req.body.name) || existing.name || providerKey).trim();
  const apiBase = (first(req.body.api_base) || existing.api_base || '').trim();
  const apiPath = (first(req.body.api_path) || existing.api_path || '').trim();
  const apiKeyUrl = (first(req.body.api_key_url) || existing.api_key_url || '').trim();
  const defaultModel = (first(req.body.default_model) || existing.default_model || '').trim();
  const models = parseModelsInput(first(req.body.models));
  const enabled = first(req.body.enabled) === '1' || first(req.body.enabled) === 'on' ? 1 : 0;
  const supportsNegative = first(req.body.supports_negative) === '1' || first(req.body.supports_negative) === 'on' ? 1 : 0;
  const supportsN = first(req.body.supports_n) === '1' || first(req.body.supports_n) === 'on' ? 1 : 0;
  const supportsImg2img = first(req.body.supports_img2img) === '1' || first(req.body.supports_img2img) === 'on' ? 1 : 0;
  const sortOrder = toInt(first(req.body.sort_order), existing.sort_order || 0);
  const workflow = providerKey === 'comfyui' ? String(first(req.body.workflow) || '') : '';
  const nodeMap = providerKey === 'comfyui' ? String(first(req.body.node_map) || '') : '';

  if (providerKey === 'comfyui') {
    try {
      providers.comfyui.normalizeBaseUrl(apiBase);
      providers.comfyui.validateWorkflow(workflow, nodeMap);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'ComfyUI 配置无效' });
    }
  }

  // 密钥：填了才更新（加密存储），留空不修改；永不回显明文
  let apiKeyEnc = existing.api_key_enc || '';
  const apiKey = first(req.body.api_key);
  if (apiKey && apiKey.indexOf('ENC:') !== 0) {
    apiKeyEnc = encrypt(apiKey);
  }

  db.run(`UPDATE ai_image_providers SET
    name = ?, enabled = ?, api_key_enc = ?, api_base = ?, api_path = ?, api_key_url = ?,
    default_model = ?, models = ?, supports_negative = ?, supports_n = ?, supports_img2img = ?,
    sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
  [name, enabled, apiKeyEnc, apiBase, apiPath, apiKeyUrl, defaultModel,
    JSON.stringify(models), supportsNegative, supportsN, supportsImg2img, sortOrder, existing.id]);
  saveDatabase();
  if (providerKey === 'comfyui') {
    upsertSettings(db, {
      ai_image_comfyui_workflow: workflow,
      ai_image_comfyui_node_map: nodeMap
    });
  }

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update',
    target_type: 'ai_image_provider',
    target_id: existing.id,
    target_title: name,
    detail: `更新 AI 生图服务商：${name}`,
    ip: req.ip
  });

  // 填了新 Key 且适配器支持余额时，与模型同步并行查询，避免保存被两次网络往返拖慢
  const adapter = providers[providerKey];
  const balancePromise = (apiKey && apiKey.indexOf('ENC:') !== 0 && adapter && typeof adapter.fetchBalance === 'function')
    ? fetchProviderBalance(db, providerKey, null, 9000).catch(() => ({ ok: false, error: '余额查询失败' }))
    : null;

  // 填写了新 Key 且服务商支持模型列表接口 → 自动刷新模型
  let modelsFetched = false;
  let fetchError = '';
  let syncedModels = [];
  let syncedDefaultModel = defaultModel;
  if ((apiKey && apiKey.indexOf('ENC:') !== 0) || providerKey === 'comfyui') {
    try {
      const result = await fetchProviderModels(db, providerKey);
      if (result.ok) {
        const row = queryOne(db, 'SELECT models, default_model FROM ai_image_providers WHERE id = ?', [existing.id]);
        let currentModels = [];
        try { currentModels = JSON.parse(row.models || '[]'); } catch (e) { currentModels = []; }
        const synced = syncProviderModels(providerKey, currentModels, result.models, row.default_model || '');
        syncedModels = synced.models;
        syncedDefaultModel = synced.defaultModel;
        db.run('UPDATE ai_image_providers SET models = ?, default_model = ? WHERE id = ?',
          [JSON.stringify(syncedModels), syncedDefaultModel, existing.id]);
        saveDatabase();
        modelsFetched = true;
      } else {
        fetchError = result.error || '';
      }
    } catch (err) {
      fetchError = err.message || '';
    }
  }

  // 填了新 Key 时顺带查一次余额（与 TTAI 的“保存即显示余额”一致），失败只提示不阻断
  let balance = null;
  let balanceError = '';
  if (balancePromise) {
    const balanceResult = await balancePromise;
    if (balanceResult.ok) {
      balance = balanceResult.balance;
      rememberBalance(db, providerKey, balance);
    } else {
      balanceError = balanceResult.error || '';
    }
  }

  res.json({
    success: true,
    message: '服务商配置已保存',
    modelsFetched,
    models: syncedModels,
    default_model: syncedDefaultModel,
    fetchError: modelsFetched ? '' : fetchError,
    balance,
    balanceError
  });
});

// 手动获取模型列表
router.post('/ai-image/providers/fetch-models', isAuthenticated, hasPermission('imagegen.manage'), async (req, res) => {
  const db = req.db;
  const providerKey = (first(req.body.provider_key) || '').trim();
  const result = await fetchProviderModels(db, providerKey);
  if (result.ok) {
    const row = queryOne(db, 'SELECT models, default_model FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    let currentModels = [];
    try { currentModels = JSON.parse(row.models || '[]'); } catch (e) { currentModels = []; }
    const synced = syncProviderModels(providerKey, currentModels, result.models, row.default_model || '');
    return res.json({ success: true, models: synced.models, default_model: synced.defaultModel });
  }
  res.status(400).json({ success: false, error: result.error || '获取失败' });
});

// 验证服务商连接与配置（使用表单中的未保存值，便于先测试再保存）
router.post('/ai-image/providers/verify', isAuthenticated, hasPermission('imagegen.manage'), async (req, res) => {
  const providerKey = String(first(req.body.provider_key) || '');
  const cfg = getProviderConfig(req.db, providerKey);
  if (!cfg || !providers[providerKey] || typeof providers[providerKey].verify !== 'function') {
    return res.status(400).json({ success: false, error: '该服务商不支持连接验证' });
  }
  cfg.baseUrl = String(first(req.body.api_base) || cfg.api_base || cfg.baseUrl || '');
  cfg.apiKey = cfg.api_key || '';
  const unsavedKey = String(first(req.body.api_key) || '');
  if (unsavedKey && unsavedKey.indexOf('ENC:') !== 0) cfg.apiKey = unsavedKey;
  cfg.workflow = String(first(req.body.workflow) || '');
  cfg.nodeMap = String(first(req.body.node_map) || '');
  try {
    if (providerKey === 'comfyui') {
      providers.comfyui.normalizeBaseUrl(cfg.baseUrl);
      providers.comfyui.validateWorkflow(cfg.workflow, cfg.nodeMap);
    }
    const valid = await providers[providerKey].verify(cfg);
    if (!valid) {
      return res.status(400).json({ success: false, error: '连接验证未通过，请检查 API Key、服务地址和上传权限' });
    }
    return res.json({ success: true, message: '连接验证成功' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || '连接验证失败' });
  }
});

// ============ 设置（每日限额 / 自动换服务商 / 提示词优化 LLM） ============

router.post('/ai-image/settings/save', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const dailyLimit = Math.min(Math.max(toInt(first(req.body.ai_image_daily_limit), 20), 1), 500);
  const fallbackEnabled = first(req.body.ai_image_fallback) === '1' || first(req.body.ai_image_fallback) === 'on' ? '1' : '0';
  const requestedDefault = (first(req.body.ai_image_default_provider) || '').trim();
  const defaultProvider = requestedDefault && queryOne(req.db,
    'SELECT provider_key FROM ai_image_providers WHERE provider_key = ? AND enabled = 1', [requestedDefault])
    ? requestedDefault : getDefaultImageProviderKey(req.db);
  const enhanceBase = (first(req.body.prompt_enhance_api_base) || '').trim();
  const enhanceModel = (first(req.body.prompt_enhance_model) || '').trim();
  const enhanceReferer = (first(req.body.prompt_enhance_referer) || '').trim();
  const enhanceKey = first(req.body.prompt_enhance_api_key);

  const settingsMap = {
    ai_image_daily_limit: String(dailyLimit),
    ai_image_fallback: fallbackEnabled,
    ai_image_default_provider: defaultProvider || 'comfyui',
    prompt_enhance_api_base: enhanceBase,
    prompt_enhance_model: enhanceModel,
    prompt_enhance_referer: enhanceReferer
  };
  // 提示词优化 API Key：填了才加密更新，留空不修改
  if (enhanceKey && enhanceKey.indexOf('ENC:') !== 0) {
    settingsMap.prompt_enhance_api_key = encrypt(enhanceKey);
  }
  upsertSettings(db, settingsMap);

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: 'AI生图设置',
    detail: `更新 AI 生图设置：每日限额 ${dailyLimit}，自动换服务商 ${fallbackEnabled === '1' ? '开' : '关'}`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.xhr ||
      (req.headers['content-type'] || '').includes('application/json')) {
    return res.json({ success: true, message: '设置已保存' });
  }
  res.redirect('/admin/ai-image');
});

// ============ 生成记录 ============

// 记录列表（AJAX 分页 + 筛选）
router.get('/ai-image/records', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
  const offset = (page - 1) * pageSize;
  const where = [];
  const params = [];
  if (req.query.provider) {
    where.push('r.provider = ?');
    params.push(req.query.provider);
  }
  if (req.query.status) {
    where.push('r.status = ?');
    params.push(req.query.status);
  }
  if (req.query.user_id) {
    where.push('r.user_id = ?');
    params.push(parseInt(req.query.user_id, 10));
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const totalRows = queryAll(db, `SELECT COUNT(*) AS cnt FROM ai_image_records r ${whereSql}`, params);
  const total = (totalRows && totalRows[0] && totalRows[0].cnt) || 0;
  const records = queryAll(db, `
    SELECT r.*, u.username
    FROM ai_image_records r
    LEFT JOIN users u ON r.user_id = u.id
    ${whereSql}
    ORDER BY r.id DESC LIMIT ? OFFSET ?`,
  params.concat([pageSize, offset]));

  res.json({ success: true, data: { records, total, page, pageSize } });
});

// 删除记录（含图片文件，路径白名单校验）
router.post('/ai-image/records/delete', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const id = toInt(first(req.body.id), 0);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const record = queryOne(db, 'SELECT * FROM ai_image_records WHERE id = ?', [id]);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  if (record.image_path && isSafeAiImagePath(record.image_path)) {
    const abs = path.join(UPLOAD_ROOT, '..', record.image_path.replace(/^\/uploads\/ai-images\//, ''));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) { /* 文件删除失败不阻断记录删除 */ }
  }
  db.run('DELETE FROM ai_image_records WHERE id = ?', [id]);
  db.run("DELETE FROM image_shares WHERE source_type = 'ai_image' AND source_id = ?", [id]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'ai_image_record',
    target_id: id,
    target_title: (record.prompt || '').slice(0, 30),
    detail: `删除 AI 生图记录 #${id}`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.xhr ||
      (req.headers['content-type'] || '').includes('application/json')) {
    return res.json({ success: true, message: '记录已删除' });
  }
  res.redirect('/admin/ai-image');
});

// ============ 平台实例：新增 / 删除（多账号、国内国际节点、任意 OpenAI 兼容站点） ============

// 记录最近一次余额，落在 settings 里，供后台页面直接显示（避免每次打开页面都请求网关）
function rememberBalance(db, providerKey, balance) {
  if (!balance || !balance.label) return;
  upsertSettings(db, {
    ['ai_image_balance_' + providerKey]: JSON.stringify({
      label: balance.label,
      amount: balance.amount,
      used: balance.used,
      total: balance.total,
      currency: balance.currency || 'USD',
      at: new Date().toLocaleString('zh-CN', { hour12: false })
    })
  });
}

// 由显示名生成 provider_key 后缀；中文名生成空串时退回随机串，保证 key 唯一且可读。
function slugifyProviderKey(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || `p${crypto.randomBytes(3).toString('hex')}`;
}

// 新增平台实例：选协议模板 → 生成 `模板__后缀` 的 provider 行，前台下拉自动出现。
router.post('/ai-image/providers/create', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const templateKey = String(first(req.body.template) || '').trim();
  const template = listTemplates().find(t => t.key === templateKey);
  if (!template) return res.status(400).json({ error: '请选择平台协议模板' });

  const name = String(first(req.body.name) || template.label).trim().slice(0, 60);
  const apiBase = String(first(req.body.api_base) || template.apiBase || '').trim();
  const apiPath = String(first(req.body.api_path) || template.apiPath || '').trim();
  if (!apiBase && !apiPath) {
    return res.status(400).json({ error: '请填写站点 Base URL（例如 https://example.com/v1）' });
  }
  if (apiBase && !/^https?:\/\/[^\s]+$/i.test(apiBase)) {
    return res.status(400).json({ error: 'Base URL 必须是 http(s) 地址' });
  }

  const suffix = slugifyProviderKey(first(req.body.slug) || name);
  const providerKey = `${template.key}__${suffix}`;
  const exists = queryOne(db, 'SELECT id FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
  if (exists) return res.status(409).json({ error: `平台标识「${providerKey}」已存在，请换一个名称` });

  const models = parseModelsInput(first(req.body.models));
  const defaultModel = String(first(req.body.default_model) || template.defaultModel || models[0] || '').trim();
  const apiKey = String(first(req.body.api_key) || '').trim();
  const apiKeyUrl = String(first(req.body.api_key_url) || template.keyUrl || '').trim();
  const maxSort = queryOne(db, 'SELECT MAX(sort_order) AS m FROM ai_image_providers');
  const sortOrder = (maxSort && maxSort.m ? maxSort.m : 0) + 1;

  db.run(`INSERT INTO ai_image_providers
    (provider_key, name, enabled, api_key_enc, api_base, api_path, default_model, models, api_key_url,
     supports_negative, supports_n, supports_img2img, sort_order)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [providerKey, name, apiKey && apiKey.indexOf('ENC:') !== 0 ? encrypt(apiKey) : '',
    apiBase, apiPath, defaultModel, JSON.stringify(models.length ? models : template.models),
    apiKeyUrl, template.supportsNegative, template.supportsN, template.supportsImg2img, sortOrder]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'create',
    target_type: 'ai_image_provider',
    target_title: name,
    detail: `新增 AI 生图平台：${name}（${providerKey}，协议 ${template.adapter}）`,
    ip: req.ip
  });

  res.json({ success: true, message: '平台已新增，可在卡片里继续配置 Key 与模型', provider_key: providerKey });
});

// 删除平台实例：内置平台不可删除（避免误删系统默认配置），只能停用。
router.post('/ai-image/providers/delete', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const providerKey = String(first(req.body.provider_key) || '').trim();
  if (!providerKey) return res.status(400).json({ error: '参数错误' });
  if (providerKey.indexOf('__') === -1) {
    return res.status(400).json({ error: '内置平台不能删除，取消「启用」即可隐藏' });
  }
  const row = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
  if (!row) return res.status(404).json({ error: '平台不存在' });

  db.run('DELETE FROM ai_image_providers WHERE id = ?', [row.id]);
  db.run('DELETE FROM ai_image_user_keys WHERE provider_key = ?', [providerKey]);
  const settings = getSettings(db);
  if (settings.ai_image_default_provider === providerKey) {
    upsertSettings(db, { ai_image_default_provider: getDefaultImageProviderKey(db) || 'comfyui' });
  }
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'ai_image_provider',
    target_id: row.id,
    target_title: row.name,
    detail: `删除 AI 生图平台：${row.name}（${providerKey}）`,
    ip: req.ip
  });

  res.json({ success: true, message: '平台已删除' });
});

// 批量启用/停用站点：后台勾选多个服务商后一次提交
router.post('/ai-image/providers/batch-enabled', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const raw = req.body.provider_keys;
  let keys = [];
  if (Array.isArray(raw)) keys = raw.slice();
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      keys = Array.isArray(parsed) ? parsed : [raw];
    } catch (err) {
      keys = raw.split(',');
    }
  }
  keys = keys.map((key) => String(key || '').trim().slice(0, 100)).filter(Boolean);
  keys = Array.from(new Set(keys)).slice(0, 200);
  if (!keys.length) return res.status(400).json({ error: '请先选择要操作的站点' });

  const enabled = String(first(req.body.enabled) || '1') === '1' ? 1 : 0;
  const placeholders = keys.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT provider_key, name FROM ai_image_providers WHERE provider_key IN (${placeholders})`, keys);
  if (!rows.length) return res.status(404).json({ error: '所选站点不存在' });

  db.run(`UPDATE ai_image_providers SET enabled = ? WHERE provider_key IN (${placeholders})`, [enabled].concat(keys));
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: enabled ? 'enable' : 'disable',
    target_type: 'ai_image_provider',
    target_id: rows.map((row) => row.provider_key).join(',').slice(0, 200),
    target_title: enabled ? '批量启用站点' : '批量停用站点',
    detail: `${enabled ? '批量启用' : '批量停用'} AI 生图站点：${rows.map((row) => row.name).join('、')}`.slice(0, 500),
    ip: req.ip
  });

  res.json({
    success: true,
    updated: rows.length,
    enabled,
    provider_keys: rows.map((row) => row.provider_key),
    message: `已${enabled ? '启用' : '停用'} ${rows.length} 个站点`
  });
});

// 查询服务商余额：仅对适配器实现了 fetchBalance 的平台开放，查不到就明确提示。
router.post('/ai-image/providers/balance', isAuthenticated, hasPermission('imagegen.manage'), async (req, res) => {
  const db = req.db;
  const providerKey = String(first(req.body.provider_key) || '').trim();
  const adapter = providers[providerKey];
  if (!adapter) return res.status(404).json({ error: '平台不存在' });
  if (typeof adapter.fetchBalance !== 'function') {
    return res.status(400).json({ error: '该平台没有可用的余额查询接口' });
  }
  const result = await fetchProviderBalance(db, providerKey, null, 15000);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error || '余额查询失败' });
  if (!result.balance) return res.json({ success: false, error: '该站点未提供可查询的余额接口' });
  rememberBalance(db, providerKey, result.balance);
  res.json({ success: true, balance: result.balance });
});

module.exports = router;
