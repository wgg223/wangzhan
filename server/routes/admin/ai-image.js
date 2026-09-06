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
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { encrypt } = require('../../config/crypto-secure');
const { getSettings, upsertSettings } = require('../../utils/settings');
const { fetchProviderModels } = require('../../services/image-gen');
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
  const providers = queryAll(db, 'SELECT * FROM ai_image_providers ORDER BY sort_order ASC, id ASC');
  providers.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.has_key = Boolean(p.api_key_enc && p.api_key_enc.indexOf('ENC:') === 0);
  });

  const recentRows = queryAll(db, `
    SELECT r.*, u.username
    FROM ai_image_records r
    LEFT JOIN users u ON r.user_id = u.id
    ORDER BY r.id DESC LIMIT 20`);

  res.render('admin/ai-image', {
    user: req.session.user,
    settings: res.locals.settings || {},
    providers,
    dailyLimit: parseInt(settings.ai_image_daily_limit, 10) || 20,
    fallbackEnabled: settings.ai_image_fallback !== '0',
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

  // 填写了新 Key 且服务商支持模型列表接口 → 自动刷新模型
  let modelsFetched = false;
  let fetchError = '';
  if (apiKey && apiKey.indexOf('ENC:') !== 0) {
    try {
      const result = await fetchProviderModels(db, providerKey);
      if (result.ok) {
        db.run('UPDATE ai_image_providers SET models = ? WHERE id = ?', [JSON.stringify(result.models), existing.id]);
        const row = queryOne(db, 'SELECT default_model FROM ai_image_providers WHERE id = ?', [existing.id]);
        if (row && (!row.default_model || result.models.indexOf(row.default_model) === -1)) {
          db.run('UPDATE ai_image_providers SET default_model = ? WHERE id = ?', [result.models[0], existing.id]);
        }
        saveDatabase();
        modelsFetched = true;
      } else {
        fetchError = result.error || '';
      }
    } catch (err) {
      fetchError = err.message || '';
    }
  }

  res.json({
    success: true,
    message: '服务商配置已保存',
    modelsFetched,
    fetchError: modelsFetched ? '' : fetchError
  });
});

// 手动获取模型列表
router.post('/ai-image/providers/fetch-models', isAuthenticated, hasPermission('imagegen.manage'), async (req, res) => {
  const db = req.db;
  const providerKey = (first(req.body.provider_key) || '').trim();
  const result = await fetchProviderModels(db, providerKey);
  if (result.ok) {
    return res.json({ success: true, models: result.models });
  }
  res.status(400).json({ success: false, error: result.error || '获取失败' });
});

// ============ 设置（每日限额 / 自动换服务商 / 提示词优化 LLM） ============

router.post('/ai-image/settings/save', isAuthenticated, hasPermission('imagegen.manage'), (req, res) => {
  const db = req.db;
  const dailyLimit = Math.min(Math.max(toInt(first(req.body.ai_image_daily_limit), 20), 1), 500);
  const fallbackEnabled = first(req.body.ai_image_fallback) === '1' || first(req.body.ai_image_fallback) === 'on' ? '1' : '0';
  const enhanceBase = (first(req.body.prompt_enhance_api_base) || '').trim();
  const enhanceModel = (first(req.body.prompt_enhance_model) || '').trim();
  const enhanceReferer = (first(req.body.prompt_enhance_referer) || '').trim();
  const enhanceKey = first(req.body.prompt_enhance_api_key);

  const settingsMap = {
    ai_image_daily_limit: String(dailyLimit),
    ai_image_fallback: fallbackEnabled,
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

module.exports = router;
