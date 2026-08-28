/**
 * 阶跃星辰 StepFun 适配器
 * OpenAI 兼容：POST {base}/images/generations（api_base 默认 https://api.stepfun.com/v1）
 */
const axios = require('axios');
const { resolveImageItem } = require('../utils');

module.exports = {
  key: 'stepfun',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const body = {
      model: model || 'step-1x-medium',
      prompt: req.prompt,
      n: req.n || 1,
      size: req.size || '1024x1024',
      response_format: 'b64_json'
    };
    if (req.seed) body.seed = req.seed;
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

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
      const imageModels = ids.filter(id => /image|step-1x/i.test(id));
      return imageModels;
    } catch (err) {
      return null;
    }
  }
};
