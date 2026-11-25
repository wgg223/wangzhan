/**
 * AI 图片生成服务 - 主入口
 * 职责：provider 配置加载 → 调用适配器 → 魔数校验 → 落盘 → 写生成记录 → 自动换服务商重试
 */
const { queryOne, queryAll, saveDatabase } = require('../../config/database');
const { decrypt } = require('../../config/crypto-secure');
const { getSettings } = require('../../utils/settings');
const { saveImageBuffer, normalizeError } = require('./utils');
const { resolveSizeForProvider, sizeFallbacks, isSizeFallbackError, qualityKeyword, aspectRatioOf } = require('./sizes');
const { getTemplate, getTemplateForProvider, listTemplates } = require('./templates');
const crypto = require('crypto');

// 加载全部适配器（协议实现）；具体平台实例是数据库里的 provider 行，由 resolveAdapterKey 映射过来。
const adapterModules = {};
const KEYLESS_IMAGE_PROVIDERS = new Set(['pollinations', 'comfyui']);
[
  'comfyui', 'openai', 'openai_compat', 'stability', 'siliconflow', 'zhipu', 'dashscope', 'baidu',
  'pollinations', 'runninghub', 'hunyuan', 'stepfun', 'minimax', 'replicate', 'doubao', 'fal',
  'aihubmix', 'momoapi', 'seedance', 'wavespeed'
].forEach(name => {
  adapterModules[name] = require(`./providers/${name}`);
});

/**
 * 解析平台实例 key 对应的适配器名。
 * 规则（按优先级）：
 *   1. 精确命中适配器（内置平台，如 seedance / runninghub）
 *   2. `模板key__后缀` 形式 → 模板声明的 adapter（多账号 / 国际节点）
 *   3. `custom__xxx` → 通用 OpenAI 兼容适配器（任意域名）
 * @param {string} providerKey
 * @returns {string|null}
 */
function resolveAdapterKey(providerKey) {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  if (adapterModules[key]) return key;
  const template = getTemplateForProvider(key);
  if (template && adapterModules[template.adapter]) return template.adapter;
  if (/^custom([_-]|$)/i.test(key)) return 'openai_compat';
  return null;
}

// 适配器表：用 Proxy 让 `providers[任意实例key]` 自动解析到协议适配器，
// 这样路由层、管理页无需感知「平台实例」这一层。
const providers = new Proxy(adapterModules, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop];
    if (target[prop]) return target[prop];
    const adapterKey = resolveAdapterKey(prop);
    return adapterKey ? target[adapterKey] : undefined;
  },
  has(target, prop) {
    if (typeof prop !== 'string') return prop in target;
    return Boolean(target[prop] || resolveAdapterKey(prop));
  }
});

/**
 * 判断服务商是否免 Key（pollinations / comfyui 及其实例）。
 * @param {string} providerKey
 * @returns {boolean}
 */
function isKeylessProvider(providerKey) {
  const key = String(providerKey || '').trim();
  return KEYLESS_IMAGE_PROVIDERS.has(key) || KEYLESS_IMAGE_PROVIDERS.has(key.split('__')[0]);
}

// ============ 异步生成任务注册表（进程内存，单实例） ============
// 生成请求立即返回 taskId，后台执行，前端轮询状态；支持取消（尽力调用服务商取消接口）
const taskRegistry = new Map();
const TASK_TTL_MS = 10 * 60 * 1000; // 终态任务保留 10 分钟后清理

// ============ 全局并发信号量：最多同时 4 个生成任务 ============
const MAX_CONCURRENT_TASKS = 4;
let activeTaskCount = 0;

function createTaskId() {
  return crypto.randomBytes(8).toString('hex');
}

function pruneTasks() {
  const now = Date.now();
  for (const [id, t] of taskRegistry) {
    if (t.finishedAt && now - t.finishedAt > TASK_TTL_MS) taskRegistry.delete(id);
  }
}

function normalizeImageCount(value) {
  return Math.min(Math.max(parseInt(value, 10) || 1, 1), 4);
}

/**
 * 解析本次实际使用的模型：客户端只能选择后台白名单中的模型。
 * 未命中时使用当前服务商默认模型，避免把任意字符串传给 adapter 或拼进 URL。
 */
function resolveProviderModel(cfg, requestedValue) {
  const requested = typeof requestedValue === 'string' ? requestedValue.trim().slice(0, 300) : '';
  const allowedModels = Array.isArray(cfg.models) ? cfg.models : [];
  if (requested && allowedModels.includes(requested)) return requested;
  // 用户显式选了模型就尊重选择：列表可能过期或只同步到部分模型，
  // 静默回退到默认模型会出现「换了模型还是用 gpt」的错觉。
  if (requested && requested !== cfg.default_model) {
    console.warn(`[image-gen] 模型「${requested}」不在 ${cfg.provider_key || cfg.key || '服务商'} 的模型列表里，仍按用户选择提交`);
    return requested;
  }
  if (!allowedModels.length && requested) return requested;
  return cfg.default_model && (!allowedModels.length || allowedModels.includes(cfg.default_model))
    ? cfg.default_model
    : (allowedModels[0] || '');
}

/**
 * 同步服务商模型列表和默认模型。
 * MomoAPI 等标记 authoritativeModels 的服务商以当前 Key 的认证结果为准，避免混入公开目录中的失效模型。
 */
function syncProviderModels(providerKey, currentModels, fetchedModels, currentDefaultModel) {
  const adapter = providers[providerKey] || {};
  const fetched = Array.isArray(fetchedModels) ? fetchedModels.slice() : [];
  let models;
  if (adapter.authoritativeModels) {
    models = fetched;
  } else {
    models = Array.isArray(currentModels) ? currentModels.slice() : [];
    fetched.forEach((model) => {
      if (models.indexOf(model) === -1) models.push(model);
    });
  }
  const defaultModel = typeof adapter.selectDefaultModel === 'function'
    ? adapter.selectDefaultModel(models, currentDefaultModel || '')
    : ((currentDefaultModel && models.includes(currentDefaultModel)) ? currentDefaultModel : (models[0] || ''));
  return { models, defaultModel };
}

/**
 * 查询额度状态：已落库记录 + 正在执行任务的预留额度。
 * 失败重试也会写记录，因此按最坏情况预留，避免并发请求穿透每日限额。
 */
function checkImageQuota(db, userId, count) {
  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (user && (user.role === 'super_admin' || user.role === 'admin')) {
    return { ok: true, unlimited: true, used: countDailyUsage(db, userId), limit: null };
  }
  const settings = getSettings(db);
  const limit = parseInt(settings.ai_image_daily_limit, 10) || 20;
  let pending = 0;
  for (const task of taskRegistry.values()) {
    if (task.userId === userId && !task.finishedAt) pending += task.quotaUnits || 0;
  }
  const used = countDailyUsage(db, userId) + pending;
  return { ok: used + count <= limit, unlimited: false, used, limit };
}

function getQuotaReservationUnits(db, params) {
  const n = normalizeImageCount(params.n);
  const hasReference = Boolean(params.referenceImagePath ||
    (Array.isArray(params.referenceImagePaths) && params.referenceImagePaths.length));
  if (getSettings(db).ai_image_fallback === '0') return n;
  const baseQuota = checkImageQuota(db, params.userId, n);
  const userKeys = new Set(getUserProviderKeys(db, params.userId));
  const usableCount = queryAll(db,
    'SELECT provider_key, enabled, supports_img2img, api_key_enc FROM ai_image_providers ORDER BY sort_order ASC, id ASC')
    .filter(p => (p.enabled || userKeys.has(p.provider_key)) &&
      (!hasReference || p.supports_img2img) &&
      providers[p.provider_key] &&
      (isKeylessProvider(p.provider_key) || p.api_key_enc || userKeys.has(p.provider_key))).length;
  // 剩余额度不足时只允许首轮尝试，不能因最坏情况预留而把正常用户挡在限额外。
  const retryUnits = baseQuota.unlimited ? 2 : Math.max(0, (baseQuota.limit || 0) - baseQuota.used - n);
  return n + Math.min(retryUnits, Math.max(usableCount - 1, 0), 2);
}

function checkImageTaskQuota(db, params) {
  return checkImageQuota(db, params.userId, getQuotaReservationUnits(db, params));
}

/**
 * 启动异步生成任务
 * @param {Object} db
 * @param {Object} params 同 generateImage 的 params
 * @returns {string} taskId
 */
function startImageTask(db, params) {
  // 并发上限检查：超过 4 个同时生成时直接拒绝，返回友好错误
  if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
    throw new Error('生成服务繁忙，请稍后重试');
  }
  const quotaUnits = getQuotaReservationUnits(db, params);
  const quota = checkImageQuota(db, params.userId, quotaUnits);
  if (!quota.ok) {
    throw Object.assign(new Error(`今日生成次数已达上限（${quota.limit} 次），明天再来吧`), {
      code: 'QUOTA_EXCEEDED', status: 429
    });
  }
  activeTaskCount++;

  const task = {
    id: createTaskId(),
    userId: params.userId,
    providerKey: params.providerKey,
    status: 'running', // running | success | failed | cancelled
    message: '任务已提交，等待服务商响应...',
    createdAt: Date.now(),
    finishedAt: null,
    quotaUnits,
    result: null,
    cancel: null
  };
  taskRegistry.set(task.id, task);
  executeImageTask(task, db, params).finally(() => {
    // 任务结束（无论成败）释放并发名额
    activeTaskCount = Math.max(0, activeTaskCount - 1);
  });
  return task.id;
}

/**
 * 获取任务（含 userId，供路由校验归属）
 * @param {string} taskId
 */
function getImageTask(taskId) {
  return taskRegistry.get(taskId) || null;
}

/**
 * 取消任务：置取消标志 + 尽力调用服务商取消接口（fal/Replicate 支持，RunningHub 无开放取消接口）
 * @param {string} taskId
 * @param {number} userId
 */
function cancelImageTask(taskId, userId) {
  const task = taskRegistry.get(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.userId !== userId) return { ok: false, error: '无权操作该任务' };
  if (task.status !== 'running' || typeof task.cancel !== 'function') {
    return { ok: false, error: '任务已结束，无法取消' };
  }
  task.cancel(); // 同步置取消标志，异步调服务商取消接口
  return { ok: true, message: '已发送取消请求，正在停止任务' };
}

async function executeImageTask(task, db, params) {
  // 当前尝试信息：供取消时读取服务商任务 ID 以调用其取消接口
  const controller = new AbortController();
  const taskRef = { cancelled: false, current: null, signal: controller.signal, quotaUnits: task.quotaUnits };
  task.cancel = async () => {
    task.status = 'cancelled';
    task.message = '正在取消任务...';
    taskRef.cancelled = true;
    controller.abort(); // 掐断所有在途 HTTP 请求（同步型服务商立即中断）
    const cur = taskRef.current;
    if (cur && cur.cfg && cur.taskInfo) {
      const adapter = providers[cur.providerKey];
      if (adapter && typeof adapter.cancel === 'function') {
        try {
          await adapter.cancel(cur.cfg, cur.taskInfo);
          task.message = '已通知服务商取消远程任务';
        } catch (e) {
          task.message = '服务商取消接口调用失败，任务可能继续运行';
        }
      }
    }
  };
  try {
    const result = await generateImage(db, params, taskRef);
    if (task.status === 'cancelled') {
      task.message = '任务已取消';
      return;
    }
    task.status = result.ok ? 'success' : 'failed';
    task.message = result.ok ? '生成完成' : (result.error || '生成失败');
    task.result = result;
  } catch (err) {
    task.status = 'failed';
    task.message = err.message || '生成失败';
    task.result = { ok: false, error: normalizeError(err) };
  } finally {
    task.finishedAt = Date.now();
    pruneTasks();
  }
}

/**
 * 获取服务商配置（解密 Key，供服务端使用，绝不外泄）
 * Key 优先级：用户自填 Key > 后台全局 Key（userId 传入时生效）
 * @param {Object} db
 * @param {string} providerKey
 * @param {number} [userId]
 * @returns {Object|null} { provider_key, name, api_key, key_source, api_base, api_path, default_model, models, supports_negative, supports_n, supports_img2img, enabled }
 */
function getProviderConfig(db, providerKey, userId) {
  const row = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
  if (!row) return null;
  let models = [];
  try { models = JSON.parse(row.models || '[]'); } catch (e) { models = []; }

  let apiKey = decrypt(row.api_key_enc || '');
  let keySource = apiKey ? 'global' : 'none';
  if (userId) {
    const userKey = getUserProviderKey(db, userId, providerKey);
    if (userKey) {
      apiKey = userKey;
      keySource = 'user';
    }
  }
  const settings = getSettings(db);
  const comfyuiConfig = providerKey === 'comfyui' ? {
    workflow: settings.ai_image_comfyui_workflow || '',
    nodeMap: settings.ai_image_comfyui_node_map || ''
  } : {};
  return {
    provider_key: row.provider_key,
    name: row.name,
    api_key: apiKey,
    key_source: keySource,
    api_base: row.api_base || '',
    api_path: row.api_path || '',
    default_model: row.default_model || '',
    models,
    supports_negative: Boolean(row.supports_negative),
    supports_n: Boolean(row.supports_n),
    supports_img2img: Boolean(row.supports_img2img),
    enabled: Boolean(row.enabled),
    ...comfyuiConfig
  };
}

/**
 * 获取用户自填的服务商 Key（解密）
 * @param {Object} db
 * @param {number} userId
 * @param {string} providerKey
 * @returns {string|null}
 */
function getUserProviderKey(db, userId, providerKey) {
  const row = queryOne(db, 'SELECT api_key_enc FROM ai_image_user_keys WHERE user_id = ? AND provider_key = ?',
    [userId, providerKey]);
  if (!row || !row.api_key_enc) return null;
  const key = decrypt(row.api_key_enc);
  return key && key.indexOf('ENC:') !== 0 ? key : null;
}

/**
 * 保存/更新用户自填的服务商 Key（加密存储）
 * @param {Object} db
 * @param {number} userId
 * @param {string} providerKey
 * @param {string} apiKey
 */
function saveUserProviderKey(db, userId, providerKey, apiKey) {
  const existing = queryOne(db, 'SELECT id FROM ai_image_user_keys WHERE user_id = ? AND provider_key = ?',
    [userId, providerKey]);
  const { encrypt } = require('../../config/crypto-secure');
  const enc = encrypt(apiKey);
  if (existing) {
    db.run('UPDATE ai_image_user_keys SET api_key_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [enc, existing.id]);
  } else {
    db.run('INSERT INTO ai_image_user_keys (user_id, provider_key, api_key_enc) VALUES (?, ?, ?)',
      [userId, providerKey, enc]);
  }
  saveDatabase();
}

/**
 * 删除用户自填的服务商 Key
 * @param {Object} db
 * @param {number} userId
 * @param {string} providerKey
 * @returns {boolean}
 */
function deleteUserProviderKey(db, userId, providerKey) {
  const existing = queryOne(db, 'SELECT id FROM ai_image_user_keys WHERE user_id = ? AND provider_key = ?',
    [userId, providerKey]);
  if (!existing) return false;
  db.run('DELETE FROM ai_image_user_keys WHERE id = ?', [existing.id]);
  saveDatabase();
  return true;
}

/**
 * 用户已配置 Key 的服务商列表（掩码信息，不含明文）
 * @param {Object} db
 * @param {number} userId
 * @returns {string[]}
 */
function getUserProviderKeys(db, userId) {
  const rows = queryAll(db, 'SELECT provider_key FROM ai_image_user_keys WHERE user_id = ?', [userId]);
  return rows.map(r => r.provider_key);
}

/**
 * 查询用户当日已用次数（成功+失败均计次）
 * @param {Object} db
 * @param {number} userId
 * @returns {number}
 */
function countDailyUsage(db, userId) {
  // created_at 使用 SQLite CURRENT_TIMESTAMP（UTC）。先按服务器本地时区取自然日边界，
  // 再转成 UTC 字符串比较，避免本地 00:00–08:00 漏记，也避免额度提前在 UTC 日切重置。
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const toSqlUtc = date => date.toISOString().slice(0, 19).replace('T', ' ');
  const rows = queryAll(db,
    'SELECT COUNT(*) AS cnt FROM ai_image_records WHERE user_id = ? AND created_at >= ? AND created_at < ?',
    [userId, toSqlUtc(start), toSqlUtc(end)]);
  return (rows && rows[0] && rows[0].cnt) || 0;
}

/**
 * 保存生成图片并写记录
 * @param {Object} db
 * @param {Object} params
 */
function persistImages(db, params, images) {
  const recordBase = {
    user_id: params.userId,
    prompt: params.prompt,
    provider: params.provider,
    model: params.model || '',
    size: params.size || '',
    seed: params.seed || 0,
    style: params.style || '',
    reference_image: params.referenceImageWebPath || ''
  };
  for (const img of images) {
    db.run(`INSERT INTO ai_image_records
      (user_id, prompt, provider, model, size, seed, style, reference_image, status, image_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [recordBase.user_id, recordBase.prompt, recordBase.provider, recordBase.model,
      recordBase.size, recordBase.seed, recordBase.style, recordBase.reference_image, img.path]);
  }
  saveDatabase();
}

function persistFailure(db, params, provider, error) {
  db.run(`INSERT INTO ai_image_records
    (user_id, prompt, provider, model, size, seed, style, reference_image, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)`,
  [params.userId, params.prompt, provider, params.model || '', params.size || '',
    params.seed || 0, params.style || '', params.referenceImageWebPath || '',
    String(error).slice(0, 500)]);
  saveDatabase();
}

/**
 * 生成图片（含自动换服务商重试）
 * @param {Object} db
 * @param {Object} params
 *   { userId, providerKey, prompt, negativePrompt, size, n, seed, style,
 *     referenceImagePath (绝对路径|null), referenceImagePaths (多参考图，最多 4 张), referenceImageWebPath }
 * @param {Object} [taskRef] 任务引用：{ cancelled, current }，供异步任务取消
 * @returns {Promise<{ok: true, images: Array<{path, url}>} | {ok: false, error, providerKey}>}
 */
async function generateImage(db, params, taskRef) {
  const settings = getSettings(db);
  const fallbackEnabled = settings.ai_image_fallback !== '0';

  // 参考图：画布通道支持多张（最多 4 张），基础页只有一张；统一归一化成数组。
  const referencePaths = (Array.isArray(params.referenceImagePaths) && params.referenceImagePaths.length
    ? params.referenceImagePaths
    : (params.referenceImagePath ? [params.referenceImagePath] : []))
    .filter(item => typeof item === 'string' && item)
    .slice(0, 4);

  // 可用服务商：站长已启用 或 用户已自填 Key（用户用自己的 Key 不受启用开关限制）
  const userKeySet = new Set(getUserProviderKeys(db, params.userId));
  const all = queryAll(db,
    'SELECT provider_key, enabled, supports_img2img FROM ai_image_providers ORDER BY sort_order ASC, id ASC');
  const usableKeys = all.filter(p => (p.enabled || userKeySet.has(p.provider_key)) &&
    (!referencePaths.length || p.supports_img2img)).map(p => p.provider_key);
  const chosen = params.providerKey;
  const candidates = [chosen, ...usableKeys.filter(k => k !== chosen)];

  const adapter = providers[chosen];
  if (!adapter || !usableKeys.includes(chosen)) {
    return { ok: false, error: '所选服务商不可用（未启用且未配置我的 Key）', providerKey: chosen };
  }
  // 首选服务商必须实际可用。缺少 Key 属于配置问题，不能静默改用 ComfyUI，
  // 否则用户会误以为选择了其他厂商，实际却请求了本地服务。
  const chosenCfg = getProviderConfig(db, chosen, params.userId);
  if (!chosenCfg) {
    return { ok: false, error: '所选服务商配置不存在，请刷新页面后重试', providerKey: chosen };
  }
  if (!isKeylessProvider(chosen) && !chosenCfg.api_key) {
    return {
      ok: false,
      error: `所选服务商「${chosenCfg.name || chosen}」未配置 API Key：请填写「我的 API Key」，或由管理员配置全局 Key`,
      providerKey: chosen,
      provider: chosenCfg.name || chosen,
      elapsedMs: Date.now(),
      attempts: []
    };
  }

  let lastError = null;
  let tried = 0;
  const requestedCount = normalizeImageCount(params.n);
  const reservedRetries = taskRef ? Math.max(0, (taskRef.quotaUnits || requestedCount) - requestedCount) : 2;
  const maxAttempts = fallbackEnabled ? Math.min(usableKeys.length, 3, 1 + reservedRetries) : 1;
  const attempts = []; // 记录每次尝试：服务商 / 模型 / 错误 / 耗时
  const startTime = Date.now();

  for (const providerKey of candidates) {
    if (taskRef && taskRef.cancelled) break;
    if (!usableKeys.includes(providerKey)) continue;
    const adapterImpl = providers[providerKey];
    if (!adapterImpl) continue;
    const cfg = getProviderConfig(db, providerKey, params.userId);
    if (!cfg) continue;
    // 免 Key 服务商（Pollinations / ComfyUI）无需 Key，其余必须有
    if (!isKeylessProvider(providerKey) && !cfg.api_key) continue;
    // 图生图：服务商必须支持且已提供参考图
    const useRef = Boolean(referencePaths.length && cfg.supports_img2img);

    tried++;
    const attemptStart = Date.now();
    let attemptModel = cfg.default_model || '';
    const sizeInfo = resolveSizeForProvider(providerKey, params.size, params.model || cfg.default_model);
    const sizePlan = sizeFallbacks(sizeInfo.size);
    let attemptSize = sizePlan[0];
    try {
      // 客户端只能选择后台模型白名单中的模型；切换服务商或参数被篡改时回退到该服务商默认模型。
      // 不能把任意字符串直接交给 adapter（部分服务商会把它拼进请求路径）。
      const model = resolveProviderModel(cfg, params.model);
      attemptModel = model;
      const adapterCfg = {
        apiKey: cfg.api_key,
        baseUrl: cfg.api_base,
        model,
        models: cfg.models,
        apiPath: cfg.api_path,
        workflow: cfg.workflow,
        nodeMap: cfg.nodeMap,
        // 通用适配器需要知道平台声明的能力，避免把负数/多图参数发给不支持的站点。
        supportsNegative: cfg.supports_negative,
        supportsN: cfg.supports_n,
        supportsImg2img: cfg.supports_img2img
      };
      let result = null;
      // 4K/大尺寸请求被服务商以尺寸或显存错误拒绝时，自动降一档重试；普通报错不降尺寸。
      for (let sizeIndex = 0; sizeIndex < sizePlan.length; sizeIndex++) {
        attemptSize = sizePlan[sizeIndex];
        // taskInfo 由适配器填充（服务商任务 ID），供取消时调用其取消接口；每次重试都重新创建。
        const taskInfo = {};
        const req = {
          prompt: params.prompt,
          negativePrompt: params.negativePrompt || '',
          size: attemptSize,
          n: params.n || 1,
          seed: params.seed || undefined,
          referenceImage: referencePaths[0] || null,
          referenceImages: useRef ? referencePaths : [],
          cancelRef: taskRef || null,
          taskInfo,
          style: params.style || '',
          // 各平台协议差异：WaveSpeed/MiniMax/Seedream 用「画质关键词 + 比例」而不是像素
          quality: qualityKeyword(attemptSize),
          aspectRatio: aspectRatioOf(attemptSize)
        };
        if (taskRef) taskRef.current = { providerKey, cfg, taskInfo };
        try {
          result = useRef && adapterImpl.generateWithReference
            ? await adapterImpl.generateWithReference(adapterCfg, req, referencePaths[0])
            : await adapterImpl.generate(adapterCfg, req);
          break;
        } catch (sizeErr) {
          if (!sizeErr.fromPoll && sizeIndex < sizePlan.length - 1 && isSizeFallbackError(sizeErr)) continue;
          throw sizeErr;
        }
      }
      // 多参考图只对声明支持的适配器生效；其余平台用第一张并在结果里标注，避免误以为全部生效。
      const referencesUsed = useRef
        ? (adapterImpl.supportsMultipleReferences ? referencePaths.length : (referencePaths.length ? 1 : 0))
        : 0;
      const referenceLimited = useRef && referencePaths.length > referencesUsed;
      // 适配器可能因模型能力不匹配自动切换模型，记录和响应必须使用最终实际模型。
      const actualModel = typeof result.model === 'string' && result.model ? result.model : model;
      const resultSize = typeof result.size === 'string' && /^\d{1,5}[x*]\d{1,5}$/i.test(result.size)
        ? result.size.replace(/\*/g, 'x')
        : attemptSize;
      const requestedSize = (params.size || '1024x1024').replace(/\*/g, 'x');
      const sizeAdjusted = resultSize !== requestedSize;

      const images = [];
      const maxImages = normalizeImageCount(params.n);
      for (const img of result.images.slice(0, maxImages)) {
        if (img && img.buffer) {
          const webPath = saveImageBuffer(img.buffer);
          images.push({ path: webPath, url: webPath });
        }
      }
      if (!images.length) {
        throw Object.assign(new Error('未生成任何图片'), { code: 'EMPTY_RESPONSE' });
      }
      persistImages(db, { ...params, size: resultSize, provider: providerKey, model: actualModel }, images);
      return {
        ok: true,
        images,
        providerKey,
        provider: cfg.name || providerKey,
        fallbackUsed: providerKey !== chosen,
        error: null,
        prompt: params.prompt,
        model: actualModel,
        modelRecovered: Boolean(result.modelRecovered),
        size: resultSize,
        requestedSize: requestedSize,
        sizeAdjusted: sizeAdjusted,
        sizeFallback: attemptSize !== sizeInfo.size,
        referencesUsed,
        referenceLimited,
        elapsedMs: Date.now() - startTime,
        attempts
      };
    } catch (err) {
      if (taskRef && taskRef.cancelled) {
        // 取消优先：记录为已取消，不再尝试其他服务商
        persistFailure(db, { ...params, size: attemptSize, provider: providerKey, model: attemptModel }, providerKey, '任务已取消');
        break;
      }
      lastError = normalizeError(err);
      attempts.push({
        provider: providerKey,
        model: attemptModel,
        size: attemptSize,
        error: lastError,
        elapsedMs: Date.now() - attemptStart
      });
      persistFailure(db, { ...params, size: attemptSize, provider: providerKey, model: attemptModel }, providerKey, lastError);
      if (tried >= maxAttempts) break;
    }
  }

  if (tried === 0) {
    // 首选已通过配置检查；其余候选均因缺少适配器或 Key 被跳过。
    return { ok: false, error: '没有可用的生图服务商，请检查服务商配置', providerKey: chosen, provider: chosenCfg.name || chosen, elapsedMs: Date.now() - startTime, attempts };
  }

  // 兜底失败时保留首选服务商的原始错误，避免最后一项 ComfyUI 的 ECONNREFUSED
  // 覆盖用户真正选择的厂商错误。每次尝试仍可通过 attempts 查看。
  const primaryAttempt = attempts.find(attempt => attempt.provider === chosen);
  return {
    ok: false,
    error: (primaryAttempt && primaryAttempt.error) || lastError || '生成失败',
    providerKey: chosen,
    provider: chosenCfg.name || chosen,
    elapsedMs: Date.now() - startTime,
    attempts
  };
}

/**
 * 获取服务商模型列表（后台"获取模型"按钮 + 保存 Key 后自动刷新）
 * @param {Object} db
 * @param {string} providerKey
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
async function fetchProviderModels(db, providerKey) {
  const adapterImpl = providers[providerKey];
  const cfg = getProviderConfig(db, providerKey);
  if (!adapterImpl || !cfg) {
    return { ok: false, error: '服务商不存在' };
  }
  if (!adapterImpl.fetchModels) {
    return { ok: false, error: '该服务商不支持自动获取模型，请手动填写' };
  }
  if (!isKeylessProvider(providerKey) && !cfg.api_key) {
    return { ok: false, error: '请先配置 API Key 再获取模型' };
  }
  try {
    const models = await adapterImpl.fetchModels({
      apiKey: cfg.api_key,
      baseUrl: cfg.api_base,
      model: cfg.default_model,
      apiPath: cfg.api_path,
      workflow: cfg.workflow,
      nodeMap: cfg.nodeMap
    });
    if (!models || !models.length) {
      return { ok: false, error: '未获取到图片模型，请手动填写（服务商可能无公开模型列表）' };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

/**
 * 查询服务商余额（可选能力）：适配器实现 fetchBalance 才可用。
 * 余额查询失败绝不抛出——它是附信息，不能影响保存 Key、验证连接和生图。
 * @param {Object} db
 * @param {string} providerKey
 * @param {number} [userId] 传了就用该用户自填 Key
 * @param {number} [timeoutMs] 兜底超时
 * @returns {Promise<{ok: boolean, balance?: Object|null, error?: string}>}
 */
async function fetchProviderBalance(db, providerKey, userId, timeoutMs) {
  const adapter = providers[providerKey];
  const cfg = getProviderConfig(db, providerKey, userId);
  if (!adapter || !cfg) return { ok: false, error: '平台不存在' };
  if (typeof adapter.fetchBalance !== 'function') {
    return { ok: false, error: '该平台没有可用的余额查询接口' };
  }
  if (!isKeylessProvider(providerKey) && !cfg.api_key) {
    return { ok: false, error: '请先配置 API Key 再查询余额' };
  }
  const call = adapter.fetchBalance({
    apiKey: cfg.api_key,
    baseUrl: cfg.api_base,
    model: cfg.default_model,
    apiPath: cfg.api_path
  });
  const limit = Math.max(parseInt(timeoutMs, 10) || 10000, 1000);
  const timeout = new Promise(resolve => {
    setTimeout(() => resolve({ __timeout: true }), limit);
  });
  try {
    const balance = await Promise.race([call, timeout]);
    if (balance && balance.__timeout) return { ok: false, error: '余额查询超时，请稍后重试' };
    return { ok: true, balance: balance || null };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

/**
 * 验证用户填写的 API Key 是否有效（保存后自动调用）
 * 策略：优先调用 adapter.verify（必须包含鉴权检查）；通过后再尝试拉取模型列表。
 * 对没有 verify 的适配器，才用 fetchModels 的认证结果判断；都不支持则返回 verified:false。
 * @param {Object} db
 * @param {string} providerKey
 * @param {string} apiKey - 用户新填写的明文 Key
 * @returns {Promise<{ok: boolean, verified?: boolean, models?: string[], error?: string}>}
 */
async function verifyProviderKey(db, providerKey, apiKey) {
  const row = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
  const adapterImpl = providers[providerKey];
  if (!row || !adapterImpl) {
    return { ok: false, error: '服务商不存在' };
  }
  const cfg = {
    apiKey,
    baseUrl: row.api_base || '',
    model: row.default_model || '',
    apiPath: row.api_path || ''
  };
  try {
    if (typeof adapterImpl.verify === 'function') {
      const valid = await adapterImpl.verify(cfg);
      if (valid) {
        let models = [];
        if (typeof adapterImpl.fetchModels === 'function') {
          try {
            const fetched = await adapterImpl.fetchModels(cfg);
            if (Array.isArray(fetched)) models = fetched;
          } catch (e) { /* Key 已验证，模型拉取失败不否定验证结果 */ }
        }
        return { ok: true, verified: true, models };
      }
      return { ok: true, verified: false, error: 'API Key 验证未通过，Key 已保存，请检查后重试' };
    }
    if (typeof adapterImpl.fetchModels === 'function') {
      const models = await adapterImpl.fetchModels(cfg);
      if (models !== null) {
        return { ok: true, verified: true, models: Array.isArray(models) ? models : [] };
      }
    }
    return { ok: true, verified: false, error: '未能自动验证（Key 可能无效或该平台不支持自动验证），Key 已保存' };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

/**
 * 获取默认生图服务商：优先使用后台指定项；未指定时优先 ComfyUI。
 * 仅返回已启用且存在的服务商，调用方仍需按用户自己的 Key 做可用性过滤。
 */
function getDefaultImageProviderKey(db) {
  const settings = getSettings(db);
  const preferred = settings.ai_image_default_provider || 'comfyui';
  const row = queryOne(db,
    'SELECT provider_key FROM ai_image_providers WHERE provider_key = ? AND enabled = 1', [preferred]);
  if (row) return row.provider_key;
  const fallback = queryOne(db,
    'SELECT provider_key FROM ai_image_providers WHERE enabled = 1 ORDER BY sort_order ASC, id ASC LIMIT 1');
  return fallback ? fallback.provider_key : null;
}

module.exports = {
  providers,
  KEYLESS_IMAGE_PROVIDERS,
  isKeylessProvider,
  resolveAdapterKey,
  listTemplates,
  getTemplate,
  getProviderConfig,
  getUserProviderKey,
  saveUserProviderKey,
  deleteUserProviderKey,
  getUserProviderKeys,
  getDefaultImageProviderKey,
  countDailyUsage,
  resolveProviderModel,
  syncProviderModels,
  checkImageQuota,
  checkImageTaskQuota,
  generateImage,
  fetchProviderModels,
  fetchProviderBalance,
  verifyProviderKey,
  startImageTask,
  getImageTask,
  cancelImageTask
};
