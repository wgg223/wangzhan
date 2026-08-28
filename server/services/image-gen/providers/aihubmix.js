/**
 * AIHubMix 适配器（OpenAI 兼容聚合中转站，官方文档 docs.aihubmix.com）
 * 文生图：POST {base}/images/generations（url/b64_json，url 有效期 24h 需立即下载）
 * 图生图：POST {base}/images/edits（multipart：model/prompt/image/size）
 * 模型：gpt-image 系列 / dall-e / qwen-image / glm-image / doubao-seedream / flux / wan / imagen 等
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { resolveImageItem } = require('../utils');

function parseItems(data) {
  return (data && data.data) || [];
}

module.exports = {
  key: 'aihubmix',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'gpt-image-1',
      prompt: req.prompt,
      n: req.n || 1,
      size: req.size || '1024x1024',
      response_format: 'url'
    };
    const resp = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
      signal: req.cancelRef && req.cancelRef.signal
    });
    const images = [];
    for (const item of parseItems(resp.data)) {
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
    form.append('model', model || 'gpt-image-1');
    form.append('prompt', req.prompt);
    form.append('image', fs.createReadStream(refPath), { filename: 'ref.png' });
    form.append('size', req.size || '1024x1024');
    if (req.n > 1) form.append('n', String(req.n));

    const resp = await axios.post(`${baseUrl}/images/edits`, form, {
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 120000,
      signal: req.cancelRef && req.cancelRef.signal
    });
    const images = [];
    for (const item of parseItems(resp.data)) {
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
      const imgRe = /image|dall|flux|sdxl|sd3|seedream|gpt-image|stable|playground|imagen|wan|qwen|glm|ideogram|nano-banana/i;
      const imageModels = ids.filter(id => imgRe.test(id));
      return imageModels.length ? imageModels : ids.slice(0, 50);
    } catch (err) {
      return null;
    }
  }
};
