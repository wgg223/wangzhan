/**
 * OpenAI DALL·E 3 适配器
 * JSON 同步接口：POST {base}/images/generations
 */
const axios = require('axios');
const { resolveImageItem } = require('../utils');

// DALL·E 3 仅支持固定尺寸与 n=1
const DALL_E_SIZES = ['1024x1024', '1024x1792', '1792x1024'];

module.exports = {
  key: 'openai',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const size = DALL_E_SIZES.includes(req.size) ? req.size : '1024x1024';
    const body = {
      model: model || 'dall-e-3',
      prompt: req.prompt,
      n: 1,
      size,
      quality: 'standard',
      response_format: 'b64_json'
    };
    const resp = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 90000,
      signal: req.cancelRef && req.cancelRef.signal
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
      const ids = (resp.data && resp.data.data || []).map(m => m.id).filter(Boolean);
      const imageModels = ids.filter(id => /image|dall/i.test(id));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
