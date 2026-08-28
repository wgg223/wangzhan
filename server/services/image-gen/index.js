/**
 * AI 图片生成服务 - 主入口
 * 职责：provider 配置加载 → 调用适配器 → 魔数校验 → 落盘 → 写生成记录 → 自动换服务商重试
 */
const { queryOne, queryAll, saveDatabase } = require('../../config/database');
const { decrypt } = require('../../config/crypto-secure');
const { getSettings } = require('../../utils/settings');
const { saveImageBuffer, normalizeError } = require('./utils');

// 加载全部适配器
const providers = {};
[
  'openai', 'stability', 'siliconflow', 'zhipu', 'dashscope', 'baidu', 'pollinations',
  'runninghub', 'hunyuan', 'stepfun', 'minimax', 'replicate', 'doubao', 'fal', 'aihubmix'
].forEach(name => {
  providers[name] = require(`./providers/${name}`);
});

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
    enabled: Boolean(row.enabled)
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
  const rows = queryAll(db,
    "SELECT COUNT(*) AS cnt FROM ai_image_records WHERE user_id = ? AND date(created_at) = date('now', 'localtime')",
    [userId]);
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
 *     referenceImagePath (绝对路径|null), referenceImageWebPath }
 * @returns {Promise<{ok: true, images: Array<{path, url}>} | {ok: false, error, providerKey}>}
 */
async function generateImage(db, params) {
  const settings = getSettings(db);
  const fallbackEnabled = settings.ai_image_fallback !== '0';

  // 可用服务商：站长已启用 或 用户已自填 Key（用户用自己的 Key 不受启用开关限制）
  const userKeySet = new Set(getUserProviderKeys(db, params.userId));
  const all = queryAll(db, 'SELECT provider_key, enabled FROM ai_image_providers ORDER BY sort_order ASC, id ASC');
  const usableKeys = all.filter(p => p.enabled || userKeySet.has(p.provider_key)).map(p => p.provider_key);
  const chosen = params.providerKey;
  const candidates = [chosen, ...usableKeys.filter(k => k !== chosen)];

  const adapter = providers[chosen];
  if (!adapter || !usableKeys.includes(chosen)) {
    return { ok: false, error: '所选服务商不可用（未启用且未配置我的 Key）', providerKey: chosen };
  }

  let lastError = null;
  let tried = 0;
  const maxAttempts = fallbackEnabled ? Math.min(usableKeys.length, 3) : 1;
  const attempts = []; // 记录每次尝试：服务商 / 模型 / 错误 / 耗时
  const startTime = Date.now();

  for (const providerKey of candidates) {
    if (!usableKeys.includes(providerKey)) continue;
    const adapterImpl = providers[providerKey];
    if (!adapterImpl) continue;
    const cfg = getProviderConfig(db, providerKey, params.userId);
    if (!cfg) continue;
    // 免 Key 服务商（pollinations）无需 Key，其余必须有
    if (providerKey !== 'pollinations' && !cfg.api_key) continue;
    // 图生图：服务商必须支持且已提供参考图
    const useRef = Boolean(params.referenceImagePath && cfg.supports_img2img);

    tried++;
    const attemptStart = Date.now();
    try {
      const req = {
        prompt: params.prompt,
        negativePrompt: params.negativePrompt || '',
        size: params.size || '1024x1024',
        n: params.n || 1,
        seed: params.seed || undefined,
        referenceImage: params.referenceImagePath || null
      };
      const model = cfg.default_model;
      const adapterCfg = { apiKey: cfg.api_key, baseUrl: cfg.api_base, model, apiPath: cfg.api_path };
      const result = useRef && adapterImpl.generateWithReference
        ? await adapterImpl.generateWithReference(adapterCfg, req, params.referenceImagePath)
        : await adapterImpl.generate(adapterCfg, req);

      const images = [];
      for (const img of result.images) {
        const webPath = saveImageBuffer(img.buffer);
        images.push({ path: webPath, url: webPath });
      }
      if (!images.length) {
        throw Object.assign(new Error('未生成任何图片'), { code: 'EMPTY_RESPONSE' });
      }
      persistImages(db, { ...params, provider: providerKey, model }, images);
      return {
        ok: true,
        images,
        providerKey,
        fallbackUsed: providerKey !== chosen,
        error: null,
        elapsedMs: Date.now() - startTime,
        attempts
      };
    } catch (err) {
      lastError = normalizeError(err);
      attempts.push({
        provider: providerKey,
        model: cfg.default_model || '',
        error: lastError,
        elapsedMs: Date.now() - attemptStart
      });
      persistFailure(db, { ...params, provider: providerKey, model: cfg.default_model }, providerKey, lastError);
      if (tried >= maxAttempts) break;
    }
  }

  if (tried === 0) {
    // 所有候选均因无 Key 被跳过（服务商已启用但站长未配全局 Key、用户也未填自己的 Key）
    return { ok: false, error: '所选服务商未配置 API Key：请点击「添加我的 API Key」填写，或由管理员在后台配置全局 Key', providerKey: chosen, elapsedMs: Date.now() - startTime, attempts };
  }

  return { ok: false, error: lastError || '生成失败', providerKey: chosen, elapsedMs: Date.now() - startTime, attempts };
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
  if (!cfg.api_key) {
    return { ok: false, error: '请先配置 API Key 再获取模型' };
  }
  try {
    const models = await adapterImpl.fetchModels({
      apiKey: cfg.api_key,
      baseUrl: cfg.api_base,
      model: cfg.default_model,
      apiPath: cfg.api_path
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
 * 验证用户填写的 API Key 是否有效（保存后自动调用）
 * 策略：优先调 fetchModels（能返回模型列表 = Key 有效）；其次调 adapter.verify（部分平台有轻量验证接口）；
 * 都不支持则返回 verified:false（已保存但无法自动验证）
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
    if (typeof adapterImpl.fetchModels === 'function') {
      const models = await adapterImpl.fetchModels(cfg);
      if (models !== null) {
        return { ok: true, verified: true, models: Array.isArray(models) ? models : [] };
      }
    }
    if (typeof adapterImpl.verify === 'function') {
      const valid = await adapterImpl.verify(cfg);
      if (valid) {
        return { ok: true, verified: true, models: [] };
      }
    }
    return { ok: true, verified: false, error: '未能自动验证（Key 可能无效或该平台不支持自动验证），Key 已保存' };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

module.exports = {
  providers,
  getProviderConfig,
  getUserProviderKey,
  saveUserProviderKey,
  deleteUserProviderKey,
  getUserProviderKeys,
  countDailyUsage,
  generateImage,
  fetchProviderModels,
  verifyProviderKey
};
