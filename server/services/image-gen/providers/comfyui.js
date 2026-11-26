/**
 * ComfyUI 原生工作流适配器
 * POST /prompt → GET /history/{prompt_id} → GET /view 下载输出图片
 * 支持内置文生图工作流、后台粘贴的 Export (API) 工作流、图生图与队列取消。
 * 服务地址仅由管理员在 ai_image_providers.api_base 配置，普通用户不能指定。
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSize, sleep, sniffImageType, normalizeApiBase } = require('../utils');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_CHECKPOINT = 'v1-5-pruned-emaonly.safetensors';
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_WORKFLOW_NODES = 1000;
const MAX_POLL_MS = 10 * 60 * 1000; // 单次工作流最多等待 10 分钟
const MAX_HISTORY_404_RETRY = 20; // 历史连续 404 时快速失败，避免无效等待
const POLL_INTERVAL_MS = 1500;
const NODE_MAP_KEYS = ['positive', 'negative', 'size', 'seed', 'image', 'model'];
const MODEL_LOADERS = {
  CheckpointLoaderSimple: 'ckpt_name',
  UNETLoader: 'unet_name',
  DiffusionModelLoader: 'unet_name'
};
const STYLE_SUFFIXES = {
  photo: 'professional photography, photorealistic, sharp focus, natural lighting',
  illustration: 'digital illustration, vibrant colors, highly detailed',
  '3d': '3D render, cinematic lighting, depth of field',
  guofeng: 'traditional Chinese ink wash painting, elegant, artistic',
  cyberpunk: 'cyberpunk style, neon lights, futuristic city, high contrast',
  watercolor: 'watercolor painting, soft colors, delicate artistic detail',
  anime: 'anime style, beautiful detailed, vibrant, studio quality',
  pixel: 'pixel art, retro game style, 16-bit'
};

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeBaseUrl(value) {
  return normalizeApiBase(value || DEFAULT_BASE_URL, [
    '/upload/image', '/history', '/view', '/prompt', '/object_info', '/system_stats', '/queue'
  ]);
}

function requestConfig(cfg, req, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return {
    timeout: 30000,
    signal: req && req.cancelRef && req.cancelRef.signal,
    maxRedirects: 0, // 不跟随重定向，避免把管理员配置的地址凭据带到其他主机
    ...extra,
    headers
  };
}

const INTERNAL_ERROR_CODES = new Set([
  'CANCELLED', 'TIMEOUT', 'BAD_CONFIG', 'AUTH_FAILED', 'PROVIDER_FAILED',
  'EMPTY_RESPONSE', 'INVALID_IMAGE', 'IMAGE_TOO_LARGE', 'BAD_RESPONSE', 'FETCH_FAILED'
]);

function providerError(err, fallback) {
  if (err && err.code === 'ERR_CANCELED') return codedError('任务已取消', 'CANCELLED');
  if (err && err.code === 'ECONNABORTED') return codedError('ComfyUI 请求超时', 'TIMEOUT');
  if (err && err.response && err.response.status === 401) return codedError('ComfyUI 鉴权失败，API Key 错误', 'AUTH_FAILED');
  if (err && err.response && err.response.status === 403) return codedError('ComfyUI 拒绝访问，权限不足', 'AUTH_FAILED');
  if (err && INTERNAL_ERROR_CODES.has(err.code)) return err;
  const data = err && err.response && err.response.data;
  const detail = data && (data.error || data.message || data.detail);
  const message = typeof detail === 'string'
    ? detail
    : (detail && detail.message) || (err && err.message) || fallback;
  return codedError(`ComfyUI 请求失败：${String(message).slice(0, 240)}`, 'PROVIDER_FAILED');
}

function builtinWorkflow() {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 25, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
      }
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: DEFAULT_CHECKPOINT }
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: 1024, height: 1024, batch_size: 1 }
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['4', 1] }
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'low quality, blurry, bad anatomy, extra limbs', clip: ['4', 1] }
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] }
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] }
    }
  };
}

function parseWorkflow(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { workflow: builtinWorkflow(), builtin: true };
  }
  const text = String(value);
  if (Buffer.byteLength(text) > MAX_WORKFLOW_BYTES) {
    throw codedError('ComfyUI 工作流 JSON 不能超过 1MB', 'BAD_CONFIG');
  }
  let workflow;
  try {
    workflow = JSON.parse(text);
  } catch (e) {
    throw codedError('ComfyUI 工作流不是有效的 JSON，请使用 ComfyUI「Export (API)」导出的文件', 'BAD_CONFIG');
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || Array.isArray(workflow.nodes)) {
    throw codedError('ComfyUI 工作流必须是 API 格式（节点 ID 映射），不能直接粘贴界面保存的 UI JSON', 'BAD_CONFIG');
  }
  const entries = Object.entries(workflow);
  if (!entries.length || entries.length > MAX_WORKFLOW_NODES) {
    throw codedError('ComfyUI 工作流节点数量无效（最多 1000 个）', 'BAD_CONFIG');
  }
  for (const [id, node] of entries) {
    if (!/^\d{1,10}$/.test(id) || !node || typeof node !== 'object' || Array.isArray(node) ||
        typeof node.class_type !== 'string' || !node.class_type.trim() ||
        !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw codedError('ComfyUI 工作流包含无效节点，请确认导出格式为 API JSON', 'BAD_CONFIG');
    }
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && /^\d{1,10}$/.test(value[0])) {
        if (!workflow[value[0]] || !Number.isInteger(value[1]) || value[1] < 0) {
          throw codedError(`ComfyUI 节点 ${id} 引用了不存在的上游节点或输出`, 'BAD_CONFIG');
        }
      }
    }
  }
  return { workflow, builtin: false };
}

function parseNodeMap(value, workflow) {
  let map = {};
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    try {
      map = JSON.parse(String(value));
    } catch (e) {
      throw codedError('ComfyUI 节点映射不是有效的 JSON', 'BAD_CONFIG');
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw codedError('ComfyUI 节点映射必须是 JSON 对象', 'BAD_CONFIG');
    }
  }
  const clean = {};
  for (const key of NODE_MAP_KEYS) {
    if (map[key] === undefined || map[key] === null || map[key] === '') continue;
    const id = String(map[key]);
    if (!workflow[id]) throw codedError(`ComfyUI 节点映射中的 ${key} 节点 ${id} 不存在`, 'BAD_CONFIG');
    clean[key] = id;
  }
  return clean;
}

function validateNodeMap(workflow, map) {
  for (const key of NODE_MAP_KEYS) {
    if (!map[key]) continue;
    const node = workflow[map[key]];
    const inputs = node && node.inputs || {};
    if (key === 'positive' || key === 'negative') {
      if (typeof inputs.text !== 'string') {
        throw codedError(`ComfyUI 节点映射中的 ${key} 节点必须包含 text 输入`, 'BAD_CONFIG');
      }
    } else if (key === 'size') {
      if (!Number.isFinite(Number(inputs.width)) || !Number.isFinite(Number(inputs.height))) {
        throw codedError('ComfyUI 节点映射中的 size 节点必须包含 width/height 输入', 'BAD_CONFIG');
      }
    } else if (key === 'seed') {
      if (!Object.prototype.hasOwnProperty.call(inputs, 'seed') && !Object.prototype.hasOwnProperty.call(inputs, 'noise_seed')) {
        throw codedError('ComfyUI 节点映射中的 seed 节点必须包含 seed/noise_seed 输入', 'BAD_CONFIG');
      }
    } else if (key === 'image') {
      if (node.class_type !== 'LoadImage' || typeof inputs.image !== 'string') {
        throw codedError('ComfyUI 节点映射中的 image 节点必须是 LoadImage', 'BAD_CONFIG');
      }
    } else if (key === 'model') {
      if (!MODEL_LOADERS[node.class_type] || typeof inputs[MODEL_LOADERS[node.class_type]] !== 'string') {
        throw codedError('ComfyUI 节点映射中的 model 节点必须是支持的模型加载器', 'BAD_CONFIG');
      }
    }
  }
  if (!map.positive) {
    throw codedError('ComfyUI 工作流未找到提示词节点，请在后台配置 positive 节点映射', 'BAD_CONFIG');
  }
}

function validateWorkflow(value, nodeMap) {
  const parsed = parseWorkflow(value);
  const map = parseNodeMap(nodeMap, parsed.workflow);
  validateNodeMap(parsed.workflow, { ...autoNodeMap(parsed.workflow), ...map });
  return { workflow: parsed.workflow, builtin: parsed.builtin, nodeMap: map };
}

function traceTextNode(workflow, startId, seen = new Set()) {
  if (!startId || seen.has(startId)) return null;
  seen.add(startId);
  const node = workflow[startId];
  if (!node) return null;
  if (node.class_type === 'CLIPTextEncode' && typeof node.inputs.text === 'string') return startId;
  for (const value of Object.values(node.inputs || {})) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
      const found = traceTextNode(workflow, value[0], seen);
      if (found) return found;
    }
  }
  return null;
}

function autoNodeMap(workflow) {
  const entries = Object.entries(workflow);
  const map = {};
  const samplers = entries.filter(([, n]) => /^(KSampler|KSamplerAdvanced|SamplerCustomAdvanced)$/.test(n.class_type));
  const sampler = samplers[0];
  if (sampler) {
    map.seed = sampler[0];
    map.positive = traceTextNode(workflow, sampler[1].inputs.positive && sampler[1].inputs.positive[0]);
    map.negative = traceTextNode(workflow, sampler[1].inputs.negative && sampler[1].inputs.negative[0]);
  }
  const textNodes = entries.filter(([, n]) => n.class_type === 'CLIPTextEncode' && typeof n.inputs.text === 'string');
  if (!map.positive && textNodes.length) map.positive = textNodes[0][0];
  if (!map.negative && textNodes.length > 1) map.negative = textNodes[1][0];

  const sizeNode = entries.find(([, n]) =>
    Number.isFinite(Number(n.inputs.width)) && Number.isFinite(Number(n.inputs.height)));
  if (sizeNode) map.size = sizeNode[0];
  if (!map.seed) {
    const seedNode = entries.find(([, n]) =>
      Number.isFinite(Number(n.inputs.seed)) || Number.isFinite(Number(n.inputs.noise_seed)));
    if (seedNode) map.seed = seedNode[0];
  }
  const imageNode = entries.find(([, n]) => n.class_type === 'LoadImage' && typeof n.inputs.image === 'string');
  if (imageNode) map.image = imageNode[0];
  const modelNode = entries.find(([, n]) => MODEL_LOADERS[n.class_type]);
  if (modelNode) map.model = modelNode[0];
  return map;
}

function normalizeSize(size) {
  const { width, height } = parseSize(size);
  if (width < 64 || height < 64 || width > 4096 || height > 4096 || width % 8 || height % 8) {
    throw codedError('ComfyUI 尺寸需为 64–4096 之间的 8 的倍数（4K 需要工作流与显存支持）', 'BAD_CONFIG');
  }
  return { width, height };
}

function randomSeed() {
  return crypto.randomInt(0, 4294967296);
}

function prepareWorkflow(cfg, req, referenceName) {
  const { workflow: rawWorkflow, builtin, nodeMap: explicitMap } = validateWorkflow(cfg.workflow, cfg.nodeMap);
  // 每次生成都使用副本，避免修改后台保存的原始工作流对象。
  const workflow = JSON.parse(JSON.stringify(rawWorkflow));
  const map = { ...autoNodeMap(workflow), ...explicitMap };
  let prompt = String(req.prompt || '').trim();
  if (STYLE_SUFFIXES[req.style]) prompt += `, ${STYLE_SUFFIXES[req.style]}`;

  if (!map.positive || !workflow[map.positive] || typeof workflow[map.positive].inputs.text !== 'string') {
    throw codedError('ComfyUI 工作流未找到提示词节点，请在后台配置 positive 节点映射', 'BAD_CONFIG');
  }
  workflow[map.positive].inputs.text = prompt;
  if (map.negative && workflow[map.negative] && typeof workflow[map.negative].inputs.text === 'string' && req.negativePrompt) {
    workflow[map.negative].inputs.text = req.negativePrompt;
  }
  if (map.size && workflow[map.size]) {
    const { width, height } = normalizeSize(req.size);
    workflow[map.size].inputs.width = width;
    workflow[map.size].inputs.height = height;
    if (Object.prototype.hasOwnProperty.call(workflow[map.size].inputs, 'batch_size')) {
      workflow[map.size].inputs.batch_size = Math.min(Math.max(Math.floor(Number(req.n)) || 1, 1), 4);
    }
  }
  if (map.seed && workflow[map.seed]) {
    const inputs = workflow[map.seed].inputs;
    const seedField = Object.prototype.hasOwnProperty.call(inputs, 'seed') ? 'seed'
      : (Object.prototype.hasOwnProperty.call(inputs, 'noise_seed') ? 'noise_seed' : null);
    if (seedField) inputs[seedField] = Number(req.seed) || randomSeed();
  }
  if (map.model && cfg.model && workflow[map.model]) {
    const field = MODEL_LOADERS[workflow[map.model].class_type];
    if (field) workflow[map.model].inputs[field] = cfg.model;
  }
  if (builtin && !cfg.model) workflow[4].inputs.ckpt_name = DEFAULT_CHECKPOINT;

  if (referenceName) {
    let imageId = map.image;
    let encodeId;
    if (builtin) {
      // 内置文生图工作流在需要图生图时动态补上 LoadImage → ImageScale → VAEEncode → KSampler。
      const usedIds = new Set(Object.keys(workflow).map(Number));
      imageId = String(Math.max(0, ...usedIds) + 1);
      const scaleId = String(Number(imageId) + 1);
      encodeId = String(Number(imageId) + 2);
      const sizeNode = workflow[map.size];
      workflow[imageId] = { class_type: 'LoadImage', inputs: { image: referenceName } };
      workflow[scaleId] = {
        class_type: 'ImageScale',
        inputs: {
          image: [imageId, 0],
          upscale_method: 'lanczos',
          width: sizeNode.inputs.width,
          height: sizeNode.inputs.height
        }
      };
      workflow[encodeId] = {
        class_type: 'VAEEncode',
        inputs: { pixels: [scaleId, 0], vae: [map.model && workflow[map.model] ? map.model : '4', 2] }
      };
    } else {
      if (!imageId || !workflow[imageId] || workflow[imageId].class_type !== 'LoadImage') {
        throw codedError('当前 ComfyUI 工作流没有 LoadImage 节点，无法进行图生图', 'BAD_CONFIG');
      }
      workflow[imageId].inputs.image = referenceName;
      const encode = Object.entries(workflow).find(([, n]) =>
        n.class_type === 'VAEEncode' && traceNodeClass(workflow, n.inputs.pixels && n.inputs.pixels[0], 'LoadImage', new Set(), imageId));
      if (!encode) {
        throw codedError('当前 ComfyUI 工作流的参考图未连接到 VAEEncode，无法进行图生图', 'BAD_CONFIG');
      }
      encodeId = encode[0];
      const encodeNode = workflow[encodeId];
      const source = encodeNode.inputs.pixels;
      if (!Array.isArray(source) || source.length !== 2 || typeof source[0] !== 'string') {
        throw codedError('当前 ComfyUI 工作流的 VAEEncode 输入不是有效图片连接，无法进行图生图', 'BAD_CONFIG');
      }
      // 在编码前追加缩放，保留原有预处理链路，同时让用户选择的尺寸生效。
      const scaleId = String(Math.max(0, ...Object.keys(workflow).map(Number)) + 1);
      const { width, height } = normalizeSize(req.size);
      workflow[scaleId] = {
        class_type: 'ImageScale',
        inputs: { image: source, upscale_method: 'lanczos', width, height }
      };
      encodeNode.inputs.pixels = [scaleId, 0];
    }
    if (!map.seed || !workflow[map.seed]) {
      throw codedError('当前 ComfyUI 工作流没有采样器节点，无法进行图生图', 'BAD_CONFIG');
    }
    const sampler = workflow[map.seed];
    if (!/^(KSampler|KSamplerAdvanced)$/.test(sampler.class_type) ||
        !Object.prototype.hasOwnProperty.call(sampler.inputs, 'latent_image')) {
      throw codedError('当前 ComfyUI 采样器不支持 latent_image 输入，无法进行图生图', 'BAD_CONFIG');
    }
    sampler.inputs.latent_image = [encodeId, 0];
    if (Object.prototype.hasOwnProperty.call(sampler.inputs, 'denoise')) {
      sampler.inputs.denoise = 0.65;
    }
  }

  // 只有确实接入采样器 latent 的尺寸节点才能用 batch_size 一次生成多张。
  // 自定义工作流可能保留未使用的 EmptyLatentImage，不能仅凭 batch_size 跳过逐张提交。
  const sampler = map.seed && workflow[map.seed];
  const latentId = sampler && Array.isArray(sampler.inputs.latent_image) && sampler.inputs.latent_image[0];
  const sizeConnected = map.size && workflow[map.size] &&
    traceNodeClass(workflow, latentId, workflow[map.size].class_type, new Set(), map.size);
  const hasSizeBatch = Boolean(map.size && workflow[map.size] &&
    Object.prototype.hasOwnProperty.call(workflow[map.size].inputs, 'batch_size'));
  const hasBatch = !referenceName && Boolean(sizeConnected) && hasSizeBatch;
  return { workflow, hasBatch, map };
}

function traceNodeClass(workflow, startId, classType, seen = new Set(), targetId = null) {
  if (!startId || seen.has(startId)) return false;
  seen.add(startId);
  const node = workflow[startId];
  if (!node) return false;
  if (node.class_type === classType && (!targetId || startId === targetId)) return true;
  return Object.values(node.inputs || {}).some(value =>
    Array.isArray(value) && value.length === 2 &&
    traceNodeClass(workflow, value[0], classType, seen, targetId));
}

function multipartBuffer(fields, file) {
  const boundary = `----ComfyUI${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  const safeName = path.basename(file.originalname || 'reference.png').replace(/[^\w.-]/g, '_');
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
    `Content-Type: ${file.mime}\r\n\r\n`));
  chunks.push(file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadReference(cfg, req, refPath) {
  const buffer = await fs.promises.readFile(refPath);
  const type = sniffImageType(buffer);
  if (!type) throw codedError('参考图不是有效的 JPG/PNG/WebP 图片', 'INVALID_IMAGE');
  const multipart = multipartBuffer({ overwrite: 'false', type: 'input' }, {
    buffer, originalname: `reference${type.ext}`, mime: type.mime
  });
  try {
    const resp = await axios.post(`${normalizeBaseUrl(cfg.baseUrl)}/upload/image`, multipart.body,
      requestConfig(cfg, req, { headers: { 'Content-Type': multipart.contentType }, timeout: 60000 }));
    const data = resp.data || {};
    if (!data.name) throw codedError('ComfyUI 未返回上传后的图片名称', 'EMPTY_RESPONSE');
    return [data.subfolder, data.name].filter(Boolean).join('/');
  } catch (err) {
    throw providerError(err, '参考图上传失败');
  }
}

function historyError(entry) {
  const status = entry && entry.status;
  if (!status || status.status_str !== 'error') return null;
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const execution = messages.find(m => m && m[0] === 'execution_error');
  const detail = execution && execution[1];
  return `ComfyUI 工作流执行失败：${(detail && (detail.exception_message || detail.error)) || status.status_str || '未知错误'}`;
}

function safeOutputName(item) {
  if (!item || typeof item.filename !== 'string' || !item.filename ||
      path.basename(item.filename) !== item.filename || /[\\/]/.test(item.filename)) return null;
  const subfolder = String(item.subfolder || '');
  if (subfolder.split(/[\\/]/).some(part => part === '..' || part === '.' || part.includes(':'))) return null;
  const type = item.type || 'output';
  // input 是上传的参考图，不能作为生成结果保存；未知类型也拒绝。
  if (!['output', 'temp'].includes(type)) return null;
  return { filename: item.filename, subfolder, type };
}

async function waitForOutput(cfg, req, promptId) {
  if (req.taskInfo) {
    req.taskInfo.promptId = promptId;
    req.taskInfo.promptIds = (req.taskInfo.promptIds || []).concat(promptId);
  }
  const deadline = Date.now() + MAX_POLL_MS;
  let notFoundCount = 0;
  while (Date.now() < deadline) {
    if (req.cancelRef && req.cancelRef.cancelled) throw codedError('任务已取消', 'CANCELLED');
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    let resp;
    try {
      resp = await axios.get(`${normalizeBaseUrl(cfg.baseUrl)}/history/${encodeURIComponent(promptId)}`,
        requestConfig(cfg, req));
    } catch (err) {
      if (err && err.response && err.response.status === 404) {
        notFoundCount++;
        if (notFoundCount > MAX_HISTORY_404_RETRY) {
          throw codedError('ComfyUI 任务历史丢失，无法查询结果', 'TIMEOUT');
        }
        continue;
      }
      throw providerError(err, '查询 ComfyUI 任务状态失败');
    }
    notFoundCount = 0;
    const entry = resp.data && resp.data[promptId];
    if (!entry) continue;
    const error = historyError(entry);
    if (error) throw codedError(error.slice(0, 300), 'PROVIDER_FAILED');
    const items = [];
    const seen = new Set();
    for (const output of Object.values(entry.outputs || {})) {
      for (const image of (output && output.images) || []) {
        const item = safeOutputName(image);
        if (!item) continue;
        const key = `${item.type}:${item.subfolder}:${item.filename}`;
        if (!seen.has(key)) { seen.add(key); items.push(item); }
      }
    }
    if (items.length) return items;
    if (entry.status && entry.status.completed) {
      throw codedError('ComfyUI 任务已完成，但没有返回可下载的图片', 'EMPTY_RESPONSE');
    }
  }
  throw codedError('ComfyUI 生成超时（约 10 分钟）', 'TIMEOUT');
}

async function downloadOutput(cfg, req, item) {
  try {
    const resp = await axios.get(`${normalizeBaseUrl(cfg.baseUrl)}/view`, {
      ...requestConfig(cfg, req),
      params: item,
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024
    });
    const buffer = Buffer.from(resp.data);
    if (!sniffImageType(buffer)) throw codedError('ComfyUI 输出不是有效图片', 'INVALID_IMAGE');
    return { buffer, mime: sniffImageType(buffer).mime };
  } catch (err) {
    throw providerError(err, '下载 ComfyUI 输出图片失败');
  }
}

async function submit(cfg, req, workflow) {
  let resp;
  try {
    resp = await axios.post(`${normalizeBaseUrl(cfg.baseUrl)}/prompt`, {
      prompt: workflow,
      client_id: `wangzhan-${crypto.randomBytes(8).toString('hex')}`
    }, requestConfig(cfg, req, { timeout: 60000 }));
  } catch (err) {
    throw providerError(err, '提交 ComfyUI 工作流失败');
  }
  const data = resp.data || {};
  if (data.node_errors && Object.keys(data.node_errors).length) {
    const first = Object.values(data.node_errors)[0];
    const detail = first && (first.exception_message || (first.errors && first.errors[0] && first.errors[0].message));
    throw codedError(`ComfyUI 工作流校验失败：${String(detail || '节点配置有误').slice(0, 240)}`, 'BAD_CONFIG');
  }
  if (!data.prompt_id) throw codedError('ComfyUI 未返回任务 ID', 'EMPTY_RESPONSE');
  return data.prompt_id;
}

async function generateInternal(cfg, req, refPath) {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const referenceName = refPath ? await uploadReference({ ...cfg, baseUrl }, req, refPath) : null;
  const prepared = prepareWorkflow(cfg, req, referenceName);
  const { workflow, map } = prepared;
  const requestedCount = Math.min(Math.max(Math.floor(Number(req.n)) || 1, 1), 4);
  const count = prepared.hasBatch ? 1 : requestedCount;
  const seedNode = map.seed && workflow[map.seed];
  const seedField = seedNode && (Object.prototype.hasOwnProperty.call(seedNode.inputs, 'seed') ? 'seed'
    : (Object.prototype.hasOwnProperty.call(seedNode.inputs, 'noise_seed') ? 'noise_seed' : null));
  const baseSeed = seedNode && seedField ? workflow[map.seed].inputs[seedField] : 0;
  const images = [];
  for (let i = 0; i < count; i++) {
    if (req.cancelRef && req.cancelRef.cancelled) throw codedError('任务已取消', 'CANCELLED');
    const current = JSON.parse(JSON.stringify(workflow));
    if (i > 0 && seedNode && seedField) {
      current[map.seed].inputs[seedField] = (Number(baseSeed) + i) % 4294967296;
    }
    const promptId = await submit({ ...cfg, baseUrl }, req, current);
    if (req.onProgress) req.onProgress(i === 0 ? 'ComfyUI 工作流已提交，等待生成…' : `ComfyUI 正在生成第 ${i + 1}/${count} 张…`);
    const outputs = await waitForOutput({ ...cfg, baseUrl }, req, promptId);
    for (const item of outputs.slice(0, Math.max(0, requestedCount - images.length))) {
      images.push(await downloadOutput({ ...cfg, baseUrl }, req, item));
    }
    if (images.length >= requestedCount) break;
  }
  if (!images.length) throw codedError('ComfyUI 未生成任何图片', 'EMPTY_RESPONSE');
  return { images };
}

async function fetchModels(cfg) {
  const parsed = parseWorkflow(cfg.workflow);
  const classes = parsed.builtin
    ? ['CheckpointLoaderSimple']
    : Array.from(new Set(Object.values(parsed.workflow)
      .filter(node => MODEL_LOADERS[node.class_type]).map(node => node.class_type)));
  if (!classes.length) return [];
  const models = [];
  for (const classType of classes) {
    try {
      const resp = await axios.get(`${normalizeBaseUrl(cfg.baseUrl)}/object_info/${encodeURIComponent(classType)}`,
        requestConfig(cfg, null, { timeout: 15000 }));
      const field = MODEL_LOADERS[classType];
      const options = resp.data && resp.data[classType] && resp.data[classType].input_options &&
        resp.data[classType].input_options.required && resp.data[classType].input_options.required[field];
      for (const name of (options && options[0]) || []) {
        if (typeof name === 'string' && !models.includes(name)) models.push(name);
      }
    } catch (err) {
      if (!err || !err.response || err.response.status !== 404) throw err;
    }
  }
  return models;
}

module.exports = {
  key: 'comfyui',

  async generate(cfg, req) {
    return generateInternal(cfg, req, null);
  },

  async generateWithReference(cfg, req, refPath) {
    return generateInternal(cfg, req, refPath);
  },

  async fetchModels(cfg) {
    return fetchModels(cfg);
  },

  async verify(cfg) {
    try {
      await axios.get(`${normalizeBaseUrl(cfg.baseUrl)}/system_stats`, requestConfig(cfg, null, { timeout: 15000 }));
      return true;
    } catch (err) {
      throw providerError(err, 'ComfyUI 连接验证失败');
    }
  },

  async cancel(cfg, taskInfo) {
    const ids = taskInfo && (taskInfo.promptIds || (taskInfo.promptId ? [taskInfo.promptId] : []));
    if (!ids || !ids.length) return;
    try {
      await axios.post(`${normalizeBaseUrl(cfg.baseUrl)}/queue`, { delete: ids }, requestConfig(cfg, null, { timeout: 15000 }));
    } catch (err) {
      if (!err || !err.response || err.response.status !== 404) throw providerError(err, 'ComfyUI 取消任务失败');
    }
  },

  validateWorkflow,
  parseWorkflow,
  builtinWorkflow,
  normalizeBaseUrl,
  prepareWorkflow,
  autoNodeMap,
  safeOutputName,
  DEFAULT_BASE_URL
};
