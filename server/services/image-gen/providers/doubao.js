/**
 * 火山引擎豆包（Ark）适配器
 * OpenAI 兼容：POST {base}/images/generations（api_base 默认 https://ark.cn-beijing.volces.com/api/v3）
 * 图生图：POST {base}/images/edits（doubao-seedream 系列，image 传 base64）
 */
const axios = require('axios');
const fs = require('fs');
const { resolveImageItem } = require('../utils');

module.exports = {
  key: 'doubao',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'doubao-seedream-3-0-t2i-250528',
      prompt: req.prompt,
      size: req.size || '1024x1024',
      response_format: 'url'
    };
    if (req.seed) body.seed = req.seed;
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

    const resp = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000
    });
    const images = [];
    for (const item of (resp.data && resp.data.data) || []) {
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
    const imageB64 = fs.readFileSync(refPath).toString('base64');
    const body = {
      model: model || 'doubao-seedream-3-0-t2i-250528',
      prompt: req.prompt,
      image: imageB64
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

    const resp = await axios.post(`${baseUrl}/images/edits`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000
    });
    const images = [];
    for (const item of (resp.data && resp.data.data) || []) {
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
      const list = (resp.data && resp.data.data) || [];
      const ids = list.map(m => m.id || m.model_name || m.endpoint_id).filter(Boolean);
      const imageModels = ids.filter(id => /image|seedream|doubao/i.test(String(id)));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
