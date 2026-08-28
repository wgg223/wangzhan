/**
 * Stability AI (SD3/SDXL) 适配器
 * multipart 接口：POST {base}/stable-image/generate/{model}，200 直接返回图片字节
 * 图生图：POST {base}/stable-image/edit/{model}，mode=image-to-image
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { parseSize } = require('../utils');

// sd3.5 用 aspect_ratio，sd3/sdxl 用 width/height
function isAspectRatioModel(model) {
  return /3\.5|3-5|stable-image-3/i.test(model || '');
}

module.exports = {
  key: 'stability',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const modelName = model || 'sd3.5-large';
    const { width, height } = parseSize(req.size);

    const form = new FormData();
    form.append('prompt', req.prompt);
    form.append('output_format', 'png');
    if (req.negativePrompt) form.append('negative_prompt', req.negativePrompt);
    if (req.seed) form.append('seed', String(req.seed));
    if (isAspectRatioModel(modelName)) {
      form.append('aspect_ratio', `${width}:${height}`);
    } else {
      form.append('width', String(width));
      form.append('height', String(height));
    }

    const resp = await axios.post(`${baseUrl}/stable-image/generate/${modelName}`, form, {
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 120000,
      maxContentLength: 20 * 1024 * 1024,
      responseType: 'arraybuffer'
    });

    if (resp.status !== 200 || !resp.data || !resp.data.length) {
      const err = new Error('Stability 未返回图片数据');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    return { images: [{ buffer: Buffer.from(resp.data), mime: resp.headers['content-type'] || 'image/png' }] };
  },

  async generateWithReference(cfg, req, refPath) {
    const { apiKey, baseUrl, model } = cfg;
    const modelName = model || 'sd3.5-large';
    const form = new FormData();
    form.append('image', fs.createReadStream(refPath), { filename: 'ref.png' });
    form.append('mode', 'image-to-image');
    form.append('prompt', req.prompt);
    if (req.negativePrompt) form.append('negative_prompt', req.negativePrompt);
    if (req.seed) form.append('seed', String(req.seed));

    const resp = await axios.post(`${baseUrl}/stable-image/edit/${modelName}`, form, {
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 120000,
      maxContentLength: 20 * 1024 * 1024,
      responseType: 'arraybuffer'
    });
    return { images: [{ buffer: Buffer.from(resp.data), mime: resp.headers['content-type'] || 'image/png' }] };
  },

  // Stability 无公开模型列表接口，手动配置
  async fetchModels() {
    return null;
  },

  // 轻量验证：GET /v2beta/user/balance，200 即 Key 有效
  async verify(cfg) {
    try {
      await axios.get(`${cfg.baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        timeout: 30000
      });
      return true;
    } catch (err) {
      return false;
    }
  }
};
