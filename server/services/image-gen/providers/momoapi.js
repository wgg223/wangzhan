/**
 * MomoAPI 生图适配器，提交/轮询协议对齐 TT AI 2.5.0 的 Momo 云端节点。
 * - GPT Image 文生图、Seedream 文生图/图生图：
 *   POST /v1/images/generations?async=true（JSON）→ GET /v1/images/generations/{task_id}
 * - GPT Image 图生图：POST /v1/images/edits（multipart，不异步提交）
 *   → 如有 task_id，GET /v1/images/edits/{task_id}
 * - 仅 generations 明确不支持异步时回退同步；任务失败/空结果不重复提交。
 * 模型只从认证 GET /v1/models 获取，公开价格目录不代表当前 Key 的生图能力。
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  resolveImageItem, downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE, normalizeApiBase
} = require('../utils');

const DEFAULT_BASE_URL = 'https://api.momoapi.icu';
const GENERATE_TIMEOUT = 120000;
const MODELS_TIMEOUT = 15000;
const IMAGEN_MODEL_PATTERN = /imagen/i;
const MODEL_CHANNEL_PATTERN = /no available channel|no channel available|无可用渠道|没有可用渠道|no available distributor/i;
const INVALID_IP_PATTERN = /invalid ip address/i;
const MODEL_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_MODEL_RETRIES = 3;
const BALANCE_TIMEOUT = 12000;
const BALANCE_CACHE_MS = 60 * 1000;
const modelCooldowns = new Map();
const balanceCache = new Map();

// 从计费响应里取第一个有效的数字字段（New API 会把数值放在顶层或 data 下）。
function pickNumber(data, fields) {
  if (!data || typeof data !== 'object') return null;
  const sources = [data, data.data].filter(item => item && typeof item === 'object');
  for (const source of sources) {
    for (const field of fields) {
      if (source[field] === undefined || source[field] === null || source[field] === '') continue;
      const value = Number(source[field]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

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
  return normalizeApiBase(value || DEFAULT_BASE_URL, [
    '/v1', '/v1/images/generations', '/v1/images/edits', '/v1/models',
    '/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage'
  ]);
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
  const detail = data.message || (typeof error === 'string' ? error : error && (error.message || error.code))
    || data.detail || data.msg || data.code;
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
      return codedError(`MomoAPI 当前模型不受生图端点支持，请获取并选择当前 API Key 可用的图片模型${detail ? `（${detail}）` : ''}`, 'PROVIDER_FAILED');
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
      const err = codedError('MomoAPI 图生图被网关拒绝（Invalid IP address: undefined）：该尺寸或模型通道可能不支持', 'PROVIDER_FAILED');
      // 让上层按 4K→2K→1K 自动降级重试：Momo 的 4K 通道会以这个错误拒绝，
      // 1K/2K 通常正常，靠降级能直接拿到可用结果。
      err.sizeFallback = true;
      return err;
    }
    if (status === 408 || status === 504) return codedError('MomoAPI 请求超时，请稍后重试', 'TIMEOUT');
    if ([400, 404, 422].includes(status)) {
      return codedError(`MomoAPI 拒绝请求（HTTP ${status}）：${detail || '服务商未返回错误说明'}`, 'PROVIDER_FAILED');
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
  const items = imageItems(data);
  if (!items.length) throw codedError(`MomoAPI 未返回图片数据（${describeShape(data)}）`, 'EMPTY_RESPONSE');
  const images = await Promise.all(items.map((item) => resolveAndValidateImage(item, cancelRef)));
  return { images };
}

// TT AI 的结果提取器兼容多种网关包装；这里归一化为 url/b64_json，再统一做安全下载和魔数校验。
const IMAGE_URL_FIELDS = ['url', 'uri', 'file_uri', 'image_url', 'object_url', 'download_url', 'downloadUrl'];
const IMAGE_BASE64_FIELDS = ['b64_json', 'b64_image', 'b64', 'image_base64', 'imageBase64'];
const IMAGE_WRAPPER_FIELDS = ['data', 'results', 'images', 'list', 'content', 'parts', 'candidates', 'output', 'result'];

function normalizeImageNode(value, depth) {
  if (depth > 6) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^data:image\//i.test(text)) {
      const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(text);
      return match ? [{ b64_json: match[1] }] : [];
    }
    return /^https?:\/\//i.test(text) ? [{ url: text }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeImageNode(item, depth + 1));
  }
  for (const key of IMAGE_URL_FIELDS) {
    if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key].trim())) {
      return [{ url: value[key].trim() }];
    }
  }
  for (const key of IMAGE_BASE64_FIELDS) {
    if (typeof value[key] === 'string' && value[key].trim()) return [{ b64_json: value[key].trim() }];
  }
  const inline = value.inlineData || value.inline_data;
  if (inline && typeof inline.data === 'string' && inline.data) return [{ b64_json: inline.data }];
  const file = value.fileData || value.file_data;
  if (file && typeof file.fileUri === 'string' && /^https?:\/\//i.test(file.fileUri)) return [{ url: file.fileUri }];
  if (file && typeof file.file_uri === 'string' && /^https?:\/\//i.test(file.file_uri)) return [{ url: file.file_uri }];
  for (const key of IMAGE_WRAPPER_FIELDS.concat('image')) {
    if (value[key] !== undefined) {
      const items = normalizeImageNode(value[key], depth + 1);
      if (items.length) return items;
    }
  }
  return [];
}

function imageItems(data) {
  const seen = new Set();
  return normalizeImageNode(data, 0).filter((item) => {
    const key = item.url || item.b64_json;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

// 与 TT AI extractMomoTaskId 的字段顺序一致，不把图片列表中的普通 id 误当任务 id。
function extractTaskId(data) {
  const roots = [data, data && data.data];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const key of ['task_id', 'taskId', 'id']) {
      const value = root[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return '';
}

function describeShape(data) {
  if (!data || typeof data !== 'object') return `type=${typeof data}`;
  const keys = Object.keys(data).slice(0, 8).join(',');
  const dataType = Array.isArray(data.data) ? 'array' : typeof data.data;
  let itemKeys = '';
  if (Array.isArray(data.data) && data.data[0] && typeof data.data[0] === 'object') {
    itemKeys = Object.keys(data.data[0]).slice(0, 6).join(',');
  }
  return `keys=${keys} data=${dataType}${itemKeys ? ` itemKeys=${itemKeys}` : ''}`;
}

const TASK_POLL_INTERVAL = 3000;
const TASK_MAX_POLLS = 160; // 约 8 分钟

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(codedError('任务已取消', 'CANCELLED'));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(codedError('任务已取消', 'CANCELLED'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// TT AI 仅在异步提交接口明确不可用时回退；模型错误、任务失败、空结果均不重复提交。
function isAsyncUnsupportedError(err) {
  if (!err) return false;
  const status = err.response && err.response.status;
  const detail = responseDetail(err.response && err.response.data);
  const text = `${err.message || ''} ${detail}`;
  if (/async.*(?:unsupported|not support)|unsupported.*async|不支持.*异步/i.test(text)) return true;
  if (status === 405) return true;
  return status === 404 && !/model|模型/i.test(text);
}

function taskStatus(data) {
  const roots = [data, data && data.data];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    const value = root.status || root.task_status;
    if (value !== undefined && value !== null && value !== '') return String(value).toUpperCase();
  }
  return '';
}

function taskFailure(data, taskId = '') {
  const status = taskStatus(data);
  const error = data && data.error;
  const detail = responseDetail(data);
  if (!error && !/^(?:FAILED|FAIL|CANCELED|CANCELLED|ERROR|FAILURE)$/.test(status)) return null;
  const err = codedError(`MomoAPI 异步任务失败${taskId ? `（task_id: ${taskId}）` : ''}：${detail || status || '任务执行失败'}`, 'PROVIDER_FAILED');
  if (taskId) err.taskId = taskId;
  return err;
}

// 提交类型决定轮询路由：generations 绝不查询 edits，edits 也绝不查询 generations/tasks。
async function pollImageTask(baseUrl, apiKey, taskId, cancelRef, endpointType) {
  if (!['generations', 'edits'].includes(endpointType)) {
    throw codedError('MomoAPI 异步任务类型无法识别', 'BAD_RESPONSE');
  }
  const path = `/v1/images/${endpointType}/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < TASK_MAX_POLLS; i++) {
    throwIfCancelled(cancelRef);
    await sleep(TASK_POLL_INTERVAL, cancelRef && cancelRef.signal);
    throwIfCancelled(cancelRef);
    let resp;
    try {
      resp = await axios.get(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30000,
        signal: cancelRef && cancelRef.signal
      });
    } catch (err) {
      const failure = providerError(err, 'MomoAPI 异步任务查询失败');
      failure.fromPoll = true;
      failure.taskId = taskId;
      if (failure.code !== 'CANCELLED' && !failure.message.includes(taskId)) {
        failure.message += `（task_id: ${taskId}）`;
      }
      throw failure;
    }
    const data = resp.data || {};
    if (imageItems(data).length) return data;
    const failure = taskFailure(data, taskId);
    if (failure) {
      failure.fromPoll = true;
      failure.taskId = taskId;
      throw failure;
    }
    if (/^(?:SUCCESS|SUCCEEDED|COMPLETED|DONE)$/.test(taskStatus(data))) {
      const err = codedError(`MomoAPI 异步任务完成但没有图片（${describeShape(data)}）（task_id: ${taskId}）`, 'EMPTY_RESPONSE');
      err.fromPoll = true;
      err.taskId = taskId;
      throw err;
    }
  }
  const timeoutErr = codedError(`MomoAPI 异步任务超时（task_id: ${taskId}）`, 'TIMEOUT');
  timeoutErr.fromPoll = true;
  timeoutErr.taskId = taskId;
  throw timeoutErr;
}

// 提交后统一处理：有图直接返回；返回了任务 id 就走对应类型的异步轮询。
async function parseOrPoll(data, baseUrl, apiKey, cancelRef, endpointType) {
  if (imageItems(data).length) return parseImages(data, cancelRef);
  const taskId = extractTaskId(data);
  const failure = taskFailure(data, taskId);
  if (failure) throw failure;
  if (!taskId) {
    throw codedError(`MomoAPI 未返回图片数据或任务 ID（${describeShape(data)}）`, 'EMPTY_RESPONSE');
  }
  const taskData = await pollImageTask(baseUrl, apiKey, taskId, cancelRef, endpointType);
  return parseImages(taskData, cancelRef);
}

// 仅捕获异步 POST 本身的“不支持”错误；进入轮询后任何失败都原样抛出，避免重复计费。
async function submitGenerations(send, baseUrl, apiKey, cancelRef) {
  let data;
  try {
    const resp = await send('/v1/images/generations?async=true');
    data = resp.data;
  } catch (err) {
    if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
    if (!isAsyncUnsupportedError(err)) throw err;
    const resp = await send('/v1/images/generations');
    data = resp.data;
  }
  return parseOrPoll(data, baseUrl, apiKey, cancelRef, 'generations');
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
  // 重置旧的 Imagen 优先策略；用户已选的其他有效模型仍保留。
  if (currentModel && list.includes(currentModel) && !IMAGEN_MODEL_PATTERN.test(currentModel)) return currentModel;
  // TT AI 默认云端模型是 gpt-image-2；未开放时使用控制台同样支持异步任务的 Seedream 5.5。
  const gptImage2 = list.find((id) => /^gpt-image-2$/i.test(id));
  if (gptImage2) return gptImage2;
  const seedream = list.find((id) => /^seedream-5\.5$/i.test(id));
  if (seedream) return seedream;
  const ranked = list.filter((id) => !/^\[/.test(id)).sort((a, b) => fallbackScore(b) - fallbackScore(a));
  if (ranked.length) return ranked[0];
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

function fallbackScore(id) {
  if (/^gpt-image-2$/i.test(id)) return 100;
  if (/^seedream-5\.5$/i.test(id)) return 95;
  if (/^gpt-image(?:-\d+(?:\.\d+)?)?$/i.test(id)) return 90;
  if (/flare|sunburst/i.test(id)) return 20;
  if (/gpt[-_. ]?image/i.test(id)) return 80;
  if (/nano[-_. ]?banana/i.test(id)) return 70;
  if (/gemini.*image/i.test(id)) return 60;
  if (/seedream/i.test(id)) return 50;
  if (/flux/i.test(id)) return 30;
  if (IMAGEN_MODEL_PATTERN.test(id)) return 10;
  return 5;
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
  return /not supported model for image generation|only\s+imagen\s+models?\s+(?:are\s+)?supported/i.test(detail);
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
  // 永远先打用户选中的模型；只有本次请求内部失败时才会临时换模型重试，
  // 不再跨请求记住替代模型（否则会出现「换了模型还用上一个」）。
  const firstModel = requestedModel;
  try {
    const result = await sendRequest(firstModel);
    modelCooldowns.delete(cooldownKey(baseUrl, firstModel));
    const output = { ...result, model: firstModel };
    if (firstModel !== requestedModel) {
      output.modelRecovered = true;
      output.recoveredFrom = requestedModel;
    }
    return output;
  } catch (err) {
    if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
    // 已提交并计费的任务进入轮询后，任何失败都不允许换模型重新提交。
    if (err && err.fromPoll) throw err;
    const unsupportedModel = isImagenOnlyError(err);
    const channelDetail = modelChannelDetail(err);
    const ipDetail = invalidIpDetail(err);
    // Invalid IP 多半是 4K 尺寸被网关拒绝：直接交给上层做「4K→2K→1K」降级，
    // 不要先浪费 3 次换模型重试（换模型同样会因为这个尺寸失败）。
    if (ipDetail) throw providerError(err, 'MomoAPI 图生图失败');
    if (!unsupportedModel && !channelDetail) throw err;
    if (channelDetail) markModelCooling(baseUrl, firstModel);

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
        return { ...result, model: candidate, modelRecovered: true, recoveredFrom: requestedModel };
      } catch (retryErr) {
        if (isCancelled(cancelRef)) throw codedError('任务已取消', 'CANCELLED');
        lastError = retryErr;
        if (isModelChannelError(retryErr) || invalidIpDetail(retryErr) || isImagenOnlyError(retryErr)) {
          markModelCooling(baseUrl, candidate);
          continue;
        }
        // 鉴权、余额、网络等非模型路由错误，继续换模型没有意义。
        throw retryErr;
      }
    }
    const lastDetail = responseDetail(lastError && lastError.response && lastError.response.data);
    const lastReason = invalidIpDetail(lastError) ? '图生图通道异常'
      : isImagenOnlyError(lastError) ? '不受生图端点支持' : '暂无可用的上游通道';
    throw codedError(`MomoAPI 模型「${requestedModel}」${lastReason}，已自动尝试 ${tried.join('、')} 仍失败。请稍后重试或在模型下拉中换用其他模型${lastDetail ? `（${lastDetail}）` : ''}`, 'PROVIDER_FAILED');
  }
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.tiff': 'image/tiff'
};

function referenceContentType(refPath, buffer) {
  const sniffed = buffer ? sniffImageType(buffer) : null;
  if (sniffed) return sniffed.mime;
  return MIME_BY_EXT[path.extname(String(refPath || '')).toLowerCase()] || 'image/png';
}

/**
 * 构造图生图 multipart 请求体（Buffer，而不是 stream）。
 *
 * 关键：New API 网关对 chunked 编码的 multipart 解析不稳定，会返回
 * “Invalid IP address: undefined”。用 Buffer 发送时 axios 会自带 Content-Length，
 * 不会再出现 Transfer-Encoding: chunked，和 TTAI 插件“先固定长度再上传”的做法一致。
 *
 * @param {string} refPath 参考图绝对路径
 * @param {Object} fields 普通表单字段
 * @returns {Promise<{body: Buffer, contentType: string, length: number}>}
 */
async function buildEditsRequest(refPath, fields) {
  const buffer = await fs.promises.readFile(refPath);
  if (!buffer.length) throw codedError('MomoAPI 参考图为空', 'INVALID_IMAGE');
  if (buffer.length > MAX_IMAGE_SIZE) throw codedError('MomoAPI 参考图超过大小限制', 'IMAGE_TOO_LARGE');
  const boundary = `----momo${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  Object.keys(fields).forEach((name) => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') return;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  });
  const filename = path.basename(refPath).replace(/["\r\n]/g, '_');
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${filename}"\r\n`
    + `Content-Type: ${referenceContentType(refPath, buffer)}\r\n\r\n`, 'utf8'));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, length: body.length };
}

const SEEDREAM_MODEL_PATTERN = /seedream/i;

// TT AI 的 Seedream 画质后缀只用于本地分组，API 统一提交 seedream-5.5。
function getMomoSeedreamConfig(model) {
  const match = /^seedream-5\.5(?:__(1k|1\.5k|2k))?$/i.exec(String(model || '').trim());
  return match ? { apiModel: 'seedream-5.5', quality: match[1] ? match[1].toUpperCase() : '' } : null;
}

// 原样提交认证模型列表中的模型 ID；不根据尺寸臆造渠道后缀，避免被网关判为不支持。
function resolveApiModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return raw;
  // 直接使用 Key 的 /v1/models 里返回的模型名：Momo 的网关只认这些 id，
  // 擅自加 -4k / ratio_4k 这类后缀会被判成「模型不支持」。画质由 size/quality 控制。
  return raw;
}

function normalizeQuality(value) {
  const quality = String(value || 'auto').toLowerCase();
  return ['low', 'medium', 'high', 'auto'].includes(quality) ? quality : 'auto';
}

function addGptImageBackground(body, model, req) {
  const background = String((req && req.background) || 'auto').toLowerCase();
  if (!['auto', 'transparent', 'opaque'].includes(background)) return;
  if (/^gpt-image-2\.[56]-(?:flare|sunburst)$/i.test(model)) body.background = background;
}

/**
 * Seedream 在 Momo 上走「generations JSON + image dataURL」，与 gpt-image 的
 * multipart edits 不同（插件 buildMomoSeedreamRequest 同款）：
 * { model, prompt, n:1, response_format:'url', output_format:'png', background:'auto', size?, image? }
 */
async function buildSeedreamBody(model, req, refPaths, preferredQuality) {
  const outputFormat = String((req && (req.output_format || req.outputFormat)) || 'png').toLowerCase();
  if (!['png', 'jpeg'].includes(outputFormat)) throw codedError('MomoAPI Seedream 仅支持 PNG/JPEG 输出', 'BAD_CONFIG');
  const background = String((req && req.background) || 'auto').toLowerCase();
  if (!['auto', 'transparent', 'opaque'].includes(background)) throw codedError('MomoAPI Seedream 背景参数无效', 'BAD_CONFIG');
  if (background === 'transparent' && outputFormat !== 'png') {
    throw codedError('MomoAPI Seedream 透明背景仅支持 PNG', 'BAD_CONFIG');
  }
  const sizeMatch = /^\s*(\d{1,5})[x*](\d{1,5})\s*$/i.exec(String((req && req.size) || ''));
  const longEdge = sizeMatch ? Math.max(Number(sizeMatch[1]), Number(sizeMatch[2])) : 0;
  const inferredQuality = longEdge && longEdge <= 1024 ? '1K' : longEdge && longEdge <= 1536 ? '1.5K' : '2K';
  const quality = String(preferredQuality || (req && req.quality) || inferredQuality).toUpperCase();
  if (!['1K', '1.5K', '2K'].includes(quality)) throw codedError('MomoAPI Seedream 仅支持 1K/1.5K/2K 画质', 'BAD_CONFIG');
  const body = {
    model,
    prompt: req.prompt,
    n: 1,
    response_format: 'url',
    output_format: outputFormat,
    background
  };
  const refs = Array.isArray(refPaths) ? refPaths : [];
  // TT AI：固定比例时 API 用画质关键词；2K 带参考图则省略 size，避免网关 Invalid IP。
  // ratio=auto 同样省略 size，由模型根据参考图决定输出比例。
  if (req.aspectRatio && !(refs.length && quality === '2K')) body.size = quality;
  if (refs.length) {
    const images = [];
    for (const refPath of refs) {
      const buffer = await fs.promises.readFile(refPath);
      if (!buffer.length) throw codedError('MomoAPI Seedream 参考图为空', 'INVALID_IMAGE');
      if (buffer.length > MAX_IMAGE_SIZE) throw codedError('MomoAPI Seedream 参考图超过大小限制', 'IMAGE_TOO_LARGE');
      const type = sniffImageType(buffer);
      if (!type) throw codedError('MomoAPI Seedream 参考图不是有效图片', 'INVALID_IMAGE');
      images.push(`data:${type.mime};base64,${buffer.toString('base64')}`);
    }
    body.image = images.length === 1 ? images[0] : images;
  }
  return body;
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
        const seedreamConfig = getMomoSeedreamConfig(model);
        const apiModel = seedreamConfig ? seedreamConfig.apiModel : resolveApiModel(model);
        const body = SEEDREAM_MODEL_PATTERN.test(apiModel)
          ? await buildSeedreamBody(apiModel, req, [], seedreamConfig && seedreamConfig.quality)
          : {
            model: apiModel,
            prompt: req.prompt,
            n: 1,
            size: req.size || '1024x1024',
            // 与 TT AI 一致：gpt-image 系列带 quality（low/medium/high/auto）。
            quality: normalizeQuality(req.quality)
          };
        if (!SEEDREAM_MODEL_PATTERN.test(apiModel)) addGptImageBackground(body, apiModel, req);
        const send = (path) => axios.post(`${baseUrl}${path}`, body, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: GENERATE_TIMEOUT,
          signal: req.cancelRef && req.cancelRef.signal
        });
        return submitGenerations(send, baseUrl, apiKey, req.cancelRef);
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
        const seedreamConfig = getMomoSeedreamConfig(model);
        const apiModel = seedreamConfig ? seedreamConfig.apiModel : resolveApiModel(model);
        // Seedream：generations JSON + image dataURL（与 gpt-image 的 edits multipart 不同）
        if (SEEDREAM_MODEL_PATTERN.test(apiModel)) {
          const body = await buildSeedreamBody(apiModel, req, [refPath], seedreamConfig && seedreamConfig.quality);
          const send = (path) => axios.post(`${baseUrl}${path}`, body, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: GENERATE_TIMEOUT,
            maxBodyLength: Infinity,
            signal: req.cancelRef && req.cancelRef.signal
          });
          return submitGenerations(send, baseUrl, apiKey, req.cancelRef);
        }
        // 每次重试重建 body（模型名会变）；Buffer 可安全复用，不会像流一样被消费掉。
        const fields = {
          model: apiModel,
          prompt: req.prompt,
          size: req.size || '1024x1024',
          quality: normalizeQuality(req.quality)
        };
        addGptImageBackground(fields, apiModel, req);
        const form = await buildEditsRequest(refPath, fields);
        const send = (path) => axios.post(`${baseUrl}${path}`, form.body, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': form.contentType,
            'Content-Length': String(form.length)
          },
          timeout: GENERATE_TIMEOUT,
          maxBodyLength: Infinity,
          maxContentLength: MAX_IMAGE_SIZE,
          // 原样发送 Buffer，禁止 axios 再转换请求体（否则可能退回 chunked）
          transformRequest: [(data) => data],
          signal: req.cancelRef && req.cancelRef.signal
        });
        // TT AI 的 GPT Image 图生图直接同步提交，绝不附加 ?async=true。
        const resp = await send('/v1/images/edits');
        return parseOrPoll(resp.data, baseUrl, apiKey, req.cancelRef, 'edits');
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
  },

  /**
   * 余额查询（New API / One API 计费接口）：
   *   GET /v1/dashboard/billing/subscription → hard_limit_usd（总额度，美元）
   *   GET /v1/dashboard/billing/usage        → total_usage（已用，单位“分”）
   * 剩余 = subscription - usage/100；接口不存在的站点返回 null，不影响生图。
   * 同一 Key 60 秒内复用结果，避免保存/查询/页面刷新重复打网关。
   * @param {Object} cfg
   * @returns {Promise<null|{amount: number, used: number, total: number, currency: string, label: string}>}
   */
  async fetchBalance(cfg) {
    const { baseUrl, apiKey } = requestContext(cfg);
    const cacheKey = `${baseUrl}|${apiKey.slice(-8)}`;
    const cached = balanceCache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;
    const headers = { Authorization: `Bearer ${apiKey}` };
    const now = new Date();
    const startDate = '2000-01-01';
    const endDate = now.toISOString().slice(0, 10);
    let total = null;
    let used = null;
    try {
      const resp = await axios.get(`${baseUrl}/v1/dashboard/billing/subscription`, {
        headers, timeout: BALANCE_TIMEOUT
      });
      total = pickNumber(resp.data, ['hard_limit_usd', 'system_hard_limit_usd', 'soft_limit_usd']);
    } catch (err) {
      if (err && err.response && (err.response.status === 401 || err.response.status === 403)) {
        throw codedError('MomoAPI 余额查询鉴权失败：API Key 无效或无权访问计费接口', 'AUTH_FAILED');
      }
    }
    try {
      const resp = await axios.get(`${baseUrl}/v1/dashboard/billing/usage`, {
        headers, params: { start_date: startDate, end_date: endDate }, timeout: BALANCE_TIMEOUT
      });
      const cents = pickNumber(resp.data, ['total_usage']);
      if (cents !== null) used = cents / 100;
    } catch (err) {
      // 计费用量接口缺失时只展示总额度。
    }
    let value = null;
    if (total !== null) {
      // 没有 usage 接口时无法算剩余，只展示总额度，避免把“总额度”误当“余额”。
      const amount = used !== null ? Math.max(total - used, 0) : total;
      value = {
        amount,
        used,
        total,
        currency: 'USD',
        label: used === null ? `额度 $${total.toFixed(2)}` : `$${amount.toFixed(2)} / $${total.toFixed(2)}`
      };
    }
    if (!value) {
      // 兼容只实现 OpenAI 计费端点的网关（credit_grants / subscription）。
      try {
        value = await require('./openai_compat').fetchBalance({ apiKey, baseUrl });
      } catch (err) {
        value = null;
      }
    }
    balanceCache.set(cacheKey, { value, until: Date.now() + BALANCE_CACHE_MS });
    if (balanceCache.size > 100) {
      const stamp = Date.now();
      for (const [key, entry] of balanceCache) {
        if (entry.until <= stamp) balanceCache.delete(key);
      }
    }
    return value;
  }
};
