/**
 * 智谱 CogView 适配器
 * OpenAI 兼容：POST {base}/paas/v4/images/generations（url 30 天有效，立即下载）
 */
const axios = require('axios');
const { resolveImageItem } = require('../utils');

module.exports = {
  key: 'zhipu',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'cogview-3-flash',
      prompt: req.prompt,
      size: req.size || '1024x1024',
      quality: 'standard'
    };
    const resp = await axios.post(`${baseUrl}/paas/v4/images/generations`, body, {
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
      const resp = await axios.get(`${baseUrl}/paas/v4/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const ids = (resp.data && resp.data.data || []).map(m => m.id || m).filter(Boolean);
      const imageModels = ids.filter(id => /image|cogview|glm-image/i.test(String(id)));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
