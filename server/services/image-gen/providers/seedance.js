/**
 * Seedance（新贞贞）异步图片生成适配器
 * 协议按 TT AI 2.5.0 的 new_zhenzhen 链路实现：
 * ① POST {base}/v1/image/generations 提交 Seedream 5.5 任务
 * ② GET  {base}/v1/image/generations/{task_id} 轮询，读取 data.data.result_url
 * ③ 图生图先将参考图上传至 /v1/files/upload，再把 HTTPS URL 放入 images
 * ④ 验证与余额读取 /api/usage/wallet/，不上传测试图、不发起计费生成
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  apiUrl, normalizeApiBase, downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE
} = require('../utils');

const DEFAULT_BASE_URL = 'https://api.seedance.nz';
const DEFAULT_MODEL = 'seedream-v5.5__2k';
const MODEL_IDS = ['seedream-v5.5__2k', 'seedream-v5.5__1.5k', 'seedream-v5.5__1k'];
const QUALITY_EDGES = { '1K': 1024, '1.5K': 1536, '2K': 2048 };
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
const REFERENCE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_REFERENCES = 10;
const MAX_REFERENCE_SIZE = 10 * 1024 * 1024;
const MAX_POLLS = 200; // 200 * 3s = 600s
const POLL_INTERVAL = 3000;

function makeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function cancelledError() {
  return makeError('Seedance 任务已取消', 'CANCELLED');
}

function taskError(message, code, taskId) {
  const err = makeError(`Seedance 任务失败${taskId ? `（task_id: ${taskId}）` : ''}：${message}`, code);
  // 提交后可能已经计费，通用层不得因错误文案含 size/resolution 而再次提交。
  err.fromPoll = true;
  err.taskId = taskId;
  return err;
}

function responseDetail(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 500);
  const detail = data.message || (data.error && (data.error.message || data.error)) || data.detail;
  return detail ? String(detail).slice(0, 500) : '';
}

function getBaseUrl(cfg) {
  return normalizeApiBase((cfg && cfg.baseUrl) || DEFAULT_BASE_URL, [
    '/v1/image/generations', '/v1/files/upload', '/api/usage/wallet'
  ]);
}

function getHeaders(cfg) {
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) throw makeError('Seedance 未配置 API Key', 'BAD_CONFIG');
  return { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'wangzhan-ai-image/1.0' };
}

function throwIfCancelled(req) {
  const cancelRef = req && req.cancelRef;
  if ((cancelRef && cancelRef.cancelled) || (cancelRef && cancelRef.signal && cancelRef.signal.aborted)) {
    throw cancelledError();
  }
}

function rethrowIfCancelled(req, err) {
  const cancelRef = req && req.cancelRef;
  if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
      err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
    throw cancelledError();
  }
  throw err;
}

// 轮询等待也监听 AbortSignal，避免取消后还要等满一个轮询周期。
function waitForPoll(req) {
  throwIfCancelled(req);
  const signal = req && req.cancelRef && req.cancelRef.signal;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(cancelledError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, POLL_INTERVAL);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 兼容后台保存的 v5.5-t2i/v5.5-i2i、TT 风格 __画质 分组和旧 v5-pro 默认值。
 * 只有精确匹配的旧官方 ID 才升级，管理员自定义模型不会被悄悄替换。
 */
function parseModel(value, withReference) {
  const configured = String(value || '').trim() || DEFAULT_MODEL;
  const legacy = /^seedream-v5-pro-(?:t2i|i2i)$/i.test(configured);
  const match = /^([^_]+?)(?:__(1k|1\.5k|2k|4k))?$/i.exec(configured);
  if (!match) throw makeError('Seedance 仅支持 Seedream 5.5 模型', 'BAD_CONFIG');
  let base = match[1];
  if (legacy || /^seedream-v5\.5-(?:t2i|i2i)$/i.test(base)) base = 'seedream-v5.5';
  if (!/^seedream-v5\.5$/i.test(base)) {
    throw makeError(`Seedance 暂不支持模型「${configured}」，请选择 Seedream 5.5`, 'BAD_CONFIG');
  }
  const qualityFromSuffix = Boolean(match[2]);
  const quality = (match[2] || '2K').toUpperCase();
  if (!QUALITY_EDGES[quality]) {
    throw makeError('Seedream 5.5 仅支持 1K、1.5K、2K，不支持 4K', 'BAD_CONFIG');
  }
  const apiModel = `seedream-v5.5-${withReference ? 'i2i' : 't2i'}`;
  return { configured, quality, qualityFromSuffix, apiModel };
}

function normalizeQuality(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\s/g, '');
  if (!text) return '';
  if (!QUALITY_EDGES[text]) throw makeError('Seedream 5.5 仅支持 1K、1.5K、2K 画质', 'BAD_CONFIG');
  return text;
}

function normalizeRatio(req) {
  const requested = String((req && req.aspectRatio) || 'auto').trim().toLowerCase();
  if (requested === 'auto') return 'auto';
  if (RATIOS.includes(requested)) return requested;
  // 网站共用尺寸表含 5:4 / 21:9 等档位，Seedream 不接受；选最接近的 TT 合法比例。
  const match = String((req && req.size) || '').match(/^(\d{1,4})[x*](\d{1,4})$/i);
  if (!match) throw makeError(`Seedream 5.5 不支持比例「${requested}」`, 'BAD_CONFIG');
  const ratio = Number(match[1]) / Number(match[2]);
  return RATIOS.reduce((best, item) => {
    const pair = item.split(':').map(Number);
    const score = Math.abs(Math.log((pair[0] / pair[1]) / ratio));
    return score < best.score ? { item, score } : best;
  }, { item: '', score: Infinity }).item;
}

// TT AI 的 Seedream 尺寸算法：先按目标面积求边，再约束最短边 >=1024、最长边 <=2048。
function getDimensions(quality, ratio) {
  const [rw, rh] = ratio.split(':').map(Number);
  const edge = QUALITY_EDGES[quality];
  let width = edge * Math.sqrt(rw / rh);
  let height = edge / Math.sqrt(rw / rh);
  const scale = Math.max(1024 / Math.min(width, height), Math.min(1, 2048 / Math.max(width, height)));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function buildMetadata(req, quality, ratio, withReference) {
  const outputFormat = String((req && (req.output_format || req.outputFormat)) || 'png').toLowerCase();
  const background = String((req && req.background) || 'auto').toLowerCase();
  if (outputFormat !== 'png' && outputFormat !== 'jpeg') {
    throw makeError('Seedream 5.5 的输出格式仅支持 png / jpeg', 'BAD_CONFIG');
  }
  if (!['auto', 'transparent', 'opaque'].includes(background)) {
    throw makeError('Seedream 5.5 的背景仅支持 auto / transparent / opaque', 'BAD_CONFIG');
  }
  if (background === 'transparent' && outputFormat !== 'png') {
    throw makeError('Seedream 5.5 的透明背景仅支持 PNG', 'BAD_CONFIG');
  }
  const metadata = { output_format: outputFormat, background };
  // Seedance 现行协议中 resolution 优先于并忽略 width/height，二者必须互斥。
  // 固定比例只传精确宽高；auto 才用画质档位，2K 图生图 auto 保持模型自适应。
  if (ratio !== 'auto') {
    Object.assign(metadata, getDimensions(quality, ratio));
  } else if (!withReference || quality !== '2K') {
    metadata.resolution = quality.toLowerCase();
  }
  return metadata;
}

// 单文件 multipart 直接构造 Buffer，避免为上传接口新增 form-data 依赖。
function buildUploadBody(buffer, filename) {
  const boundary = `----seedance${crypto.randomBytes(12).toString('hex')}`;
  const safeName = path.basename(filename).replace(/["\r\n]/g, '_');
  const type = sniffImageType(buffer);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: ${type ? type.mime : 'application/octet-stream'}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function isValidHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) || value.includes('\\')) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) return false;
  }
  try {
    const parsed = new URL(value);
    return Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch (err) {
    return false;
  }
}

async function uploadImage(cfg, req, buffer, filename) {
  throwIfCancelled(req);
  const form = buildUploadBody(buffer, filename);
  const signal = req && req.cancelRef && req.cancelRef.signal;
  let resp;
  try {
    resp = await axios.post(apiUrl(getBaseUrl(cfg), '/v1/files/upload'), form.body, {
      headers: { ...getHeaders(cfg), 'Content-Type': form.contentType },
      timeout: 60000,
      maxBodyLength: MAX_REFERENCE_SIZE + 64 * 1024,
      signal
    });
  } catch (err) {
    const cancelRef = req && req.cancelRef;
    if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
        err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
      throw cancelledError();
    }
    const status = err.response && err.response.status;
    const detail = responseDetail(err.response && err.response.data);
    throw makeError(`Seedance 参考图上传失败${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : ''}`,
      status === 401 || status === 403 ? 'AUTH_FAILED' : 'PROVIDER_FAILED');
  }
  throwIfCancelled(req);
  const data = resp.data || {};
  const businessError = envelopeError(data);
  if (businessError) throw makeError(`Seedance 参考图上传失败：${businessError}`, 'PROVIDER_FAILED');
  if (!isValidHttpsUrl(data.url) || data.file_type !== 'image') {
    throw makeError('Seedance 参考图上传成功但未返回有效的 HTTPS 图片地址', 'BAD_RESPONSE');
  }
  return data.url;
}

async function readReference(refPath, req) {
  throwIfCancelled(req);
  let buffer;
  try {
    buffer = await fs.promises.readFile(refPath);
  } catch (err) {
    rethrowIfCancelled(req, err);
  }
  throwIfCancelled(req);
  if (!buffer.length || buffer.length > MAX_REFERENCE_SIZE) {
    throw makeError('Seedance 参考图为空或超过 10MB 限制', buffer.length ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE');
  }
  const type = sniffImageType(buffer);
  if (!type || !REFERENCE_MIMES.has(type.mime)) {
    throw makeError('Seedance 参考图仅支持 JPEG、PNG、WebP', 'INVALID_IMAGE');
  }
  return buffer;
}

function envelopeError(data) {
  if (!data || typeof data !== 'object') return '';
  const unexpectedCode = data.code !== undefined && data.code !== null && data.code !== true && data.code !== 'success';
  if (unexpectedCode || data.error) return responseDetail(data) || '服务商返回业务失败';
  return '';
}

async function submitTask(cfg, req, body) {
  throwIfCancelled(req);
  let resp;
  try {
    resp = await axios.post(apiUrl(getBaseUrl(cfg), '/v1/image/generations'), body, {
      headers: { ...getHeaders(cfg), 'Content-Type': 'application/json' },
      timeout: 60000,
      signal: req && req.cancelRef && req.cancelRef.signal
    });
  } catch (err) {
    const cancelRef = req && req.cancelRef;
    if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
        err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
      throw cancelledError();
    }
    const status = err.response && err.response.status;
    const detail = responseDetail(err.response && err.response.data);
    throw makeError(`Seedance 提交任务失败${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : ''}`,
      status === 401 || status === 403 ? 'AUTH_FAILED' : 'PROVIDER_FAILED');
  }
  throwIfCancelled(req);
  const data = resp.data || {};
  const businessError = envelopeError(data);
  if (businessError) throw makeError(`Seedance 提交任务失败：${businessError}`, 'PROVIDER_FAILED');
  // TT AI 使用顶层 task_id/id；错误解析嵌套 data 可能把失败响应当成有效任务。
  const rawId = data.task_id !== undefined ? data.task_id : data.id;
  const taskId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw makeError('Seedance 未返回有效任务编号，请先核对平台记录，避免重复付费', 'BAD_RESPONSE');
  }
  if (req.taskInfo) req.taskInfo.taskId = taskId;
  return taskId;
}

async function pollTask(cfg, req, taskId) {
  const url = apiUrl(getBaseUrl(cfg), `/v1/image/generations/${encodeURIComponent(taskId)}`);
  for (let i = 0; i < MAX_POLLS; i++) {
    throwIfCancelled(req);
    await waitForPoll(req);
    throwIfCancelled(req);
    let resp;
    try {
      resp = await axios.get(url, {
        headers: getHeaders(cfg),
        timeout: 30000,
        signal: req && req.cancelRef && req.cancelRef.signal
      });
    } catch (err) {
      const cancelRef = req && req.cancelRef;
      if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
          err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
        throw cancelledError();
      }
      const status = err.response && err.response.status;
      // 鉴权和任务不存在不会因重试恢复；限流、网络及服务端错误才继续轮询。
      if (status === 401 || status === 403) {
        throw taskError('API Key 无效或无权查询任务', 'AUTH_FAILED', taskId);
      }
      if (status === 400 || status === 404 || status === 422) {
        const detail = responseDetail(err.response && err.response.data);
        throw taskError(`查询任务失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, 'PROVIDER_FAILED', taskId);
      }
      continue;
    }
    const data = resp.data || {};
    const businessError = envelopeError(data);
    if (businessError) throw taskError(businessError, 'PROVIDER_FAILED', taskId);
    const task = data.data && typeof data.data === 'object' ? data.data : null;
    if (!task) throw taskError('轮询响应缺少 data.data 任务信息', 'BAD_RESPONSE', taskId);
    const status = String(task.status || '').toUpperCase();
    if (status === 'FAILURE') {
      const rawDetail = responseDetail(task.fail_reason);
      const detail = rawDetail || '任务执行失败';
      const hint = /invalid\s+ip\s+address/i.test(detail)
        ? '（服务商上游网关未取得客户端 IP，请联系 Seedance 核查；本站已停止自动重试）'
        : '';
      throw taskError(detail + hint, 'PROVIDER_FAILED', taskId);
    }
    if (status === 'SUCCESS') {
      if (!isValidHttpsUrl(task.result_url)) {
        throw taskError('任务已完成但没有有效 HTTPS 图片地址', 'BAD_RESPONSE', taskId);
      }
      return task.result_url;
    }
    // TT AI 的中间状态可能扩展；未知状态继续轮询，不误判为协议错误。
  }
  throw taskError('轮询超时，任务可能仍在服务商执行，请勿直接重复提交', 'PROVIDER_FAILED', taskId);
}

async function generateTask(cfg, req, referencePaths) {
  throwIfCancelled(req);
  const withReference = referencePaths.length > 0;
  const parsed = parseModel((cfg && cfg.model) || DEFAULT_MODEL, withReference);
  const requestedQuality = normalizeQuality(req && req.quality);
  // TT 的 __1k/__1.5k/__2k 是用户显式选择的画质分组，优先于画布尺寸换算值。
  const quality = parsed.qualityFromSuffix ? parsed.quality : (requestedQuality || parsed.quality);
  const ratio = normalizeRatio(req);
  const body = {
    model: parsed.apiModel,
    prompt: String((req && req.prompt) || ''),
    metadata: buildMetadata(req, quality, ratio, withReference)
  };
  if (!body.prompt) throw makeError('Seedance 提示词不能为空', 'BAD_CONFIG');
  if (withReference) {
    const urls = [];
    for (const refPath of referencePaths) {
      const buffer = await readReference(refPath, req);
      urls.push(await uploadImage(cfg, req, buffer, path.basename(refPath)));
    }
    body.images = urls;
  }
  const dimensions = ratio === 'auto' ? null : getDimensions(quality, ratio);
  const taskId = await submitTask(cfg, req, body);
  const resultUrl = await pollTask(cfg, req, taskId);
  let buffer;
  try {
    buffer = await downloadImageSafely(resultUrl, { signal: req && req.cancelRef && req.cancelRef.signal });
  } catch (err) {
    const cancelRef = req && req.cancelRef;
    if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
        err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
      throw cancelledError();
    }
    throw taskError(err.message || '结果图片下载失败', err.code || 'FETCH_FAILED', taskId);
  }
  throwIfCancelled(req);
  const type = sniffImageType(buffer);
  if (!type) throw taskError('结果地址内容不是有效图片', 'INVALID_IMAGE', taskId);
  if (buffer.length > MAX_IMAGE_SIZE) throw taskError('生成图片超过大小限制', 'IMAGE_TOO_LARGE', taskId);
  return {
    images: [{ buffer, mime: type.mime }],
    model: parsed.apiModel,
    size: dimensions ? `${dimensions.width}x${dimensions.height}` : undefined
  };
}

async function readWallet(cfg) {
  const headers = getHeaders(cfg);
  let resp;
  try {
    resp = await axios.get(`${apiUrl(getBaseUrl(cfg), '/api/usage/wallet')}/`, { headers, timeout: 15000 });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401 || status === 403) throw makeError('Seedance API Key 无效或无权读取钱包', 'AUTH_FAILED');
    throw makeError('Seedance 钱包接口暂不可用', 'FETCH_FAILED');
  }
  const data = resp.data || {};
  const wallet = data.data;
  if (data.code !== true || !wallet || !Number.isFinite(wallet.amount) || typeof wallet.display_type !== 'string') {
    throw makeError('Seedance 钱包响应格式不正确', 'BAD_RESPONSE');
  }
  return { amount: wallet.amount, currency: 'CNY', label: `¥${wallet.amount.toFixed(2)}` };
}

module.exports = {
  key: 'seedance',
  supportsMultipleReferences: true,

  selectDefaultModel(models, currentDefault) {
    if (/^seedream-v5-pro-(?:t2i|i2i)$/i.test(String(currentDefault || ''))) return DEFAULT_MODEL;
    if (currentDefault && models.includes(currentDefault)) return currentDefault;
    return models[0] || DEFAULT_MODEL;
  },

  async generate(cfg, req) {
    return generateTask(cfg, req, []);
  },

  async generateWithReference(cfg, req, refPath) {
    const paths = Array.isArray(req && req.referenceImages) && req.referenceImages.length
      ? req.referenceImages
      : [refPath];
    const references = paths.filter(Boolean);
    if (!references.length) throw makeError('Seedance 未提供参考图', 'BAD_CONFIG');
    if (references.length > MAX_REFERENCES) throw makeError('Seedream 5.5 最多支持 10 张参考图', 'BAD_CONFIG');
    return generateTask(cfg, req, references);
  },

  async fetchModels() {
    return MODEL_IDS.slice();
  },

  async verify(cfg) {
    await readWallet(cfg);
    return true;
  },

  async fetchBalance(cfg) {
    try {
      return await readWallet(cfg);
    } catch (err) {
      if (err.code === 'AUTH_FAILED' || err.code === 'BAD_RESPONSE') throw err;
      return null;
    }
  }
};
