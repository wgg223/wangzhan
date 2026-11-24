/**
 * MomoAPI（New API 网关）OpenAI 兼容生图适配器。
 * 文生图：POST {base}/v1/images/generations（JSON）
 * 图生图：POST {base}/v1/images/edits（multipart：model/prompt/image/n/size）
 * 模型发现：仅使用认证 GET /v1/models；公开价格目录不代表当前 Key 的生图能力。
 * 已通过真实 Key 确认部分生图路由只接受 Imagen；遇到该错误时自动重试认证列表中的 Imagen 模型。
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { resolveImageItem, downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE } = require('../utils');

const DEFAULT_BASE_URL = 'https://api.momoapi.icu';
const GENERATE_TIMEOUT = 120000;
const MODELS_TIMEOUT = 15000;
const IMAGEN_MODEL_PATTERN = /imagen/i;
const MODEL_CHANNEL_PATTERN = /no available channel|no channel available|无可用渠道|没有可用渠道|no available distributor/i;
const INVALID_IP_PATTERN = /invalid ip address/i;
const MODEL_COOLDOWN_MS = 2 * 60 * 1000;
const MODEL_PREFERENCE_MS = 10 * 60 * 1000;
const MAX_MODEL_RETRIES = 3;
const modelCooldowns = new Map();
const modelPreferences = new Map();

// 只保留名称明确属于图片家族的模型，不把聊天/嵌入模型误列为生图模型。
const IMAGE_MODEL_PATTERN = new RegExp([
  'gpt[-_. ]?image', 'seedream', 'image', 'flux', 'dall', 'nano[-_. ]?banana',
  'ideogram', 'imagen', 'stable[-_. ]?diffusion', 'sdxl', 'sd3', 'playground', 'recraft', 'kolors'
].join('|'), 'i');

const INTERNAL_ERROR_CODES = new Set([
  'BAD_CONFIG', 'AUTH_FAILED', 'PROVIDER_FAILED', 'FETCH_FAILED', 'TIMEOUT',
  'CANCELLED', 'EMPTY_RESPONSE', 'BAD_RESPONSE', 'INVALID_IMAGE', 'IMAGE_TOO_LARGE'
]);

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw codedError('MomoAPI 服务地址格式不正确，请填写完整的 http(s) 地址', 'BAD_CONFIG');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw codedError('MomoAPI 服务地址仅支持无账号密码、无查询参数的 http(s) 地址', 'BAD_CONFIG');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  // 同时兼容后台填写站点根地址和 OpenAI 风格 /v1 地址，避免重复拼接。
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3);
  return `${url.origin}${pathname}`;
}

function requireApiKey(cfg) {
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) throw codedError('MomoAPI 未配置 API Key', 'BAD_CONFIG');
  if (/[\r\n]/.test(apiKey)) throw codedError('MomoAPI API Key 格式不正确', 'BAD_CONFIG');
  return apiKey;
}

function requestContext(cfg) {
  return { baseUrl: normalizeBaseUrl(cfg && cfg.baseUrl), apiKey: requireApiKey(cfg) };
}

function normalizeCount(value) {
  const count = parseInt(value, 10);
  return Number.isFinite(count) ? Math.min(Math.max(count, 1), 4) : 1;
}

function isCancelled(cancelRef) {
  return Boolean(cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted)));
}

function throwIfCancelled(cancelRef) {
  if (isCancelled(cancelRef)) {
    throw codedError('任务已取消', 'CANCELLED');
  }
}

function responseDetail(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.trim().slice(0, 240);
  const error = data.error;
  const detail = data.message || (typeof error === 'string' ? error : error && error.message) || data.detail || data.msg;
  return typeof detail === 'string' ? detail.trim().slice(0, 240) : '';
}

function providerError(err, fallback) {
  if (err && INTERNAL_ERROR_CODES.has(err.code)) return err;
  if (err && (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || axios.isCancel(err))) {
    return codedError('任务已取消', 'CANCELLED');
  }
  if (err && err.response) {
    const status = err.response.status;
    const detail = responseDetail(err.response.data);
    if (/not supported model for image generation|only\s+imagen\s+models?\s+(?:are\s+)?supported/i.test(detail)) {
      return codedError(`MomoAPI 当前模型不受生图端点支持，请获取并选择当前 API Key 可用的 Imagen 生图模型${detail ? `（${detail}）` : ''}`, 'PROVIDER_FAILED');
    }
    if (status === 401 || status === 403) {
      return codedError('MomoAPI 鉴权失败：API Key 无效、已过期或无权访问该模型', 'AUTH_FAILED');
    }
    if (status === 402) return codedError('MomoAPI 账户余额不足', 'PROVIDER_FAILED');
    if (status === 429) return codedError('MomoAPI 请求过于频繁，请稍后重试', 'PROVIDER_FAILED');
    if (MODEL_CHANNEL_PATTERN.test(detail)) {
      return codedError(`MomoAPI 当前模型暂无可用的上游通道${detail ? `：${detail}` : ''}`, 'PROVIDER_FAILED');
    }
    if (INVALID_IP_PATTERN.test(detail)) {
      return codedError(`MomoAPI 图生图通道异常（${detail}）：该模型可能不支持当前图生图上传方式，请换用 gpt-image-2 等模型重试`, 'PROVIDER_FAILED');
    }
    if (status === 408 || status === 504) return codedError('MomoAPI 请求超时，请稍后重试', 'TIMEOUT');
    if ([400, 404, 422].includes(status)) {
      return codedError(`MomoAPI 拒绝请求：${detail || `HTTP ${status}`}`, 'PROVIDER_FAILED');
    }
    if (status >= 500) {
      return codedError(`MomoAPI 服务暂时不可用（HTTP ${status}）${detail ? `：${detail}` : ''}`, 'PROVIDER_FAILED');
    }
    return codedError(`MomoAPI 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, 'PROVIDER_FAILED');
  }
  if (err && err.code === 'ERR_BAD_RESPONSE' && /maxContentLength/i.test(String(err.message || ''))) {
    return codedError(`MomoAPI 返回图片超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制`, 'IMAGE_TOO_LARGE');
  }
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
    return codedError('MomoAPI 请求超时，请稍后重试', 'TIMEOUT');
  }
  if (err && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'ERR_NETWORK'].includes(err.code)) {
    return codedError('无法连接 MomoAPI，请检查网络或服务地址', 'PROVIDER_FAILED');
  }
  return codedError(`${fallback}${err && err.message ? `：${String(err.message).slice(0, 240)}` : ''}`, 'PROVIDER_FAILED');
}

function validateImage(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw codedError('MomoAPI 返回的图片数据无法读取', 'BAD_RESPONSE');
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw codedError(`MomoAPI 返回图片超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制`, 'IMAGE_TOO_LARGE');
  }
  const type = sniffImageType(buffer);
  if (!type) {
    throw codedError('MomoAPI 返回内容不是有效图片（魔数校验失败）', 'INVALID_IMAGE');
  }
  return { buffer, mime: type.mime };
}

async function resolveAndValidateImage(item, cancelRef) {
  throwIfCancelled(cancelRef);
  const signal = cancelRef && cancelRef.signal;
  let onAbort;
  const imagePromise = item && item.url
    ? downloadImageSafely(item.url, { signal })
    : resolveImageItem(item);
  let pending = imagePromise;
  if (signal) {
    pending = new Promise((resolve, reject) => {
      onAbort = () => reject(codedError('任务已取消', 'CANCELLED'));
      signal.addEventListener('abort', onAbort, { once: true });
      imagePromise.then(resolve, reject);
    });
  }
  let buffer;
  try {
    buffer = await pending;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  throwIfCancelled(cancelRef);
  return validateImage(buffer);
}

async function parseImages(data, cancelRef) {
  throwIfCancelled(cancelRef);
  const items = data && Array.isArray(data.data) ? data.data : [];
  if (!items.length) throw codedError('MomoAPI 未返回图片数据', 'EMPTY_RESPONSE');
  const images = await Promise.all(items.map((item) => resolveAndValidateImage(item, cancelRef)));
  return { images };
}

function modelId(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item.id === 'string') return item.id.trim();
  return '';
}

function uniqueModelIds(ids) {
  const seen = new Set();
  return ids.filter((id) => {
    const normalized = String(id || '').trim().slice(0, 300);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseAuthenticatedModels(data) {
  const list = data && (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null);
  if (!list) throw codedError('MomoAPI 模型列表响应格式无法识别', 'BAD_RESPONSE');
  return uniqueModelIds(list.map(modelId));
}

function filterImageModels(ids) {
  return ids.filter((id) => IMAGE_MODEL_PATTERN.test(id));
}

function selectDefaultModel(models, currentModel) {
  const list = Array.isArray(models) ? models : [];
  // 当前 Key 的 /v1/images 路由可能只开放 Imagen，即使 /v1/models 同时列出其他图片模型。
  const imagen = list.find((id) => IMAGEN_MODEL_PATTERN.test(id));
  if (imagen) return imagen;
  // 没有 Imagen 时优先 gpt-image-2 这类基础模型，避免把带渠道标记/变体名的模型设为默认。
  const ranked = list.filter((id) => !/^\[/.test(id)).sort((a, b) => fallbackScore(b) - fallbackScore(a));
  if (ranked.length) return ranked[0];
  if (currentModel && list.includes(currentModel)) return currentModel;
  return list[0] || '';
}

function cooldownKey(baseUrl, model) {
  return `${baseUrl}|${model}`;
}

function isModelCooling(baseUrl, model) {
  const key = cooldownKey(baseUrl, model);
  const until = modelCooldowns.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    modelCooldowns.delete(key);
    return false;
  }
  return true;
}

function markModelCooling(baseUrl, model) {
  if (!model) return;
  if (modelCooldowns.size > 200) {
    const now = Date.now();
    for (const [key, until] of modelCooldowns) {
      if (until <= now) modelCooldowns.delete(key);
    }
  }
  modelCooldowns.set(cooldownKey(baseUrl, model), Date.now() + MODEL_COOLDOWN_MS);
}

function preferredModel(baseUrl, model) {
  const key = cooldownKey(baseUrl, model);
  const entry = modelPreferences.get(key);
  if (!entry) return '';
  if (entry.until <= Date.now()) {
    modelPreferences.delete(key);
    return '';
  }
  return entry.model;
}

function rememberPreferredModel(baseUrl, requested, replacement) {
  if (!requested || !replacement || requested === replacement) return;
  if (modelPreferences.size > 200) {
    const now = Date.now();
    for (const [key, entry] of modelPreferences) {
      if (entry.until <= now) modelPreferences.delete(key);
    }
  }
  modelPreferences.set(cooldownKey(baseUrl, requested), {
    model: replacement,
    until: Date.now() + MODEL_PREFERENCE_MS
  });
}

function fallbackScore(id) {
  if (IMAGEN_MODEL_PATTERN.test(id)) return 100;
  if (/^gpt-image-2$/i.test(id)) return 90;
  if (/^gpt-image(?:-\d+(?:\.\d+)?)?$/i.test(id)) return 80;
  if (/flare|sunburst/i.test(id)) return 20;
  if (/gpt[-_. ]?image/i.test(id)) return 70;
  if (/nano[-_. ]?banana/i.test(id)) return 60;
  if (/gemini.*image/i.test(id)) return 50;
  if (/seedream/i.test(id)) return 40;
  if (/flux/i.test(id)) return 30;
  return 10;
}

function rankFallbackModels(models, excludedModels, baseUrl) {
  const excluded = new Set(Array.isArray(excludedModels) ? excludedModels : [excludedModels]);
  return uniqueModelIds(Array.isArray(models) ? models : [])
    .filter((id) => IMAGE_MODEL_PATTERN.test(id) && !excluded.has(id) && !isModelCooling(baseUrl, id))
    .map((id, index) => ({ id, score: fallbackScore(id), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.id);
}

async function fetchAuthenticatedImageModels(baseUrl, apiKey, signal) {
  const resp = await axios.get(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: MODELS_TIMEOUT,
    signal
  });
  return filterImageModels(parseAuthenticatedModels(resp.data));
}

function isImagenOnlyError(err) {
  if (!err || !err.response) return false;
  const detail = responseDetail(err.response.data);
  return /only\s+imagen\s+models?\s+(?:are\s+)?supported/i.test(detail);
}

function modelChannelDetail(err) {
  if (!err || !err.response) return '';
  const detail = responseDetail(err.response.data);
  return MODEL_CHANNEL_PATTERN.test(detail) ? detail : '';
}

function isModelChannelError(err) {
  return Boolean(modelChannelDetail(err));
}

function invalidIpDetail(err) {
  if (!err || !err.response) return '';
  const detail = responseDetail(err.response.data);
  return INVALID_IP_PATTERN.test(detail) ? detail : '';
}

function requireModel(cfg) {
  const model = String((cfg && cfg.model) || '').trim().slice(0, 300);
  if (!model) {
    throw codedError('MomoAPI 未选择生图模型：请获取当前 API Key 的可用模型后再试', 'BAD_CONFIG');
  }
  return model;
}

async function requestWithModelRecovery(cfg, sendRequest, cancelRef) {
  const { baseUrl, apiKey } = requestContext(cfg);
  const signal = cancelRef && cancelRef.signal;
  const requestedModel = requireModel(cfg);
  const remembered = preferredModel(baseUrl, requestedModel);
  const firstModel = remembered && !isModelCooling(baseUrl, remembered) ? remembered : requestedModel;
  try {
    const result = await sendRequest(firstModel);
    modelCooldowns.delete(cooldownKey(baseUrl, firstModel));
    if (firstModel === requestedModel) modelPreferences.delete(cooldownKey(baseUrl, requestedModel));
    const output = { ...result, model: firstModel };
    if (firstModel !== requestedModel) {
      output.modelRecovered = true;
      output.recoveredFrom = requestedModel;
    }
    return output;
  } catch (err) {
    if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
    const imagenOnly = isImagenOnlyError(err);
    const channelDetail = modelChannelDetail(err);
    const ipDetail = invalidIpDetail(err);
    if (!imagenOnly && !channelDetail && !ipDetail) throw err;
    if (channelDetail || ipDetail) markModelCooling(baseUrl, firstModel);

    // 公开 /api/pricing 已被证实可能包含不受生图路由支持的模型，恢复时只信当前 Key 的认证列表。
    let models;
    try {
      throwIfCancelled(cancelRef);
      models = await fetchAuthenticatedImageModels(baseUrl, apiKey, signal);
    } catch (listErr) {
      if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
      // 模型列表接口临时不可用时，退回后台已保存的白名单，避免明明有可用模型却直接失败。
      models = Array.isArray(cfg.models) ? cfg.models : [];
      if (!models.length) {
        throw codedError(`MomoAPI 模型「${requestedModel}」当前不可用，且无法获取当前 Key 的可用模型：${providerError(listErr, '模型列表获取失败').message}`, 'PROVIDER_FAILED');
      }
    }
    const candidates = rankFallbackModels(models, [firstModel, requestedModel], baseUrl).slice(0, MAX_MODEL_RETRIES);
    if (!candidates.length) {
      const reason = channelDetail ? '当前无可用上游通道' : ipDetail ? '当前模型的图生图通道异常' : '不受生图端点支持';
      throw codedError(`MomoAPI 模型「${requestedModel}」${reason}，当前 Key 的认证模型列表中没有可自动切换的其他图片模型；请稍后重试或更换模型`, 'PROVIDER_FAILED');
    }
    const tried = [];
    let lastError = err;
    for (const candidate of candidates) {
      throwIfCancelled(cancelRef);
      tried.push(candidate);
      try {
        const result = await sendRequest(candidate);
        modelCooldowns.delete(cooldownKey(baseUrl, candidate));
        rememberPreferredModel(baseUrl, requestedModel, candidate);
        return { ...result, model: candidate, modelRecovered: true, recoveredFrom: requestedModel };
      } catch (retryErr) {
        if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
        lastError = retryErr;
        if (isModelChannelError(retryErr) || invalidIpDetail(retryErr)) {
          markModelCooling(baseUrl, candidate);
          continue;
        }
        // 鉴权、余额、网络等非模型路由错误，继续换模型没有意义。
        throw retryErr;
      }
    }
    const lastDetail = responseDetail(lastError && lastError.response && lastError.response.data);
    const lastReason = invalidIpDetail(lastError) ? '图生图通道异常' : '暂无可用的上游通道';
    throw codedError(`MomoAPI 模型「${requestedModel}」${lastReason}，已自动尝试 ${tried.join('、')} 仍失败。请稍后重试或在模型下拉中换用其他模型${lastDetail ? `（${lastDetail}）` : ''}`, 'PROVIDER_FAILED');
  }
}

function referenceContentType(refPath) {
  const ext = path.extname(refPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

module.exports = {
  key: 'momoapi',
  authoritativeModels: true,
  selectDefaultModel,

  async generate(cfg, req) {
    try {
      throwIfCancelled(req && req.cancelRef);
      const { baseUrl, apiKey } = requestContext(cfg);
      return await requestWithModelRecovery(cfg, async (model) => {
        const body = {
          model,
          prompt: req.prompt,
          n: normalizeCount(req.n),
          size: req.size || '1024x1024'
        };
        // 不发送 response_format：网关后的模型对 url/b64_json 支持并不一致。
        const resp = await axios.post(`${baseUrl}/v1/images/generations`, body, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: GENERATE_TIMEOUT,
          signal: req.cancelRef && req.cancelRef.signal
        });
        return await parseImages(resp.data, req.cancelRef);
      }, req.cancelRef);
    } catch (err) {
      if (isCancelled(req && req.cancelRef)) throw codedError('任务已取消', 'CANCELLED');
      throw providerError(err, 'MomoAPI 文生图失败');
    }
  },

  async generateWithReference(cfg, req, refPath) {
    try {
      throwIfCancelled(req && req.cancelRef);
      const { baseUrl, apiKey } = requestContext(cfg);
      if (!refPath) throw codedError('MomoAPI 图生图缺少参考图', 'BAD_CONFIG');
      return await requestWithModelRecovery(cfg, async (model) => {
        // 每次重试都新建 FormData 和文件流，避免复用已消费的上传流。
        const form = new FormData();
        const refSize = fs.statSync(refPath).size;
        form.append('model', model);
        form.append('prompt', req.prompt);
        form.append('image', fs.createReadStream(refPath), {
          filename: path.basename(refPath),
          contentType: referenceContentType(refPath),
          knownLength: refSize
        });
        form.append('n', String(normalizeCount(req.n)));
        form.append('size', req.size || '1024x1024');
        const headers = { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() };
        // 部分网关对 chunked multipart 解析异常（如 Invalid IP address: undefined），显式带上长度更稳。
        try {
          const contentLength = form.getLengthSync();
          if (contentLength) headers['content-length'] = contentLength;
        } catch (lengthErr) {
          // 无法计算长度时仍按流式上传。
        }
        const resp = await axios.post(`${baseUrl}/v1/images/edits`, form, {
          headers,
          timeout: GENERATE_TIMEOUT,
          maxBodyLength: Infinity,
          maxContentLength: MAX_IMAGE_SIZE,
          signal: req.cancelRef && req.cancelRef.signal
        });
        return await parseImages(resp.data, req.cancelRef);
      }, req.cancelRef);
    } catch (err) {
      if (isCancelled(req && req.cancelRef)) throw codedError('任务已取消', 'CANCELLED');
      throw providerError(err, 'MomoAPI 图生图失败');
    }
  },

  async fetchModels(cfg) {
    try {
      const { baseUrl, apiKey } = requestContext(cfg);
      const models = await fetchAuthenticatedImageModels(baseUrl, apiKey);
      if (!models.length) {
        throw codedError('MomoAPI 认证模型列表未返回图片模型，请检查当前 API Key 的模型权限', 'BAD_RESPONSE');
      }
      return models;
    } catch (err) {
      throw providerError(err, 'MomoAPI 获取认证模型列表失败');
    }
  },

  // 只验证认证模型列表；公开 /api/status 和 /api/pricing 的 200 不能证明 Key 有效。
  async verify(cfg) {
    const { baseUrl, apiKey } = requestContext(cfg);
    try {
      const resp = await axios.get(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: MODELS_TIMEOUT
      });
      parseAuthenticatedModels(resp.data);
      return true;
    } catch (err) {
      throw providerError(err, 'MomoAPI API Key 验证失败');
    }
  }
};
