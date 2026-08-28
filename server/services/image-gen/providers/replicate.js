/**
 * Replicate 适配器（任务型）
 * ① POST {base}/models/{api_path}/predictions（api_path 如 black-forest-labs/flux-schnell）→ {id}
 * ② GET {base}/predictions/{id} 轮询 → succeeded → output（URL 数组）
 * 图生图：input.image 传 data URI
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { downloadImage, sleep, parseSize } = require('../utils');

const MAX_POLLS = 90; // 90 * 2s = 180s

function toDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

module.exports = {
  key: 'replicate',

  async generate(cfg, req) {
    const { apiKey, baseUrl, apiPath } = cfg;
    if (!apiPath) {
      const err = new Error('Replicate 未配置模型路径（api_path），如 black-forest-labs/flux-schnell');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const { width, height } = parseSize(req.size);
    const input = { prompt: req.prompt, width, height };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.seed) input.seed = req.seed;

    const createResp = await axios.post(`${baseUrl}/models/${apiPath}/predictions`, { input }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
    const predictionId = createResp.data && createResp.data.id;
    if (!predictionId) {
      const err = new Error('Replicate 未返回任务 ID');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(2000);
      let pollResp;
      try {
        pollResp = await axios.get(`${baseUrl}/predictions/${predictionId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000
        });
      } catch (err) {
        continue;
      }
      const data = pollResp.data || {};
      const status = data.status || '';
      if (status === 'succeeded') {
        const output = data.output;
        const urls = (Array.isArray(output) ? output : [output]).filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
        if (!urls.length) {
          const err = new Error('Replicate 任务成功但未返回图片地址');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        const images = [];
        for (const url of urls) {
          images.push({ buffer: await downloadImage(url), mime: 'image/png' });
        }
        return { images };
      }
      if (status === 'failed' || status === 'canceled') {
        const err = new Error(`Replicate 任务失败：${data.error || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('Replicate 任务超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  async generateWithReference(cfg, req, refPath) {
    const { apiKey, baseUrl, apiPath } = cfg;
    if (!apiPath) {
      const err = new Error('Replicate 未配置模型路径（api_path）');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const input = { prompt: req.prompt, image: toDataUri(refPath) };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.seed) input.seed = req.seed;

    const createResp = await axios.post(`${baseUrl}/models/${apiPath}/predictions`, { input }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
    const predictionId = createResp.data && createResp.data.id;
    if (!predictionId) {
      const err = new Error('Replicate 未返回任务 ID');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(2000);
      let pollResp;
      try {
        pollResp = await axios.get(`${baseUrl}/predictions/${predictionId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000
        });
      } catch (err) {
        continue;
      }
      const data = pollResp.data || {};
      const status = data.status || '';
      if (status === 'succeeded') {
        const output = data.output;
        const urls = (Array.isArray(output) ? output : [output]).filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
        if (!urls.length) {
          const err = new Error('Replicate 任务成功但未返回图片地址');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        const images = [];
        for (const url of urls) {
          images.push({ buffer: await downloadImage(url), mime: 'image/png' });
        }
        return { images };
      }
      if (status === 'failed' || status === 'canceled') {
        const err = new Error(`Replicate 任务失败：${data.error || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('Replicate 任务超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  // Replicate 模型发现接口复杂，手动配置
  async fetchModels() {
    return null;
  }
};
