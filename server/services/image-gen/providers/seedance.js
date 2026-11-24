/**
 * Seedance 异步图片生成适配器
 * ① POST {base}/v1/image/generations 提交任务（不是 OpenAI 的 /v1/images/generations）
 * ② GET {base}/v1/image/generations/{task_id} 轮询，SUCCESS 后下载结果 URL
 * 图生图先将本地参考图异步上传至 /v1/files/upload，再把返回的 URL 放入 images
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE } = require('../utils');

const DEFAULT_BASE_URL = 'https://api.seedance.nz';
const DEFAULT_T2I_MODEL = 'seedream-v5-pro-t2i';
const DEFAULT_I2I_MODEL = 'seedream-v5-pro-i2i';
const MAX_POLLS = 200; // 200 * 3s = 600s
const POLL_INTERVAL = 3000;
const PENDING_STATUSES = new Set(['NOT_START', 'SUBMITTED', 'IN_PROGRESS']);
const VERIFY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function makeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function cancelledError() {
  return makeError('Seedance 任务已取消', 'CANCELLED');
}

function getBaseUrl(cfg) {
  return String((cfg && cfg.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getHeaders(cfg) {
  if (!cfg || !cfg.apiKey) {
    throw makeError('Seedance 未配置 API Key', 'BAD_CONFIG');
  }
  return { Authorization: `Bearer ${cfg.apiKey}` };
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

function normalizeCount(value) {
  return Math.min(Math.max(parseInt(value, 10) || 1, 1), 4);
}

function selectModel(cfg, withReference) {
  const configured = String((cfg && cfg.model) || '').trim();
  let model = configured || (withReference ? DEFAULT_I2I_MODEL : DEFAULT_T2I_MODEL);
  // 后台通常只保存一个默认模型；切换生图模式时同步替换 t2i/i2i 后缀。
  model = model.replace(/-(?:t2i|i2i)$/i, withReference ? '-i2i' : '-t2i');
  return model;
}

function parseDimensions(size) {
  const match = String(size || '').match(/^(\d{1,4})[x*](\d{1,4})$/);
  if (!match) return null;
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (!width || !height) return null;
  return { width, height };
}

function buildMetadata(req) {
  const dimensions = parseDimensions(req.size) || { width: 1024, height: 1024 };
  const longEdge = Math.max(dimensions.width, dimensions.height);
  const metadata = { output_format: 'jpeg' };
  // 标准边长使用服务商档位；其他尺寸按文档传 width/height，避免 resolution 覆盖自定义尺寸。
  const resolution = longEdge === 1024 ? '1k' : longEdge === 2048 ? '2k' : longEdge === 4096 ? '4k' : '';
  if (resolution) {
    metadata.resolution = resolution;
  } else {
    metadata.width = dimensions.width;
    metadata.height = dimensions.height;
  }
  // 官方 Seedream 文档未确认 negative_prompt、seed，故不猜测传参。
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

function unwrapData(data) {
  if (!data || typeof data !== 'object') return {};
  // 兼容 { data: {...} }、平铺响应，以及 status 平铺、data 仅承载附加图的混合响应。
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    return { ...data, ...data.data };
  }
  return data;
}

function isValidResultUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function uploadImage(cfg, req, buffer, filename) {
  throwIfCancelled(req);
  const form = buildUploadBody(buffer, filename);
  const signal = req && req.cancelRef && req.cancelRef.signal;
  let resp;
  try {
    resp = await axios.post(`${getBaseUrl(cfg)}/v1/files/upload`, form.body, {
      headers: { ...getHeaders(cfg), 'Content-Type': form.contentType },
      timeout: 60000,
      maxBodyLength: MAX_IMAGE_SIZE + 64 * 1024,
      signal
    });
  } catch (err) {
    rethrowIfCancelled(req, err);
  }
  throwIfCancelled(req);
  const url = unwrapData(resp.data).url;
  if (!isValidResultUrl(url)) {
    throw makeError('Seedance 参考图上传成功但未返回有效 URL', 'BAD_RESPONSE');
  }
  return url;
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
  if (!buffer.length || buffer.length > MAX_IMAGE_SIZE) {
    throw makeError('Seedance 参考图为空或超过大小限制', buffer.length ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE');
  }
  if (!sniffImageType(buffer)) {
    throw makeError('Seedance 参考图不是有效的图片文件', 'INVALID_IMAGE');
  }
  return buffer;
}

async function submitTask(cfg, req, body) {
  throwIfCancelled(req);
  let resp;
  try {
    resp = await axios.post(`${getBaseUrl(cfg)}/v1/image/generations`, body, {
      headers: { ...getHeaders(cfg), 'Content-Type': 'application/json' },
      timeout: 60000,
      signal: req && req.cancelRef && req.cancelRef.signal
    });
  } catch (err) {
    rethrowIfCancelled(req, err);
  }
  throwIfCancelled(req);
  const data = unwrapData(resp.data);
  const taskId = data.task_id || data.id;
  if ((typeof taskId !== 'string' && typeof taskId !== 'number') || String(taskId).trim() === '') {
    throw makeError('Seedance 未返回任务 ID', 'BAD_RESPONSE');
  }
  if (req.taskInfo) req.taskInfo.taskId = String(taskId);
  return String(taskId);
}

function getResultUrls(task) {
  const urls = [];
  if (isValidResultUrl(task.result_url)) urls.push(task.result_url);
  const content = task.data && task.data.content;
  const extra = content && content.image_urls;
  for (const url of Array.isArray(extra) ? extra : [extra]) {
    if (isValidResultUrl(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

async function pollTask(cfg, req, taskId) {
  const url = `${getBaseUrl(cfg)}/v1/image/generations/${encodeURIComponent(taskId)}`;
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
      rethrowIfCancelled(req, err);
      const status = err.response && err.response.status;
      // 鉴权和参数错误不会因重试恢复；限流、网络及服务端错误才继续轮询。
      if (status === 401 || status === 403) {
        throw makeError('Seedance API Key 无效或无权查询任务', 'AUTH_FAILED');
      }
      if (status === 400 || status === 404 || status === 422) {
        throw makeError(`Seedance 查询任务失败（HTTP ${status}）`, 'FETCH_FAILED');
      }
      continue;
    }
    throwIfCancelled(req);
    const task = unwrapData(resp.data);
    const status = String(task.status || '').toUpperCase();
    if (status === 'SUCCESS') return getResultUrls(task);
    if (status === 'FAILURE') {
      const detail = typeof task.error === 'string' ? task.error : '';
      throw makeError(`Seedance 任务失败${detail ? `：${detail.slice(0, 200)}` : ''}`, 'PROVIDER_FAILED');
    }
    if (!PENDING_STATUSES.has(status)) {
      throw makeError(`Seedance 返回了无法识别的任务状态：${status || '空'}`, 'BAD_RESPONSE');
    }
  }
  throw makeError('Seedance 任务超时', 'TIMEOUT');
}

async function downloadResults(req, urls, maxImages) {
  if (!urls.length) {
    throw makeError('Seedance 任务成功但未解析到图片地址', 'EMPTY_RESPONSE');
  }
  const images = [];
  // 优先下载主图，再下载 content.image_urls 中的附加图，并受本次剩余张数限制。
  for (const url of urls.slice(0, maxImages)) {
    throwIfCancelled(req);
    let buffer;
    try {
      buffer = await downloadImageSafely(url, { signal: req && req.cancelRef && req.cancelRef.signal });
    } catch (err) {
      rethrowIfCancelled(req, err);
      throw makeError('Seedance 结果图片下载失败', 'FETCH_FAILED');
    }
    throwIfCancelled(req);
    const type = sniffImageType(buffer);
    if (!type) throw makeError('Seedance 生成结果不是有效的图片文件', 'INVALID_IMAGE');
    if (buffer.length > MAX_IMAGE_SIZE) {
      throw makeError(`Seedance 生成图片超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制`, 'IMAGE_TOO_LARGE');
    }
    images.push({ buffer, mime: type.mime });
  }
  return images;
}

async function runGeneration(cfg, req, body, maxImages) {
  const taskId = await submitTask(cfg, req, body);
  const urls = await pollTask(cfg, req, taskId);
  return { images: await downloadResults(req, urls, maxImages) };
}

module.exports = {
  key: 'seedance',

  async generate(cfg, req) {
    getHeaders(cfg); // 提交前先校验配置，避免无 Key 时构造多个任务。
    const body = {
      model: selectModel(cfg, false),
      prompt: req.prompt,
      metadata: buildMetadata(req)
    };
    const images = [];
    const count = normalizeCount(req.n);
    for (let i = 0; i < count && images.length < count; i++) {
      throwIfCancelled(req);
      const result = await runGeneration(cfg, req, body, count - images.length);
      images.push(...result.images);
    }
    return { images };
  },

  async generateWithReference(cfg, req, refPath) {
    getHeaders(cfg);
    const buffer = await readReference(refPath, req);
    const referenceUrl = await uploadImage(cfg, req, buffer, path.basename(refPath));
    const body = {
      model: selectModel(cfg, true),
      prompt: req.prompt,
      images: [referenceUrl],
      metadata: buildMetadata(req)
    };
    const images = [];
    const count = normalizeCount(req.n);
    for (let i = 0; i < count && images.length < count; i++) {
      throwIfCancelled(req);
      const result = await runGeneration(cfg, req, body, count - images.length);
      images.push(...result.images);
    }
    return { images };
  },

  // 官方文档未确认公开模型列表接口，交给后台手动配置。
  async fetchModels() {
    return null;
  },

  // 无独立验 Key 接口：上传 1x1 PNG 验证已确认的 /v1/files/upload，不发起任何生成任务。
  async verify(cfg) {
    if (!cfg || !cfg.apiKey) return false;
    try {
      await uploadImage(cfg, null, VERIFY_PNG, 'seedance-verify.png');
      return true;
    } catch (err) {
      return false;
    }
  },

  // 官方文档未确认取消接口；不导出 cancel，避免向用户声称已通知服务商停止远程任务。
};
