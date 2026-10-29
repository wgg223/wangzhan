/**
 * AI 图片生成路由模块
 * 覆盖：
 *   - AI 生图页面渲染；
 *   - 用户自填服务商 Key 管理（保存/删除/自动验证）；
 *   - 提示词优化；
 *   - 图片生成（异步任务 + 轮询 + 取消）；
 *   - 生成历史查询；
 *   - 生成结果分享到图片分享模块。
 * 从 frontend.js 拆分而出，保持原有代码风格与注释规范。
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { isAuthenticated, hasFrontendPermission, isAdminRole } = require('../middlewares/auth');
const { queryCache } = require('../config/cache');
const { logActivity } = require('../config/activity');
const { getSettings, getImageConfigs } = require('../utils/settings');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { countDailyUsage, getUserProviderKeys, saveUserProviderKey, deleteUserProviderKey, verifyProviderKey, startImageTask, getImageTask, cancelImageTask } = require('../services/image-gen');
const { saveReferenceImage, normalizeError } = require('../services/image-gen/utils');
const { enhancePrompt } = require('../services/prompt-enhance');
const { validateMagicBytes } = require('../utils/file-validator');

// 缓存包装：对查询结果进行短时间缓存（10秒）
function cachedQuery(cacheKey, db, sql, params = []) {
  const key = `${cacheKey}:${sql}:${JSON.stringify(params)}`;
  let result = queryCache.get(key);
  if (result === null) {
    result = queryAll(db, sql, params);
    queryCache.set(key, result, 10);
  }
  return result;
}

// ============ AI 图片生成 ============

// 参考图上传（内存存储，5MB，仅图片格式；落盘前再做魔数校验）
const refUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('参考图仅支持 JPG/PNG/WebP 格式'));
  }
});

// 生成接口限流：每用户 1 分钟 6 次
const aiImageLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `aiimg:${req.session.user.id}`,
  message: '生成过于频繁，请稍后再试'
});

// AI 生图页面
router.get('/ai-image', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const settings = getSettings(db);

  const userKeys = getUserProviderKeys(db, user.id);
  const userKeySet = new Set(userKeys);

  // 可生成服务商：站长已启用 或 用户已自填 Key；全部服务商供「添加 Key」弹窗使用
  const allProviderRows = queryAll(db, `SELECT provider_key, name, enabled, default_model, models, api_key_url, supports_negative, supports_n, supports_img2img
    FROM ai_image_providers ORDER BY sort_order ASC, id ASC`);
  const providers = allProviderRows.filter(p => p.enabled || userKeySet.has(p.provider_key));
  providers.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.requires_key = p.provider_key !== 'pollinations';
  });
  const allProviders = allProviderRows.map(p => ({
    provider_key: p.provider_key, name: p.name, api_key_url: p.api_key_url || ''
  }));

  const dailyLimit = parseInt(settings.ai_image_daily_limit, 10) || 20;
  const used = countDailyUsage(db, user.id);
  const unlimited = isAdminRole(user);
  const userPerms = res.locals.userPermissions || [];
  const canPickPrompt = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('prompts.view') !== -1 || userPerms.indexOf('prompts.manage') !== -1 ||
    userPerms.indexOf('prompts.*') !== -1;
  const canShare = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('image-share.access') !== -1 || userPerms.indexOf('image-share.*') !== -1;
  const canShareLink = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('image-share.share') !== -1 || userPerms.indexOf('image-share.*') !== -1;

  // 提示词库数据（picker 用；复用 ai_prompts_ 前缀缓存，后台改动自动失效）
  let prompts = [];
  if (canPickPrompt) {
    prompts = cachedQuery('ai_prompts_prompts', db,
      'SELECT id, category_id, title, excerpt FROM prompts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  }

  res.render('frontend/ai-image', {
    user,
    settings,
    providers,
    allProviders,
    dailyLimit,
    used,
    unlimited,
    canPickPrompt,
    canShare,
    canShareLink,
    userKeys,
    prompts
  });
});

// 保存用户自填的服务商 Key（加密存储；用户 Key 优先于后台全局 Key）
router.post('/ai-image/api/keys/save', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 20, keyGenerator: r => `aiimgkey:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const db = req.db;
    const userId = req.session.user.id;
    const providerKey = (req.body.provider_key || '').trim();
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';

    if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
    const provider = queryOne(db, 'SELECT provider_key FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!provider) return res.status(404).json({ error: '服务商不存在' });
    if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });
    if (apiKey.length > 300) return res.status(400).json({ error: 'API Key 长度超出限制' });
    if (apiKey.indexOf('ENC:') === 0) return res.status(400).json({ error: 'API Key 格式不正确' });

    saveUserProviderKey(db, userId, providerKey, apiKey);
    logActivity(db, {
      user_id: userId,
      username: req.session.user.username,
      action: 'update',
      target_type: 'ai_image_user_key',
      target_title: providerKey,
      detail: `用户保存了自己的 AI 生图服务商 Key：${providerKey}`,
      ip: req.ip
    });

    // 自动验证 Key 有效性并尝试获取模型（异步；整体 25s 兜底，避免服务商网络慢导致请求挂起）
    const verifyPromise = verifyProviderKey(db, providerKey, apiKey);
    const verifyTimeout = new Promise(resolve => {
      setTimeout(() => resolve({ ok: true, verified: false, error: '验证超时（服务商响应慢），Key 已保存' }), 25000);
    });
    Promise.race([verifyPromise, verifyTimeout]).then(verifyResult => {
      if (verifyResult.verified && verifyResult.models && verifyResult.models.length) {
        // 将 API 获取到的模型合并进服务商全局模型列表（去重），保证模型下拉可选到
        const row = queryOne(db, 'SELECT models, default_model FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
        if (row) {
          let current = [];
          try { current = JSON.parse(row.models || '[]'); } catch (e) { current = []; }
          const merged = current.slice();
          verifyResult.models.forEach(m => {
            if (merged.indexOf(m) === -1) merged.push(m);
          });
          let updated = false;
          if (merged.length !== current.length) {
            db.run('UPDATE ai_image_providers SET models = ? WHERE provider_key = ?', [JSON.stringify(merged), providerKey]);
            updated = true;
          }
          if (!row.default_model && merged.length) {
            db.run('UPDATE ai_image_providers SET default_model = ? WHERE provider_key = ?', [merged[0], providerKey]);
            updated = true;
          }
          if (updated) saveDatabase();
        }
      }
      if (!res.headersSent) {
        if (verifyResult.verified) {
          res.json({
            success: true,
            message: 'API Key 已保存并验证通过',
            verified: true,
            models: verifyResult.models || [],
            verifyError: ''
          });
        } else {
          res.json({
            success: true,
            message: 'API Key 已保存',
            verified: false,
            models: [],
            verifyError: verifyResult.error || '该平台暂不支持自动验证'
          });
        }
      }
    }).catch(() => {
      if (!res.headersSent) {
        res.json({ success: true, message: 'API Key 已保存', verified: false, models: [], verifyError: '验证失败' });
      }
    });
  });

// 删除用户自填的服务商 Key
router.post('/ai-image/api/keys/delete', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const providerKey = (req.body.provider_key || '').trim();
  if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
  deleteUserProviderKey(db, userId, providerKey);
  logActivity(db, {
    user_id: userId,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'ai_image_user_key',
    target_title: providerKey,
    detail: `用户删除了自己的 AI 生图服务商 Key：${providerKey}`,
    ip: req.ip
  });
  res.json({ success: true, message: 'API Key 已清除' });
});

// 提示词优化（免费 Pollinations 接口或后台配置的自建 LLM）
router.post('/ai-image/api/enhance-prompt', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 10, keyGenerator: r => `aiimg-enh:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
    const db = req.db;
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请输入要优化的内容' });
    if (prompt.length > 500) return res.status(400).json({ error: '描述不能超过 500 字' });

    try {
      const { enhanced, source } = await enhancePrompt(db, prompt);
      res.json({ success: true, enhanced, source });
    } catch (err) {
      res.status(502).json({ error: normalizeError(err) });
    }
  });

// 生成图片（异步任务：立即返回 taskId，前端轮询状态，支持取消）
router.post('/ai-image/api/generate', isAuthenticated, hasFrontendPermission('imagegen.use'), aiImageLimiter, (req, res) => {
  refUpload.single('reference_image')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? '参考图不能超过 5MB'
        : (uploadErr.message || '参考图上传失败');
      return res.status(400).json({ error: msg });
    }
    const db = req.db;
    const user = req.session.user;

    const prompt = (req.body.prompt || '').trim();
    const negativePrompt = (req.body.negative_prompt || '').trim();
    const size = (req.body.size || '1024x1024').trim();
    const providerKey = (req.body.provider || '').trim();
    const mode = (req.body.mode || 't2i').trim();
    const rawN = parseInt(req.body.n, 10) || 1;
    const rawSeed = req.body.seed === '' || req.body.seed === undefined ? 0 : parseInt(req.body.seed, 10);
    const style = (req.body.style || '').trim();

    if (!prompt) return res.status(400).json({ error: '提示词不能为空' });
    if (prompt.length > 1000) return res.status(400).json({ error: '提示词不能超过 1000 字' });
    if (negativePrompt.length > 500) return res.status(400).json({ error: '负向提示词不能超过 500 字' });
    if (!/^\d{1,4}[x*]\d{1,4}$/.test(size)) return res.status(400).json({ error: '图片尺寸格式不正确' });
    if (mode !== 't2i' && mode !== 'i2i') return res.status(400).json({ error: '生成模式不正确' });
    if (Number.isNaN(rawSeed) || rawSeed < 0 || rawSeed > 4294967295) {
      return res.status(400).json({ error: '种子数超出范围（0-4294967295）' });
    }

    // 服务商可用性：已启用 或 用户已自填 Key（用户用自己的 Key 不受启用开关限制）
    const provider = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!provider) return res.status(400).json({ error: '所选服务商不存在' });
    const userKeyList = getUserProviderKeys(db, user.id);
    if (!provider.enabled && userKeyList.indexOf(providerKey) === -1) {
      return res.status(400).json({ error: '所选服务商未启用，请选择其他服务商' });
    }
    const n = provider.supports_n ? Math.min(Math.max(rawN, 1), 4) : 1;

    // 图生图模式校验：服务商需支持且必须上传参考图
    if (mode === 'i2i') {
      if (!provider.supports_img2img) {
        return res.status(400).json({ error: '所选服务商不支持图生图，请切换服务商或回到文生图模式' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '图生图模式请先上传参考图' });
      }
    }

    // 每日限额（管理员不限；成功+失败均计次）
    if (!isAdminRole(user)) {
      const settings = getSettings(db);
      const dailyLimit = parseInt(settings.ai_image_daily_limit, 10) || 20;
      if (countDailyUsage(db, user.id) >= dailyLimit) {
        return res.status(429).json({ error: `今日生成次数已达上限（${dailyLimit} 次），明天再来吧` });
      }
    }

    // 参考图（图生图）
    let referenceImagePath = null;
    let referenceImageWebPath = '';
    if (req.file) {
      if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ error: '参考图文件校验失败，请更换图片' });
      }
      referenceImageWebPath = saveReferenceImage(req.file.buffer);
      referenceImagePath = path.join(__dirname, '../..', 'public', referenceImageWebPath);
    }

    try {
      // 后台异步执行，立即返回任务 ID；结果通过 /ai-image/api/status 轮询获取
      const taskId = startImageTask(db, {
        userId: user.id,
        providerKey,
        prompt,
        negativePrompt,
        size,
        n,
        seed: rawSeed || 0,
        style,
        referenceImagePath,
        referenceImageWebPath
      });
      return res.json({ success: true, taskId });
    } catch (err) {
      return res.status(500).json({ error: '生成服务异常：' + (err.message || '未知错误') });
    }
  });
});

// 生成任务状态（轮询）
router.get('/ai-image/api/status', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
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

// 取消生成任务（尽力调用服务商取消接口，避免远程资源浪费）
router.post('/ai-image/api/cancel', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const r = cancelImageTask(String((req.body && req.body.task) || ''), req.session.user.id);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  res.json({ success: true, message: r.message });
});

// 生成历史（分页，含失败记录）
router.get('/ai-image/api/history', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 12, 1), 50);
  const offset = (page - 1) * pageSize;

  const totalRows = queryAll(db, 'SELECT COUNT(*) AS cnt FROM ai_image_records WHERE user_id = ?', [userId]);
  const total = (totalRows && totalRows[0] && totalRows[0].cnt) || 0;
  const records = queryAll(db,
    'SELECT id, prompt, provider, model, size, status, image_path, error, shared, created_at FROM ai_image_records WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    [userId, pageSize, offset]);
  res.json({ success: true, data: { records, total, page, pageSize } });
});

// 分享到图片分享模块（复用 images 表与审核流程）
router.post('/ai-image/api/share', isAuthenticated, hasFrontendPermission('imagegen.use'),
  hasFrontendPermission('image-share.access'), (req, res) => {
    const db = req.db;
    const user = req.session.user;
    const recordId = parseInt(req.body.record_id, 10);
    if (!recordId) return res.status(400).json({ error: '参数错误' });

    const record = queryOne(db, 'SELECT * FROM ai_image_records WHERE id = ? AND user_id = ?', [recordId, user.id]);
    if (!record) return res.status(404).json({ error: '生成记录不存在' });
    if (record.status !== 'success' || !record.image_path) return res.status(400).json({ error: '该记录没有可分享的图片' });
    if (record.shared) return res.status(400).json({ error: '该图片已分享过' });

    // 目标分类：第一个启用的分类，无则自动创建"AI生图"分类
    let cate = queryOne(db, 'SELECT id FROM image_categories WHERE status = 1 ORDER BY sort ASC, id ASC LIMIT 1');
    if (!cate) {
      db.run("INSERT INTO image_categories (name, sort, status) VALUES ('AI生图', 0, 1)");
      cate = queryOne(db, 'SELECT id FROM image_categories WHERE status = 1 ORDER BY sort ASC, id ASC LIMIT 1');
    }
    if (!cate) return res.status(500).json({ error: '图片分享分类初始化失败' });

    const config = getImageConfigs(db);
    let status = config.review_enabled === '1' ? 0 : 1;
    if (status === 0) {
      const userInfo = queryOne(db, 'SELECT image_no_review FROM users WHERE id = ?', [user.id]);
      if (userInfo && userInfo.image_no_review === 1) status = 1;
    }

    const title = record.prompt.slice(0, 50) || 'AI生图';
    db.run('INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [title, record.prompt.slice(0, 500), record.image_path, cate.id, user.id, status]);
    db.run('UPDATE ai_image_records SET shared = 1 WHERE id = ?', [recordId]);
    saveDatabase();

    logActivity(db, {
      user_id: user.id,
      username: user.username,
      action: 'create',
      target_type: 'image',
      target_title: title,
      detail: `将 AI 生成图片（记录 #${recordId}）分享到图片分享`,
      ip: req.ip
    });

    res.json({ success: true, message: status === 1 ? '已分享到图片分享' : '已提交分享，等待管理员审核' });
  });

module.exports = router;
