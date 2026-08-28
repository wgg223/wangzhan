/**
 * RunningHub 适配器（任务轮询型）
 * ① POST {base}/{api_path}（默认 https://www.runninghub.cn/openapi/v2）Bearer → taskId
 * ② POST {base}/query {taskId} 轮询 → 输出图片 url
 * 输出解析容错 output/data/outputs/images 数组（元素为 {url} 或字符串）
 */
const axios = require('axios');
const { downloadImage, sleep } = require('../utils');

const MAX_POLLS = 200; // 200 * 3s = 600s

// 从任务结果对象中提取图片 URL 列表（容错解析）
function extractUrls(result) {
  const urls = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === 'string' && /^https?:\/\//.test(item)) {
        urls.push(item);
      } else if (item && typeof item === 'object') {
        for (const k of ['url', 'image_url', 'src', 'path']) {
          if (typeof item[k] === 'string' && /^https?:\/\//.test(item[k])) {
            urls.push(item[k]);
            break;
          }
        }
      }
    }
  };
  if (result && typeof result === 'object') {
    for (const k of ['output', 'data', 'outputs', 'images', 'result']) {
      push(result[k]);
    }
    push(result);
  }
  return urls;
}

function pickTaskId(respData) {
  if (!respData || typeof respData !== 'object') return null;
  return respData.taskId || respData.task_id || respData.id || null;
}

module.exports = {
  key: 'runninghub',

  async generate(cfg, req) {
    const { apiKey, baseUrl, apiPath } = cfg;
    if (!apiPath) {
      const err = new Error('RunningHub 未配置提交任务 endpoint（api_path），请在后台填写');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const submitBody = { prompt: req.prompt };
    if (cfg.model) submitBody.model = cfg.model;
    if (req.negativePrompt) submitBody.negative_prompt = req.negativePrompt;

    const submitResp = await axios.post(`${baseUrl}/${apiPath}`, submitBody, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
    const taskId = pickTaskId(submitResp.data);
    if (!taskId) {
      const err = new Error('RunningHub 未返回任务 ID，请检查 api_path 配置');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    if (req.taskInfo) req.taskInfo.taskId = taskId;

    for (let i = 0; i < MAX_POLLS; i++) {
      if (req.cancelRef && req.cancelRef.cancelled) {
        const err = new Error('任务已取消');
        err.code = 'CANCELLED';
        throw err;
      }
      await sleep(3000);
      let queryResp;
      try {
        queryResp = await axios.post(`${baseUrl}/query`, { taskId }, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000
        });
      } catch (err) {
        continue;
      }
      const data = queryResp.data || {};
      const status = String(data.status || data.task_status || data.state || '').toUpperCase();
      if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'COMPLETED' || status === 'DONE') {
        const urls = extractUrls(data);
        if (!urls.length) {
          const err = new Error('RunningHub 任务成功但未解析到图片地址');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }
        const images = [];
        for (const url of urls) {
          images.push({ buffer: await downloadImage(url), mime: 'image/png' });
        }
        return { images };
      }
      if (status === 'FAILED' || status === 'ERROR') {
        const err = new Error(`RunningHub 任务失败：${data.message || data.error || status}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }
    const err = new Error('RunningHub 任务超时');
    err.code = 'TIMEOUT';
    throw err;
  },

  // RunningHub 模型列表随工作流/模型 API 不同，手动配置
  async fetchModels() {
    return null;
  }

  // 说明：RunningHub openapi v2 仅提供提交任务与查询结果接口，无官方取消接口，
  // 取消任务只能停止轮询，远程任务会继续运行直至完成（平台限制，无法避免消耗）
};
