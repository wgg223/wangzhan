/**
 * Pollinations.ai 适配器（免 API Key）
 * GET {base}/prompt/{prompt}?width=&height=&model=&nologo=true&seed= 直接返回图片字节
 * 匿名限流 1 次/15s → 模块内节流 + 失败重试 1 次
 */
const axios = require('axios');
const { parseSize, sleep } = require('../utils');

let lastRequestAt = 0;
const MIN_INTERVAL = 15000;

async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL - Date.now();
  if (wait > 0) {
    await sleep(wait);
  }
  lastRequestAt = Date.now();
}

module.exports = {
  key: 'pollinations',

  async generate(cfg, req) {
    const { baseUrl } = cfg;
    const { width, height } = parseSize(req.size);
    const model = cfg.model || 'flux';
    const url = `${baseUrl}/prompt/${encodeURIComponent(req.prompt)}` +
      `?width=${width}&height=${height}&model=${encodeURIComponent(model)}` +
      `&nologo=true${req.seed ? '&seed=' + req.seed : ''}`;

    let buffer = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await throttle();
      try {
        const resp = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 120000,
          maxContentLength: 20 * 1024 * 1024
        });
        buffer = Buffer.from(resp.data);
        break;
      } catch (err) {
        if (attempt === 1) throw err;
        await sleep(3000);
      }
    }
    if (!buffer || !buffer.length) {
      const err = new Error('Pollinations 未返回图片数据');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    return { images: [{ buffer, mime: 'image/jpeg' }] };
  },

  async fetchModels(cfg) {
    const { baseUrl } = cfg;
    try {
      const resp = await axios.get(`${baseUrl}/models`, { timeout: 15000 });
      const data = resp.data;
      if (Array.isArray(data)) return data.map(String);
      if (data && Array.isArray(data.models)) return data.models.map(String);
      return null;
    } catch (err) {
      return null;
    }
  }
};
