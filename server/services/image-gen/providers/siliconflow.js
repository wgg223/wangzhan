/**
 * 硅基流动 SiliconFlow 适配器
 * OpenAI 兼容 JSON：POST {base}/images/generations（url 1 小时有效，立即下载）
 * 图生图：POST {base}/images/edits（multipart，image 文件）
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { resolveImageItem } = require('../utils');

module.exports = {
  key: 'siliconflow',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'black-forest-labs/FLUX.1-schnell',
      prompt: req.prompt,
      image_size: req.size || '1024x1024',
      batch_size: req.n || 1
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed) body.seed = req.seed;

    const resp = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
      signal: req.cancelRef && req.cancelRef.signal
    });
    const items = (resp.data && resp.data.images) || [];
    const images = [];
    for (const item of items) {
      images.push({ buffer: await resolveImageItem(item), mime: 'image/png' });
    }
    if (!images.length) {
      const err = new Error('API 未返回图片数据');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    return { images };
  },

  async generateWithReference(cfg, req, refPath) {
    const { apiKey, baseUrl, model } = cfg;
    const form = new FormData();
    form.append('model', model || 'black-forest-labs/FLUX.1-dev');
    form.append('image', fs.createReadStream(refPath), { filename: 'ref.png' });
    form.append('prompt', req.prompt);
    form.append('image_size', req.size || '1024x1024');
    if (req.seed) form.append('seed', String(req.seed));

    const resp = await axios.post(`${baseUrl}/images/edits`, form, {
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 120000,
      signal: req.cancelRef && req.cancelRef.signal
    });
    const items = (resp.data && resp.data.images) || [];
    const images = [];
    for (const item of items) {
      images.push({ buffer: await resolveImageItem(item), mime: 'image/png' });
    }
    if (!images.length) {
      const err = new Error('API 未返回图片数据');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    return { images };
  },

  async fetchModels(cfg) {
    const { apiKey, baseUrl } = cfg;
    try {
      const resp = await axios.get(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const ids = (resp.data && resp.data.data || []).map(m => m.id).filter(Boolean);
      const imgRe = /image|flux|sd3|sdxl|qwen-image|kolors|playground|stable|hunyuan-image|wan/i;
      const imageModels = ids.filter(id => imgRe.test(id));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
