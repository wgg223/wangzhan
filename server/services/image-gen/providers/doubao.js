/**
 * 火山引擎豆包（Ark）图片生成适配器
 * 文生图、单图生图和多参考图统一使用 POST {base}/images/generations。
 * Seedream 5.0 pro / flash 的 image 最多 10 张，Seedream 4.0 最多 14 张。
 */
const axios = require('axios');
const { resolveImageItem, readImageDataUrl, normalizeApiBase } = require('../utils');

const DEFAULT_MODEL = 'doubao-seedream-4-0-250828';
const REQUEST_TIMEOUT = 120000;

/** 后台可能误填完整接口路径；统一还原到 Base URL，避免拼出 chat/completions/images/generations。 */
function generationBaseUrl(value) {
  return normalizeApiBase(value, [
    '/chat/completions', '/images/generations', '/images/edits', '/models'
  ]);
}

function referenceLimit(model) {
  return /doubao-seedream-5/i.test(model) ? 10 : 14;
}

/** Ark 要求 Base64 图片带 data:image/<格式>;base64, 前缀，不能只传裸 Base64。 */
async function imageDataUrl(filePath) {
  return readImageDataUrl(filePath);
}

async function requestImages(cfg, req, paths) {
  const { apiKey, baseUrl } = cfg;
  const model = cfg.model || req.model || DEFAULT_MODEL;
  const body = {
    model,
    prompt: req.prompt,
    size: req.size || '1024x1024',
    output_format: 'png',
    response_format: 'url'
  };
  if (paths.length) {
    const images = await Promise.all(paths.slice(0, referenceLimit(model)).map(imageDataUrl));
    body.image = images.length === 1 ? images[0] : images;
  }

  // 5.0 官方图片 API 未提供 negative_prompt / seed 字段，避免多余参数触发参数校验错误。
  // 4.0 继续保留旧版已支持的参数，保持存量配置兼容。
  if (!/doubao-seedream-5/i.test(model)) {
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed) body.seed = req.seed;
  }

  const endpoint = `${generationBaseUrl(baseUrl)}/images/generations`;
  const resp = await axios.post(endpoint, body, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
    signal: req.cancelRef && req.cancelRef.signal
  });
  const items = (resp.data && resp.data.data) || [];
  const images = await Promise.all(items.map(async item => ({
    buffer: await resolveImageItem(item),
    mime: 'image/png'
  })));
  if (!images.length) {
    const err = new Error('API 未返回图片数据');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  return { images };
}

module.exports = {
  key: 'doubao',
  supportsMultipleReferences: true,

  async generate(cfg, req) {
    return requestImages(cfg, req, []);
  },

  async generateWithReference(cfg, req, refPath) {
    const paths = Array.isArray(req.referenceImages) && req.referenceImages.length
      ? req.referenceImages
      : [refPath];
    return requestImages(cfg, req, paths.filter(Boolean));
  },

  async fetchModels(cfg) {
    const { apiKey, baseUrl } = cfg;
    try {
      const resp = await axios.get(`${generationBaseUrl(baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const list = (resp.data && resp.data.data) || [];
      const ids = list.map(m => m.id || m.model_name || m.endpoint_id).filter(Boolean);
      return ids.filter(id => /image|seedream|doubao|^ep-/i.test(String(id)));
    } catch (err) {
      return null;
    }
  }
};
