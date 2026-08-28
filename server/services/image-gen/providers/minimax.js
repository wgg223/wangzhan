/**
 * MiniMax 适配器
 * OpenAI 兼容：POST {base}/images/generations（api_base 默认 https://api.minimax.chat/v1）
 * 尺寸用 aspect_ratio（1:1 / 16:9 / 9:16 / 3:4 / 4:3）
 */
const axios = require('axios');
const { resolveImageItem } = require('../utils');

function toAspectRatio(size) {
  const m = String(size || '').match(/^(\d{1,4})[x*](\d{1,4})$/);
  if (!m) return '1:1';
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w / h >= 1.7) return '16:9';
  if (h / w >= 1.7) return '9:16';
  if (w / h >= 1.3) return '4:3';
  if (h / w >= 1.3) return '3:4';
  return '1:1';
}

module.exports = {
  key: 'minimax',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'image-01',
      prompt: req.prompt,
      n: req.n || 1,
      aspect_ratio: toAspectRatio(req.size),
      response_format: 'url'
    };
    const resp = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
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
      const imageModels = ids.filter(id => /image/i.test(id));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
