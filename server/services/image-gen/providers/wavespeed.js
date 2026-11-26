/**
 * WaveSpeed AI 异步适配器
 *
 * ① POST {base}/api/v3/{模型路径} 提交任务，返回 data.id
 * ② GET  {base}/api/v3/predictions/{id}/result 轮询，completed 后下载 data.outputs
 *
 * 注意：该适配器按 WaveSpeed 公开的 /api/v3 异步协议实现，尚未与官方账号联调。
 * 若官方调整了提交或轮询路径，后台把「API Path」改成对应模型路径即可，无需改代码。
 */
const axios = require('axios');
const fs = require('fs');
const { apiUrl, downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE } = require('../utils');

const DEFAULT_BASE = 'https://api.wavespeed.ai';
const POLL_INTERVAL = 3000;
const MAX_POLLS = 200; // 约 10 分钟
const PENDING = new Set(['created', 'pending', 'queued', 'processing', 'running']);

function makeError(message, code, taskId) {
  return Object.assign(new Error(message), {
    code,
    ...(taskId ? { fromPoll: true, taskId } : {})
  });
}

function baseUrl(cfg) {
  return String((cfg && cfg.baseUrl) || DEFAULT_BASE).replace(/\/+$/, '');
}

function submitUrl(cfg) {
  const model = modelPath(cfg);
  return /^https?:\/\//i.test(model)
    ? model
    : apiUrl(baseUrl(cfg), `/api/v3/${model.split('/').map(encodeURIComponent).join('/')}`, [
      '/api/v3/predictions'
    ]);
}

function headers(cfg) {
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) throw makeError('WaveSpeed 未配置 API Key', 'BAD_CONFIG');
  return { Authorization: `Bearer ${apiKey}` };
}

function modelPath(cfg) {
  const value = String((cfg && (cfg.apiPath || cfg.model)) || '').trim().replace(/^\/+/, '');
  if (!value) throw makeError('WaveSpeed 需要填写模型路径（如 wavespeed-ai/flux-dev）', 'BAD_CONFIG');
  return value;
}

function signalOf(req) {
  return req && req.cancelRef && req.cancelRef.signal;
}

function throwIfCancelled(req) {
  const cancelRef = req && req.cancelRef;
  if (cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) {
    throw makeError('WaveSpeed 任务已取消', 'CANCELLED');
  }
}

function rethrowIfCancelled(req, err) {
  const cancelRef = req && req.cancelRef;
  if ((cancelRef && (cancelRef.cancelled || (cancelRef.signal && cancelRef.signal.aborted))) ||
      err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
    throw makeError('WaveSpeed 任务已取消', 'CANCELLED');
  }
  throw err;
}

function waitForPoll(req) {
  throwIfCancelled(req);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, POLL_INTERVAL);
    const signal = signalOf(req);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(makeError('WaveSpeed 任务已取消', 'CANCELLED'));
      }, { once: true });
    }
  });
}

function unwrap(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    return { ...data, ...data.data };
  }
  return data;
}

function resultUrls(task) {
  const urls = [];
  const outputs = Array.isArray(task.outputs) ? task.outputs : (task.outputs ? [task.outputs] : []);
  outputs.forEach((item) => {
    const url = typeof item === 'string' ? item : (item && (item.url || item.image));
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && urls.indexOf(url) === -1) urls.push(url);
  });
  if (!urls.length && typeof task.url === 'string' && /^https?:\/\//i.test(task.url)) urls.push(task.url);
  return urls;
}

async function submit(cfg, req) {
  throwIfCancelled(req);
  // 与 TTAI 插件一致：WaveSpeed 用 resolution 关键词 + aspect_ratio + images(data URL)，而不是像素 size
  const body = {
    prompt: req.prompt,
    resolution: String(req.quality || '1k').toLowerCase(),
    output_format: 'png',
    background: 'auto',
    enable_sync_mode: false
  };
  if (req.aspectRatio && req.aspectRatio !== '1:1') body.aspect_ratio = req.aspectRatio;
  if (req.negativePrompt && cfg && cfg.supportsNegative) body.negative_prompt = req.negativePrompt;
  if (req.seed) body.seed = req.seed;
  const refs = Array.isArray(req.referenceImages) ? req.referenceImages.slice(0, 10) : [];
  if (refs.length) {
    const images = [];
    for (const refPath of refs) {
      const buffer = await fs.promises.readFile(refPath);
      const type = sniffImageType(buffer);
      images.push(`data:${type ? type.mime : 'image/png'};base64,${buffer.toString('base64')}`);
    }
    body.images = images;
  }
  const resp = await axios.post(submitUrl(cfg), body, {
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    timeout: 60000,
    signal: signalOf(req)
  }).catch((err) => rethrowIfCancelled(req, err));
  const data = unwrap(resp.data);
  const taskId = data.id || data.task_id || data.request_id;
  if (!taskId) throw makeError('WaveSpeed 未返回任务 ID（请确认模型路径与 API 版本）', 'BAD_RESPONSE');
  if (req.taskInfo) req.taskInfo.taskId = String(taskId);
  return String(taskId);
}

async function poll(cfg, req, taskId) {
  const url = apiUrl(baseUrl(cfg), `/api/v3/predictions/${encodeURIComponent(taskId)}/result`);
  for (let i = 0; i < MAX_POLLS; i++) {
    throwIfCancelled(req);
    await waitForPoll(req);
    throwIfCancelled(req);
    let resp;
    try {
      resp = await axios.get(url, { headers: headers(cfg), timeout: 30000, signal: signalOf(req) });
    } catch (err) {
      rethrowIfCancelled(req, err);
      const status = err.response && err.response.status;
      if (status === 401 || status === 403) throw makeError('WaveSpeed API Key 无效或无权查询任务', 'AUTH_FAILED', taskId);
      if (status === 400 || status === 404 || status === 422) {
        throw makeError(`WaveSpeed 查询任务失败（HTTP ${status}）`, 'FETCH_FAILED', taskId);
      }
      continue;
    }
    const task = unwrap(resp.data);
    const status = String(task.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const urls = resultUrls(task);
      if (!urls.length) throw makeError('WaveSpeed 任务完成但没有返回图片地址', 'EMPTY_RESPONSE', taskId);
      return urls;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const detail = typeof task.error === 'string' ? task.error : '';
      throw makeError(`WaveSpeed 任务失败${detail ? `：${detail.slice(0, 200)}` : ''}`, 'PROVIDER_FAILED', taskId);
    }
    if (status && !PENDING.has(status)) {
      throw makeError(`WaveSpeed 返回了无法识别的任务状态：${status}`, 'BAD_RESPONSE', taskId);
    }
  }
  throw makeError('WaveSpeed 任务超时', 'TIMEOUT', taskId);
}

async function download(req, urls, maxImages) {
  const images = [];
  for (const url of urls.slice(0, maxImages)) {
    throwIfCancelled(req);
    let buffer;
    try {
      buffer = await downloadImageSafely(url, { signal: signalOf(req) });
    } catch (err) {
      rethrowIfCancelled(req, err);
      throw makeError('WaveSpeed 结果图片下载失败', 'FETCH_FAILED');
    }
    const type = sniffImageType(buffer);
    if (!type) throw makeError('WaveSpeed 生成结果不是有效图片', 'INVALID_IMAGE');
    if (buffer.length > MAX_IMAGE_SIZE) throw makeError('生成图片超过大小限制', 'IMAGE_TOO_LARGE');
    images.push({ buffer, mime: type.mime });
  }
  return images;
}

module.exports = {
  key: 'wavespeed',

  async generate(cfg, req) {
    headers(cfg);
    modelPath(cfg);
    const taskId = await submit(cfg, req);
    const urls = await poll(cfg, req, taskId);
    const count = Math.min(Math.max(parseInt(req.n, 10) || 1, 1), 4);
    return { images: await download(req, urls, count) };
  },

  // WaveSpeed 的图生图依赖具体模型（部分模型接受 image 参数），默认不开放，避免误判能力。
  async fetchModels() {
    return null;
  }
};
