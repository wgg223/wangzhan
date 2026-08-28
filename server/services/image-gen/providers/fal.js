/**
 * fal.ai 适配器（任务队列型）
 * ① POST {base}/{app_id}（api_path 如 fal-ai/flux/dev；queue.fal.run 异步）Header: Authorization: Key <key>
 * ② GET {base}/{app_id}/requests/{request_id}/status → COMPLETED → GET {base}/{app_id}/requests/{request_id} → images[].url
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { downloadImage, sleep } = require('../utils');

const MAX_POLLS = 60; // 60 * 3s = 180s

function toDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

module.exports = {
  key: 'fal',

  async generate(cfg, req) {
    const { apiKey, baseUrl, apiPath } = cfg;
    if (!apiPath) {
      const err = new Error('fal.ai 未配置 app_id（api_path），如 fal-ai/flux/dev');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
    const body = {
      prompt: req.prompt,
      image_size: req.size || '1024x1024',
      num_images: req.n || 1
    };
    if (req.seed) body.seed = req.seed;

    const submitResp = await axios.post(`${baseUrl}/${apiPath}`, body, {
      headers,
      timeout: 60000
    });
    const requestId = submitResp.data && submitResp.data.request_id;
    if (!requestId) {
      const err = new Error('fal.ai 未返回 request_id');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(3000);
      let statusResp;
      try {
        statusResp = await axios.get(`${baseUrl}/${apiPath}/requests/${requestId}/status`, { headers, timeout: 30000 });
      } catch (err) {
        continue;
      }
      const status = (statusResp.data && statusResp.data.status || '').toUpperCase();
      if (status === 'COMPLETED') {
        let resultResp;
        try {
          resultResp = await axios.get(`${baseUrl}/${apiPath}/requests/${requestId}`, { headers, timeout: 30000 });
        } catch (err) {
          const e = new Error('fal.ai 获取结果失败');
          e.code = 'FETCH_FAILED';
          throw e;
        }
        const items = (resultResp.data && resultResp.data.images) || [];
        const images = [];
        for (const item of items) {
          const url = item && (item.url || item.image_url);
          if (!url) continue;
          images.push({ buffer: await downloadImage(url), mime: (item && item.content_type) || 'image/png' });
        }
        if (!images.length) {
          const err = new Error('fal.ai 任务成功但未解析到图片地址');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        return { images };
      }
      if (status === 'FAILED' || status === 'CANCELLED' || status === 'ERROR') {
        const err = new Error(`fal.ai 任务失败：${(statusResp.data && statusResp.data.error) || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('fal.ai 任务超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  async generateWithReference(cfg, req, refPath) {
    const { apiKey, baseUrl, apiPath } = cfg;
    if (!apiPath) {
      const err = new Error('fal.ai 未配置 app_id（api_path）');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
    const body = {
      prompt: req.prompt,
      image_url: toDataUri(refPath)
    };
    if (req.seed) body.seed = req.seed;

    const submitResp = await axios.post(`${baseUrl}/${apiPath}`, body, { headers, timeout: 60000 });
    const requestId = submitResp.data && submitResp.data.request_id;
    if (!requestId) {
      const err = new Error('fal.ai 未返回 request_id');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(3000);
      let statusResp;
      try {
        statusResp = await axios.get(`${baseUrl}/${apiPath}/requests/${requestId}/status`, { headers, timeout: 30000 });
      } catch (err) {
        continue;
      }
      const status = (statusResp.data && statusResp.data.status || '').toUpperCase();
      if (status === 'COMPLETED') {
        let resultResp;
        try {
          resultResp = await axios.get(`${baseUrl}/${apiPath}/requests/${requestId}`, { headers, timeout: 30000 });
        } catch (err) {
          const e = new Error('fal.ai 获取结果失败');
          e.code = 'FETCH_FAILED';
          throw e;
        }
        const items = (resultResp.data && resultResp.data.images) || [];
        const images = [];
        for (const item of items) {
          const url = item && (item.url || item.image_url);
          if (!url) continue;
          images.push({ buffer: await downloadImage(url), mime: (item && item.content_type) || 'image/png' });
        }
        if (!images.length) {
          const err = new Error('fal.ai 任务成功但未解析到图片地址');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        return { images };
      }
      if (status === 'FAILED' || status === 'CANCELLED' || status === 'ERROR') {
        const err = new Error(`fal.ai 任务失败：${(statusResp.data && statusResp.data.error) || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('fal.ai 任务超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  // fal.ai 模型目录在其网站维护，手动配置
  async fetchModels() {
    return null;
  }
};
