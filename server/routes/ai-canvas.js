/**
 * AI 创作画布路由（独立通道）
 *
 * 与基础生图页（/ai-image）完全分离：
 *   - 页面：GET  /ai-canvas
 *   - 能力：/ai-canvas/api/*        （生成 / 状态 / 取消 / 历史 / Key / 提示词优化 / 上传）
 *   - 项目：/ai-canvas/api/projects* （服务端项目、版本、成员、分享）
 *   - 协作：/ai-canvas/api/projects/:id/{presence,version,state}
 *
 * 画布 API 能力与基础页对齐（服务商/模型/尺寸/数量/种子/风格/负向/参考图/取消），
 * 并额外支持：自定义宽高、多参考图（最多 4 张）、协作项目。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { isAuthenticated, hasFrontendPermission, isAdminRole } = require('../middlewares/auth');
const { logActivity } = require('../config/activity');
const { getSettings } = require('../utils/settings');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { validateMagicBytes } = require('../utils/file-validator');
const {
  countDailyUsage, checkImageTaskQuota, getUserProviderKeys, getProviderConfig, saveUserProviderKey,
  deleteUserProviderKey, verifyProviderKey, syncProviderModels, startImageTask, getImageTask,
  cancelImageTask, getDefaultImageProviderKey, isKeylessProvider, fetchProviderBalance, providers
} = require('../services/image-gen');
const { saveReferenceImage, normalizeError, MAX_IMAGE_SIZE } = require('../services/image-gen/utils');
const {
  SIZE_GROUPS, SIZE_PRESETS, RATIOS, QUALITY_TIERS, resolveSizeForProvider, normalizeCustomSize,
  sizeFromRatioQuality, ratioQualityMatrix
} = require('../services/image-gen/sizes');
const { enhancePrompt } = require('../services/prompt-enhance');

const MAX_REFERENCES = 4;
const ALLOWED_IMAGE_MIMES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/tiff'
];
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/heic': '.heic', 'image/tiff': '.tiff'
};
const CANVAS_UPLOAD_ROOT = path.join(__dirname, '../../public/uploads/canvas');

const canvasUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('图片仅支持 JPG/PNG/WebP/GIF/BMP/AVIF/HEIC/TIFF 格式'));
  }
});

const canvasLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `aicanvas:${req.session.user.id}`,
  message: '生成过于频繁，请稍后再试'
});

const STYLE_PRESETS = {
  photo: 'professional photography, photorealistic, 8k, sharp focus, natural lighting',
  illustration: 'digital illustration, vibrant colors, highly detailed',
  '3d': '3D render, octane render, cinematic lighting, depth of field',
  guofeng: 'traditional Chinese ink wash painting style, elegant, artistic',
  cyberpunk: 'cyberpunk style, neon lights, futuristic city, high contrast',
  watercolor: 'watercolor painting, soft colors, artistic, delicate',
  anime: 'anime style, beautiful detailed, vibrant, studio quality',
  pixel: 'pixel art, retro game style, 16-bit'
};

// ============ 公共工具 ============

function providerListForUser(db, userId) {
  const userKeySet = new Set(getUserProviderKeys(db, userId));
  const rows = queryAll(db, `SELECT provider_key, name, enabled, default_model, models, api_key_url,
    supports_negative, supports_n, supports_img2img, api_key_enc FROM ai_image_providers ORDER BY sort_order ASC, id ASC`);
  const list = rows.filter(p => p.enabled || userKeySet.has(p.provider_key));
  const defaultProvider = getDefaultImageProviderKey(db);
  if (defaultProvider) {
    list.sort((a, b) => Number(b.provider_key === defaultProvider) - Number(a.provider_key === defaultProvider));
  }
  return list.map(p => {
    let models = [];
    try { models = JSON.parse(p.models || '[]'); } catch (e) { models = []; }
    const adapter = providers[p.provider_key];
    return {
      provider_key: p.provider_key,
      name: p.name,
      default_model: p.default_model || '',
      models,
      api_key_url: p.api_key_url || '',
      supports_negative: Boolean(p.supports_negative),
      supports_n: Boolean(p.supports_n),
      supports_img2img: Boolean(p.supports_img2img),
      requires_key: !isKeylessProvider(p.provider_key),
      // 只暴露“有没有 Key / 能不能查余额”，绝不回显明文
      has_user_key: userKeySet.has(p.provider_key),
      has_global_key: Boolean(p.api_key_enc),
      supports_balance: Boolean(adapter && typeof adapter.fetchBalance === 'function'),
      supports_models: Boolean(adapter && typeof adapter.fetchModels === 'function')
    };
  });
}

function canvasBootstrap(db, userData) {
  const settings = getSettings(db);
  const projects = queryAll(db,
    `SELECT p.id, p.name, p.node_count, p.thumbnail, p.version, p.share_token, p.updated_at,
            (SELECT COUNT(*) FROM ai_canvas_members m WHERE m.project_id = p.id) AS member_count
     FROM ai_canvas_projects p
     WHERE p.user_id = ?
        OR p.id IN (SELECT project_id FROM ai_canvas_members WHERE user_id = ?)
     ORDER BY p.updated_at DESC LIMIT 30`, [userData.id, userData.id]);
  return {
    providers: providerListForUser(db, userData.id),
    dailyLimit: parseInt(settings.ai_image_daily_limit, 10) || 20,
    used: countDailyUsage(db, userData.id),
    unlimited: isAdminRole(userData),
    userKeys: getUserProviderKeys(db, userData.id),
    sizePresets: SIZE_PRESETS,
    sizeGroups: SIZE_GROUPS,
    ratios: RATIOS,
    qualities: QUALITY_TIERS,
    sizeMatrix: ratioQualityMatrix(),
    stylePresets: STYLE_PRESETS,
    projects: projects.map(p => ({
      id: p.id, name: p.name, nodeCount: p.node_count, thumbnail: p.thumbnail || '',
      version: p.version, shareToken: p.share_token || '', updatedAt: p.updated_at,
      memberCount: (p.member_count || 0) + 1
    })),
    limits: { maxReferences: MAX_REFERENCES, maxNodes: 500, minSide: 64, maxSide: 4096 },
    formats: ALLOWED_IMAGE_MIMES
  };
}

/**
 * 取项目并校验访问权限。
 * @returns {{project?: Object, role?: string, error?: string, status?: number}}
 */
function accessProject(db, projectId, userId) {
  const project = queryOne(db, 'SELECT * FROM ai_canvas_projects WHERE id = ?', [projectId]);
  if (!project) return { error: '项目不存在', status: 404 };
  if (project.user_id === userId) return { project, role: 'owner' };
  const member = queryOne(db, 'SELECT role FROM ai_canvas_members WHERE project_id = ? AND user_id = ?',
    [projectId, userId]);
  if (!member) return { error: '无权访问该画布', status: 403 };
  return { project, role: member.role === 'viewer' ? 'viewer' : 'editor' };
}

function canWrite(role) {
  return role === 'owner' || role === 'editor';
}

function projectSummary(row) {
  return {
    id: row.id,
    name: row.name,
    nodeCount: row.node_count,
    thumbnail: row.thumbnail || '',
    version: row.version,
    shareToken: row.share_token || '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || ''
  };
}

function touchPresence(db, projectId, userId, name) {
  db.run(`INSERT INTO ai_canvas_presence (project_id, user_id, name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(project_id, user_id) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`,
  [projectId, userId, name]);
}

// ============ 页面 ============

router.get('/', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const data = canvasBootstrap(db, user);
  const shareToken = String(req.query.share || '').trim();
  let activeProject = null;

  // 分享链接优先：命中则自动加入为只读成员，后续协作接口才有权限
  if (shareToken) {
    const shared = queryOne(db, "SELECT * FROM ai_canvas_projects WHERE share_token = ? AND share_token != ''", [shareToken]);
    if (shared) {
      if (shared.user_id !== user.id) {
        const member = queryOne(db, 'SELECT id FROM ai_canvas_members WHERE project_id = ? AND user_id = ?',
          [shared.id, user.id]);
        if (!member) {
          db.run("INSERT INTO ai_canvas_members (project_id, user_id, role) VALUES (?, ?, 'viewer')", [shared.id, user.id]);
          saveDatabase();
        }
      }
      activeProject = { ...shared, role: shared.user_id === user.id ? 'owner' : 'viewer' };
    }
  }

  const requestedId = parseInt(req.query.project, 10) || 0;
  if (!activeProject && requestedId) {
    const access = accessProject(db, requestedId, user.id);
    if (!access.error) activeProject = { ...access.project, role: access.role };
  }
  if (!activeProject && data.projects.length) {
    const first = accessProject(db, data.projects[0].id, user.id);
    if (!first.error) activeProject = { ...first.project, role: first.role };
  }

  let state = {};
  if (activeProject && activeProject.state_json) {
    try { state = JSON.parse(activeProject.state_json || '{}'); } catch (e) { state = {}; }
  }

  res.render('frontend/ai-canvas', {
    layout: false, // 双保险：即使布局中间件的路径判断失效，画布也必须是整页独立渲染
    user,
    settings: res.locals.settings || {},
    canvasData: data,
    shareToken: shareToken,
    activeProject: activeProject ? {
      id: activeProject.id,
      name: activeProject.name,
      version: activeProject.version,
      role: activeProject.role,
      state
    } : null
  });
});

// 引导数据（刷新服务商/模型/额度，不重载页面）
router.get('/api/bootstrap', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  res.json({ success: true, data: canvasBootstrap(req.db, req.session.user) });
});

// ============ 生成 ============

router.post('/api/generate', isAuthenticated, hasFrontendPermission('imagegen.use'), canvasLimiter,
  (req, res) => {
    canvasUpload.array('references', MAX_REFERENCES)(req, res, (uploadErr) => {
      if (uploadErr) {
        const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
          ? `参考图不能超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB`
          : (uploadErr.code === 'LIMIT_UNEXPECTED_FILE'
            ? `参考图最多 ${MAX_REFERENCES} 张`
            : (uploadErr.message || '参考图上传失败'));
        return res.status(400).json({ error: msg });
      }
      const db = req.db;
      const user = req.session.user;

      const prompt = String(req.body.prompt || '').trim();
      const negativePrompt = String(req.body.negative_prompt || '').trim();
      const providerKey = String(req.body.provider || '').trim();
      const model = typeof req.body.model === 'string' ? req.body.model.trim().slice(0, 300) : '';
      const rawN = parseInt(req.body.n, 10) || 1;
      const rawSeed = req.body.seed === '' || req.body.seed === undefined ? 0 : parseInt(req.body.seed, 10);
      const style = String(req.body.style || '').trim();
      const files = Array.isArray(req.files) ? req.files : [];

      if (!prompt) return res.status(400).json({ error: '提示词不能为空' });
      if (prompt.length > 4000) return res.status(400).json({ error: '提示词不能超过 4000 字' });
      if (negativePrompt.length > 1000) return res.status(400).json({ error: '负向提示词不能超过 1000 字' });
      if (Number.isNaN(rawSeed) || rawSeed < 0 || rawSeed > 4294967295) {
        return res.status(400).json({ error: '种子数超出范围（0-4294967295）' });
      }

      // 尺寸：自定义宽高 > 比例×画质（与 TTAI 插件一致）> 直接传 size
      let size = String(req.body.size || '').trim();
      if (req.body.width || req.body.height) {
        const custom = normalizeCustomSize(req.body.width, req.body.height);
        if (!custom) return res.status(400).json({ error: '自定义分辨率无效：宽高需在 64–4096 之间' });
        size = custom;
      } else if (req.body.ratio && req.body.quality) {
        const computed = sizeFromRatioQuality(req.body.ratio, req.body.quality);
        if (computed) size = computed;
      }
      if (!/^\d{1,4}[x*]\d{1,4}$/.test(size)) {
        return res.status(400).json({ error: '图片尺寸格式不正确' });
      }
      size = size.replace(/\*/g, 'x');

      const provider = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
      if (!provider) return res.status(400).json({ error: '所选服务商不存在' });
      const userKeyList = getUserProviderKeys(db, user.id);
      if (!provider.enabled && userKeyList.indexOf(providerKey) === -1) {
        return res.status(400).json({ error: '所选服务商未启用，请选择其他服务商' });
      }
      const providerConfig = getProviderConfig(db, providerKey, user.id);
      if (!isKeylessProvider(providerKey) && (!providerConfig || !providerConfig.api_key)) {
        return res.status(400).json({
          error: `所选服务商「${provider.name || providerKey}」未配置 API Key：请填写「我的 API Key」，或由管理员配置全局 Key`
        });
      }
      if (files.length && !provider.supports_img2img) {
        return res.status(400).json({ error: '当前服务商不支持图生图，请断开参考图连线或更换服务商' });
      }
      const n = provider.supports_n ? Math.min(Math.max(rawN, 1), 4) : 1;

      const quota = checkImageTaskQuota(db, {
        userId: user.id,
        n,
        referenceImagePaths: files.length ? files.map(() => true) : []
      });
      if (!quota.ok) {
        return res.status(429).json({ error: `今日生成次数已达上限（${quota.limit} 次），明天再来吧` });
      }

      const referencePaths = [];
      let referenceImageWebPath = '';
      for (const file of files.slice(0, MAX_REFERENCES)) {
        if (!validateMagicBytes(file.buffer, file.mimetype)) {
          return res.status(400).json({ error: `参考图「${file.originalname || ''}」校验失败，请更换图片` });
        }
        const webPath = saveReferenceImage(file.buffer);
        if (!referenceImageWebPath) referenceImageWebPath = webPath;
        referencePaths.push(path.join(__dirname, '../..', 'public', webPath));
      }

      const effective = resolveSizeForProvider(providerKey, size, model);
      try {
        const taskId = startImageTask(db, {
          userId: user.id,
          providerKey,
          model,
          prompt,
          negativePrompt,
          size,
          n,
          seed: rawSeed || 0,
          style,
          referenceImagePath: referencePaths[0] || null,
          referenceImagePaths: referencePaths,
          referenceImageWebPath
        });
        return res.json({
          success: true,
          taskId,
          size,
          effectiveSize: effective.size,
          sizeAdjusted: effective.adjusted,
          referencesUsed: referencePaths.length
        });
      } catch (err) {
        const status = err && err.status === 429 ? 429 : 500;
        return res.status(status).json({ error: '生成服务异常：' + (err.message || '未知错误') });
      }
    });
  });

router.get('/api/status', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const task = getImageTask(String(req.query.task || ''));
  if (!task || task.userId !== req.session.user.id) {
    return res.status(404).json({ success: false, error: '任务不存在或已过期' });
  }
  res.json({
    success: true,
    data: {
      status: task.status,
      message: task.message || '',
      elapsedMs: Date.now() - task.createdAt,
      result: task.result || null
    }
  });
});

router.post('/api/cancel', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const r = cancelImageTask(String((req.body && req.body.task) || ''), req.session.user.id);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  res.json({ success: true, message: r.message });
});

// ============ 历史 / Key / 提示词优化（与基础页能力对齐） ============

router.get('/api/history', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 12, 1), 50);
  const offset = (page - 1) * pageSize;
  const totalRows = queryAll(db, 'SELECT COUNT(*) AS cnt FROM ai_image_records WHERE user_id = ?', [userId]);
  const total = (totalRows && totalRows[0] && totalRows[0].cnt) || 0;
  const records = queryAll(db,
    'SELECT id, prompt, provider, model, size, status, image_path, error, created_at FROM ai_image_records WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    [userId, pageSize, offset]);
  res.json({ success: true, data: { records, total, page, pageSize } });
});

router.post('/api/keys/save', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 20, keyGenerator: r => `aicanvas-key:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
    const db = req.db;
    const userId = req.session.user.id;
    const providerKey = String(req.body.provider_key || '').trim();
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
    if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
    const provider = queryOne(db, 'SELECT provider_key FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!provider) return res.status(404).json({ error: '服务商不存在' });
    if (isKeylessProvider(providerKey)) return res.status(400).json({ error: '该服务商无需 API Key' });
    if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });
    if (apiKey.length > 300) return res.status(400).json({ error: 'API Key 长度超出限制' });
    if (apiKey.indexOf('ENC:') === 0) return res.status(400).json({ error: 'API Key 格式不正确' });

    saveUserProviderKey(db, userId, providerKey, apiKey);
    logActivity(db, {
      user_id: userId,
      username: req.session.user.username,
      action: 'update',
      target_type: 'ai_canvas_user_key',
      target_title: providerKey,
      detail: `画布保存服务商 Key：${providerKey}`,
      ip: req.ip
    });
    let verified = false;
    let models = [];
    let defaultModel = '';
    let balance = null;
    let balanceError = '';
    try {
      const verifyResult = await verifyProviderKey(db, providerKey, apiKey);
      verified = Boolean(verifyResult.verified);
      if (verifyResult.models && verifyResult.models.length) {
        const row = queryOne(db, 'SELECT models, default_model FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
        let current = [];
        try { current = JSON.parse((row && row.models) || '[]'); } catch (e) { current = []; }
        const synced = syncProviderModels(providerKey, current, verifyResult.models, (row && row.default_model) || '');
        models = synced.models;
        defaultModel = synced.defaultModel;
        if (row) {
          db.run('UPDATE ai_image_providers SET models = ?, default_model = ? WHERE provider_key = ?',
            [JSON.stringify(models), defaultModel, providerKey]);
          saveDatabase();
        }
      }
      const balanceResult = await fetchProviderBalance(db, providerKey, userId, 6000);
      if (balanceResult.ok) balance = balanceResult.balance;
      else balanceError = balanceResult.error || '';
    } catch (err) {
      balanceError = normalizeError(err);
    }
    res.json({ success: true, message: 'API Key 已保存', verified, models, default_model: defaultModel, balance, balanceError });
  });

router.post('/api/keys/delete', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const providerKey = String(req.body.provider_key || '').trim();
  if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
  deleteUserProviderKey(req.db, req.session.user.id, providerKey);
  res.json({ success: true, message: 'API Key 已清除' });
});

// 用当前用户 Key（或后台全局 Key）查询余额：画布「API 密钥」面板直接调用
router.post('/api/keys/balance', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 30, keyGenerator: r => `aicanvas-bal:${r.session.user.id}`, message: '查询过于频繁，请稍后再试' }),
  async (req, res) => {
    const providerKey = String(req.body.provider_key || '').trim();
    if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
    const row = queryOne(req.db, 'SELECT provider_key, name FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!row) return res.status(404).json({ error: '服务商不存在' });
    const result = await fetchProviderBalance(req.db, providerKey, req.session.user.id, 15000);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error || '余额查询失败' });
    if (!result.balance) return res.json({ success: false, error: '该服务商未提供余额查询接口' });
    res.json({ success: true, balance: result.balance });
  });

router.post('/api/enhance-prompt', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 10, keyGenerator: r => `aicanvas-enh:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请输入要优化的内容' });
    if (prompt.length > 500) return res.status(400).json({ error: '描述不能超过 500 字' });
    try {
      const { enhanced, source } = await enhancePrompt(req.db, prompt);
      res.json({ success: true, enhanced, source });
    } catch (err) {
      res.status(502).json({ error: normalizeError(err) });
    }
  });

// ============ 画布素材上传（协作项目里其他人也能看到） ============

router.post('/api/uploads', isAuthenticated, hasFrontendPermission('imagegen.use'),
  canvasUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择图片' });
    if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: '图片文件校验失败，请更换文件' });
    }
    const now = new Date();
    const dirName = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(CANVAS_UPLOAD_ROOT, dirName);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return res.status(500).json({ error: '上传目录创建失败' });
    }
    const ext = MIME_EXT[req.file.mimetype] || '.png';
    const filename = `canvas-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    try {
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
    } catch (err) {
      return res.status(500).json({ error: '图片保存失败' });
    }
    res.json({ success: true, url: `/uploads/canvas/${dirName}/${filename}`, size: req.file.size });
  });

// ============ 项目 ============

router.get('/api/projects', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const rows = queryAll(req.db,
    `SELECT p.*, (SELECT COUNT(*) FROM ai_canvas_members m WHERE m.project_id = p.id) AS member_count
     FROM ai_canvas_projects p
     WHERE p.user_id = ? OR p.id IN (SELECT project_id FROM ai_canvas_members WHERE user_id = ?)
     ORDER BY p.updated_at DESC LIMIT 50`, [req.session.user.id, req.session.user.id]);
  res.json({
    success: true,
    data: rows.map(row => ({
      ...projectSummary(row),
      memberCount: (row.member_count || 0) + 1,
      owner: row.user_id === req.session.user.id
    }))
  });
});

router.post('/api/projects', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const name = String(req.body.name || '未命名画布').trim().slice(0, 60) || '未命名画布';
  const state = req.body.state && typeof req.body.state === 'object' ? req.body.state : {};
  const nodeCount = Math.max(0, Math.min(parseInt(req.body.nodeCount, 10) || 0, 5000));
  db.run('INSERT INTO ai_canvas_projects (user_id, name, state_json, node_count) VALUES (?, ?, ?, ?)',
    [req.session.user.id, name, JSON.stringify(state), nodeCount]);
  const row = queryOne(db, 'SELECT * FROM ai_canvas_projects WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [req.session.user.id]);
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'create', target_type: 'ai_canvas_project', target_id: row.id, target_title: name,
    detail: `新建画布项目：${name}`, ip: req.ip
  });
  res.json({ success: true, data: projectSummary(row) });
});

router.get('/api/projects/:id', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const access = accessProject(req.db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  let state = {};
  try { state = JSON.parse(access.project.state_json || '{}'); } catch (e) { state = {}; }
  res.json({
    success: true,
    data: {
      ...projectSummary(access.project),
      state,
      role: access.role,
      ownerId: access.project.user_id
    }
  });
});

// 保存状态：乐观锁（baseVersion 与库中 version 不一致返回 409 + 最新状态）
router.put('/api/projects/:id', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!canWrite(access.role)) return res.status(403).json({ error: '只读成员不能编辑画布' });

  const baseVersion = parseInt(req.body.baseVersion, 10);
  if (Number.isFinite(baseVersion) && baseVersion !== access.project.version) {
    let latest = {};
    try { latest = JSON.parse(access.project.state_json || '{}'); } catch (e) { latest = {}; }
    return res.status(409).json({
      error: '画布已被其他人更新',
      data: { version: access.project.version, state: latest, updatedBy: access.project.updated_by || '' }
    });
  }
  const state = req.body.state && typeof req.body.state === 'object' ? req.body.state : {};
  const name = String(req.body.name || access.project.name).trim().slice(0, 60) || access.project.name;
  const nodeCount = Math.max(0, Math.min(parseInt(req.body.nodeCount, 10) || 0, 5000));
  const thumbnail = typeof req.body.thumbnail === 'string' ? req.body.thumbnail.slice(0, 400000) : access.project.thumbnail;
  db.run(`UPDATE ai_canvas_projects SET name = ?, state_json = ?, node_count = ?, thumbnail = ?,
    version = version + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  [name, JSON.stringify(state), nodeCount, thumbnail || '', req.session.user.username, access.project.id]);
  saveDatabase();
  const row = queryOne(db, 'SELECT * FROM ai_canvas_projects WHERE id = ?', [access.project.id]);
  res.json({ success: true, data: projectSummary(row) });
});

router.delete('/api/projects/:id', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.role !== 'owner') return res.status(403).json({ error: '只有创建者可以删除画布' });
  db.run('DELETE FROM ai_canvas_projects WHERE id = ?', [access.project.id]);
  db.run('DELETE FROM ai_canvas_members WHERE project_id = ?', [access.project.id]);
  db.run('DELETE FROM ai_canvas_presence WHERE project_id = ?', [access.project.id]);
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'delete', target_type: 'ai_canvas_project', target_id: access.project.id,
    target_title: access.project.name, detail: `删除画布项目：${access.project.name}`, ip: req.ip
  });
  res.json({ success: true, message: '画布已删除' });
});

// 分享链接：开启/关闭（只读加入）
router.post('/api/projects/:id/share', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!canWrite(access.role)) return res.status(403).json({ error: '只读成员不能分享画布' });
  const enabled = String(req.body.enabled) === '1' || req.body.enabled === true;
  const token = enabled ? (access.project.share_token || crypto.randomBytes(16).toString('hex')) : '';
  db.run('UPDATE ai_canvas_projects SET share_token = ? WHERE id = ?', [token, access.project.id]);
  saveDatabase();
  res.json({ success: true, shareToken: token, url: token ? `/ai-canvas?share=${token}` : '' });
});

// 通过分享链接加入（只读）
router.post('/api/projects/join', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const token = String(req.body.token || '').trim();
  const project = queryOne(db, "SELECT * FROM ai_canvas_projects WHERE share_token = ? AND share_token != ''", [token]);
  if (!project) return res.status(404).json({ error: '分享链接已失效' });
  if (project.user_id !== req.session.user.id) {
    const member = queryOne(db, 'SELECT id FROM ai_canvas_members WHERE project_id = ? AND user_id = ?',
      [project.id, req.session.user.id]);
    if (!member) {
      db.run("INSERT INTO ai_canvas_members (project_id, user_id, role) VALUES (?, ?, 'viewer')",
        [project.id, req.session.user.id]);
      saveDatabase();
    }
  }
  res.json({ success: true, data: { id: project.id, name: project.name } });
});

// ============ 成员 ============

router.get('/api/projects/:id/members', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const rows = queryAll(db,
    `SELECT m.user_id, m.role, m.created_at, u.username
     FROM ai_canvas_members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.project_id = ? ORDER BY m.id ASC`, [access.project.id]);
  const owner = queryOne(db, 'SELECT id AS user_id, username FROM users WHERE id = ?', [access.project.user_id]);
  res.json({
    success: true,
    data: [{
      user_id: owner ? owner.user_id : access.project.user_id,
      username: owner ? owner.username : '创建者',
      role: 'owner'
    }].concat(rows.map(r => ({ user_id: r.user_id, username: r.username || `#${r.user_id}`, role: r.role })))
  });
});

router.post('/api/projects/:id/members', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.role !== 'owner') return res.status(403).json({ error: '只有创建者可以邀请成员' });
  const username = String(req.body.username || '').trim().slice(0, 60);
  const role = req.body.role === 'viewer' ? 'viewer' : 'editor';
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  const target = queryOne(db, 'SELECT id, username FROM users WHERE username = ?', [username]);
  if (!target) return res.status(404).json({ error: `用户「${username}」不存在` });
  if (target.id === access.project.user_id) return res.status(400).json({ error: '创建者无需重复邀请' });
  const existing = queryOne(db, 'SELECT id FROM ai_canvas_members WHERE project_id = ? AND user_id = ?',
    [access.project.id, target.id]);
  if (existing) {
    db.run('UPDATE ai_canvas_members SET role = ? WHERE id = ?', [role, existing.id]);
  } else {
    db.run('INSERT INTO ai_canvas_members (project_id, user_id, role) VALUES (?, ?, ?)',
      [access.project.id, target.id, role]);
  }
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'update', target_type: 'ai_canvas_member', target_id: target.id, target_title: target.username,
    detail: `邀请 ${target.username} 协作画布「${access.project.name}」（${role}）`, ip: req.ip
  });
  res.json({ success: true, message: `已邀请 ${target.username}（${role === 'viewer' ? '只读' : '可编辑'}）` });
});

router.delete('/api/projects/:id/members/:userId', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const targetId = parseInt(req.params.userId, 10);
  if (access.role !== 'owner' && targetId !== req.session.user.id) {
    return res.status(403).json({ error: '只有创建者可以移除成员' });
  }
  db.run('DELETE FROM ai_canvas_members WHERE project_id = ? AND user_id = ?', [access.project.id, targetId]);
  db.run('DELETE FROM ai_canvas_presence WHERE project_id = ? AND user_id = ?', [access.project.id, targetId]);
  saveDatabase();
  res.json({ success: true, message: '已移除成员' });
});

// ============ 协作：在线状态 + 版本轮询 ============

router.post('/api/projects/:id/presence', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const projectId = parseInt(req.params.id, 10);
  const access = accessProject(db, projectId, req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  touchPresence(db, projectId, req.session.user.id, req.session.user.username);
  const x = Number.isFinite(Number(req.body.x)) ? Number(req.body.x) : 0;
  const y = Number.isFinite(Number(req.body.y)) ? Number(req.body.y) : 0;
  const selected = Array.isArray(req.body.selected) ? req.body.selected.slice(0, 20) : [];
  db.run('UPDATE ai_canvas_presence SET cursor_x = ?, cursor_y = ?, selected = ? WHERE project_id = ? AND user_id = ?',
    [x, y, JSON.stringify(selected), projectId, req.session.user.id]);
  db.run("DELETE FROM ai_canvas_presence WHERE project_id = ? AND updated_at < datetime('now', '-30 seconds')",
    [projectId]);
  res.json({ success: true });
});

router.get('/api/projects/:id/presence', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const projectId = parseInt(req.params.id, 10);
  const access = accessProject(db, projectId, req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const rows = queryAll(db,
    `SELECT user_id, name, cursor_x, cursor_y, selected, updated_at FROM ai_canvas_presence
     WHERE project_id = ? AND user_id != ? AND updated_at >= datetime('now', '-20 seconds')`,
    [projectId, req.session.user.id]);
  res.json({
    success: true,
    data: rows.map(r => ({
      userId: r.user_id,
      name: r.name || `#${r.user_id}`,
      x: Number(r.cursor_x) || 0,
      y: Number(r.cursor_y) || 0,
      selected: (function () { try { return JSON.parse(r.selected || '[]'); } catch (e) { return []; } })(),
      updatedAt: r.updated_at
    }))
  });
});

router.get('/api/projects/:id/version', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const access = accessProject(req.db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  res.json({
    success: true,
    data: {
      version: access.project.version,
      updatedAt: access.project.updated_at,
      updatedBy: access.project.updated_by || '',
      role: access.role
    }
  });
});

// 拉取最新状态（版本变了才返回完整 state，省流量）
router.get('/api/projects/:id/state', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const access = accessProject(db, parseInt(req.params.id, 10), req.session.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const since = parseInt(req.query.since, 10);
  if (Number.isFinite(since) && since === access.project.version) {
    return res.json({ success: true, data: { unchanged: true, version: access.project.version } });
  }
  let state = {};
  try { state = JSON.parse(access.project.state_json || '{}'); } catch (e) { state = {}; }
  res.json({
    success: true,
    data: {
      version: access.project.version,
      state,
      updatedBy: access.project.updated_by || '',
      role: access.role
    }
  });
});

module.exports = router;
