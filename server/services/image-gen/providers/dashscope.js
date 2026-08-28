/**
 * 通义万相 DashScope 适配器
 * 异步任务：提交 image-synthesis（X-DashScope-Async: enable）→ 轮询 tasks/{task_id} → 取 url
 * 尺寸参数使用 * 号（如 1024*1024）；图生图：input.image 传 base64
 */
const axios = require('axios');
const fs = require('fs');
const { downloadImage, sleep } = require('../utils');

const MAX_POLLS = 60; // 60 * 3s = 180s

function dashSize(size) {
  return String(size || '1024x1024').replace(/x/i, '*');
}

module.exports = {
  key: 'dashscope',

  async generate(cfg, req) {
    const { apiKey, baseUrl, model } = cfg;
    const input = { prompt: req.prompt };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    const parameters = { size: dashSize(req.size), n: req.n || 1 };
    if (req.seed) parameters.seed = req.seed;

    const submitResp = await axios.post(
      `${baseUrl}/services/aigc/text2image/image-synthesis`,
      { model: model || 'wanx-v1', input, parameters },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 60000
      }
    );
    const taskId = submitResp.data && submitResp.data.output && submitResp.data.output.task_id;
    if (!taskId) {
      const err = new Error('通义万相未返回任务 ID');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }

    // 轮询任务状态
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(3000);
      let pollResp;
      try {
        pollResp = await axios.get(`${baseUrl}/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000
        });
      } catch (err) {
        // 轮询瞬时错误继续重试，直至超时
        continue;
      }
      const output = pollResp.data && pollResp.data.output;
      if (!output) continue;
      const status = output.task_status || '';
      if (status === 'SUCCEEDED') {
        const results = output.results || [];
        const images = [];
        for (const r of results) {
          if (!r.url) continue;
          images.push({ buffer: await downloadImage(r.url), mime: 'image/png' });
        }
        if (!images.length) {
          const err = new Error('通义万相任务成功但未返回图片');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        return { images };
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        const err = new Error(`通义万相生成失败：${output.message || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('通义万相生成超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  async generateWithReference(cfg, req, refPath) {
    // wan2.1-t2i-turbo 等模型支持 input.image 参考图
    const { apiKey, baseUrl, model } = cfg;
    const imageB64 = fs.readFileSync(refPath).toString('base64');
    const input = { prompt: req.prompt, image: imageB64 };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    const parameters = { size: dashSize(req.size), n: req.n || 1 };
    if (req.seed) parameters.seed = req.seed;

    const submitResp = await axios.post(
      `${baseUrl}/services/aigc/text2image/image-synthesis`,
      { model: model || 'wan2.1-t2i-turbo', input, parameters },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 60000
      }
    );
    const taskId = submitResp.data && submitResp.data.output && submitResp.data.output.task_id;
    if (!taskId) {
      const err = new Error('通义万相未返回任务 ID');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(3000);
      let pollResp;
      try {
        pollResp = await axios.get(`${baseUrl}/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000
        });
      } catch (err) {
        continue;
      }
      const output = pollResp.data && pollResp.data.output;
      if (!output) continue;
      const status = output.task_status || '';
      if (status === 'SUCCEEDED') {
        const results = output.results || [];
        const images = [];
        for (const r of results) {
          if (!r.url) continue;
          images.push({ buffer: await downloadImage(r.url), mime: 'image/png' });
        }
        if (!images.length) {
          const err = new Error('通义万相任务成功但未返回图片');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        return { images };
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        const err = new Error(`通义万相生成失败：${output.message || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('通义万相生成超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  // DashScope 模型列表接口不稳定，手动配置
  async fetchModels() {
    return null;
  }
};
