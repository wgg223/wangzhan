/**
 * 通义万相 DashScope 适配器
 * 异步任务：提交 image-synthesis（X-DashScope-Async: enable）→ 轮询 tasks/{task_id} → 取 url
 * 文生图与图生图使用不同端点；图生图参考图必须为 Data URL。
 */
const axios = require('axios');
const { apiUrl, downloadImageSafely, readImageDataUrl, sleep } = require('../utils');

const MAX_POLLS = 200; // 200 * 3s = 600s
const IMAGE_EDIT_MODEL = 'wanx2.1-imageedit';

function dashSize(size) {
  return String(size || '1024x1024').replace(/x/i, '*');
}

function pollError(message, output, taskId) {
  const err = new Error(message);
  err.code = 'PROVIDER_FAILED';
  err.fromPoll = true;
  err.taskId = taskId;
  err.providerCode = output && (output.code || output.error_code);
  err.requestId = output && (output.request_id || output.requestId);
  return err;
}

async function pollTask(cfg, req, taskId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    if (req.cancelRef && req.cancelRef.cancelled) {
      const err = new Error('任务已取消');
      err.code = 'CANCELLED';
      err.fromPoll = true;
      err.taskId = taskId;
      throw err;
    }
    await sleep(3000);
    let pollResp;
    try {
      pollResp = await axios.get(apiUrl(cfg.baseUrl, `/tasks/${encodeURIComponent(taskId)}`, [
        '/services/aigc/text2image/image-synthesis',
        '/services/aigc/image2image/image-synthesis'
      ]), {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        timeout: 30000,
        signal: req.cancelRef && req.cancelRef.signal
      });
    } catch (err) {
      if (err.code === 'CANCELLED' || err.code === 'ERR_CANCELED' ||
          (req.cancelRef && req.cancelRef.cancelled)) {
        const cancelled = new Error('任务已取消');
        cancelled.code = 'CANCELLED';
        cancelled.fromPoll = true;
        cancelled.taskId = taskId;
        throw cancelled;
      }
      // 轮询瞬时网络错误继续重试；任务已提交，不能重新提交计费任务。
      continue;
    }
    const output = pollResp.data && pollResp.data.output;
    if (!output) continue;
    const status = output.task_status || '';
    if (status === 'SUCCEEDED') {
      const images = [];
      for (const result of output.results || []) {
        if (!result.url) continue;
        images.push({
          buffer: await downloadImageSafely(result.url, {
            signal: req.cancelRef && req.cancelRef.signal
          }),
          mime: 'image/png'
        });
      }
      if (!images.length) {
        throw pollError('通义万相任务成功但未返回图片', output, taskId);
      }
      return images;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      const detail = [output.code, output.message].filter(Boolean).join('：');
      throw pollError(`通义万相生成失败${detail ? `：${detail}` : `：${status}`}`, output, taskId);
    }
  }
  const err = new Error('通义万相生成超时');
  err.code = 'TIMEOUT';
  err.fromPoll = true;
  err.taskId = taskId;
  throw err;
}

async function submitTask(cfg, req, endpoint, body) {
  const resp = await axios.post(
    apiUrl(cfg.baseUrl, endpoint, [
      '/services/aigc/text2image/image-synthesis',
      '/services/aigc/image2image/image-synthesis'
    ]),
    body,
    {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      timeout: 60000,
      signal: req.cancelRef && req.cancelRef.signal
    }
  );
  const output = resp.data && resp.data.output;
  const taskId = output && output.task_id;
  if (!taskId) {
    const err = new Error('通义万相未返回任务 ID');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  return taskId;
}

module.exports = {
  key: 'dashscope',

  async generate(cfg, req) {
    const model = cfg.model || 'wanx-v1';
    const input = { prompt: req.prompt };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    const parameters = { size: dashSize(req.size), n: req.n || 1 };
    if (req.seed) parameters.seed = req.seed;

    const taskId = await submitTask(cfg, req,
      '/services/aigc/text2image/image-synthesis', { model, input, parameters });
    if (req.taskInfo) req.taskInfo.taskId = taskId;
    return { images: await pollTask(cfg, req, taskId), model };
  },

  async generateWithReference(cfg, req, refPath) {
    // 旧默认值包含文生图模型； Wan2.1 图生图必须切换到官方 imageedit 模型。
    const model = !cfg.model || /^(?:wanx-v1|wan2\.1-t2i-turbo)$/i.test(cfg.model)
      ? IMAGE_EDIT_MODEL
      : cfg.model;
    const input = {
      function: 'description_edit',
      prompt: req.prompt,
      base_image_url: await readImageDataUrl(refPath)
    };
    const parameters = { n: req.n || 1 };
    if (req.seed) parameters.seed = req.seed;

    const taskId = await submitTask(cfg, req,
      '/services/aigc/image2image/image-synthesis', { model, input, parameters });
    if (req.taskInfo) req.taskInfo.taskId = taskId;
    return { images: await pollTask(cfg, req, taskId), model };
  },

  // DashScope 模型列表接口不稳定，手动配置
  async fetchModels() {
    return null;
  }
};
