/**
 * RunningHub 适配器（任务轮询型）
 * ① POST {base}/{api_path}（默认 https://www.runninghub.cn/openapi/v2）Bearer → taskId
 * ② POST {base}/query {taskId} 轮询 → 输出图片 url
 *
 * 解析策略：递归搜索整个响应对象中的图片 URL，兼容 output/data/outputs/images/result
 * 等任意嵌套层级；元素为字符串或 {url|image_url|src|path|image|img|file|download_url} 对象。
 * 调试：提交/轮询/解析失败均打印日志，方便对照 RunningHub 平台实际返回结构。
 */
const axios = require('axios');
const { downloadImage, sleep } = require('../utils');

const MAX_POLLS = 200; // 200 * 3s = 600s

// 判断字符串是否像图片 URL
function looksLikeImageUrl(str, fieldName) {
  if (typeof str !== 'string' || !/^https?:\/\//i.test(str)) return false;
  const hasImageExt = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)(\?|$)/i.test(str);
  const isImageField = fieldName && /(url|image|img|src|path|file|download|pic|photo|output|result)/i.test(fieldName);
  return hasImageExt || isImageField;
}

// 递归搜索对象中的图片 URL（深度优先，防循环，最多 10 层）
function extractUrls(result) {
  const urls = [];
  const seen = new Set();

  function walk(obj, depth, fieldName) {
    if (depth > 10 || obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      if (looksLikeImageUrl(obj, fieldName) && !urls.includes(obj)) {
        urls.push(obj);
      }
      return;
    }
    if (typeof obj !== 'object') return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], depth + 1, fieldName);
      }
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      walk(value, depth + 1, key);
    }
  }

  walk(result, 0, null);
  return urls;
}

// 递归查找状态字段（兼容 data.status / data.data.status / taskStatus 等）
function extractStatus(data) {
  let found = '';

  function walk(obj, depth) {
    if (found || depth > 5 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (/(status|state|task_status|taskStatus|taskState)/i.test(key) && typeof value === 'string') {
        found = value.toUpperCase();
        return;
      }
      if (value && typeof value === 'object') {
        walk(value, depth + 1);
        if (found) return;
      }
    }
  }

  walk(data, 0);
  return found;
}

// 递归查找任务 ID（兼容 taskId / task_id / id / data.taskId 等）
function pickTaskId(respData) {
  let found = null;

  function walk(obj, depth) {
    if (found || depth > 5 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (/^(taskId|task_id|id|taskID|taskIdStr)$/i.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        found = String(value);
        return;
      }
      if (value && typeof value === 'object') {
        walk(value, depth + 1);
        if (found) return;
      }
    }
  }

  walk(respData, 0);
  return found;
}

// 从 model 配置字符串解析工作流节点映射，格式 "nodeId:fieldName"（例如 "6:text"）
function parseNodeField(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return null;
  const idx = modelStr.indexOf(':');
  if (idx <= 0) return null;
  const nodeId = modelStr.substring(0, idx).trim();
  const fieldName = modelStr.substring(idx + 1).trim();
  if (!nodeId || !fieldName) return null;
  return { nodeId, fieldName };
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

    // 判断是否为工作流 API（/run/workflow/{id}）
    const isWorkflow = apiPath && apiPath.includes('/workflow/');

    // 构建提交任务请求体
    let submitBody;
    if (isWorkflow) {
      // 工作流 API：必须使用 nodeInfoList 格式传递参数
      // model 字段用于配置 prompt 对应的节点映射，格式为 "nodeId:fieldName"，例如 "6:text"
      // nodeId 和 fieldName 需从 RunningHub 后台工作流导出的 JSON 中查看
      const promptNode = parseNodeField(cfg.model);
      if (!promptNode) {
        const err = new Error('RunningHub 工作流 API 需在「模型」字段配置 prompt 节点映射（格式：nodeId:fieldName，例如 6:text），请在后台服务商配置中填写');
        err.code = 'BAD_CONFIG';
        throw err;
      }
      submitBody = {
        nodeInfoList: [
          {
            nodeId: promptNode.nodeId,
            fieldName: promptNode.fieldName,
            fieldValue: req.prompt
          }
        ],
        randomSeed: true,
        retainSeconds: 0,
        usePersonalQueue: false
      };
      // 负面提示词（如果配置了 negative 节点映射，格式为 cfg.negativeNode，暂通过 model 扩展支持）
      if (req.negativePrompt) {
        // 负面提示词节点需额外配置，暂不自动传递（可在工作流中设置默认负面提示词）
        console.log('[RunningHub] 负面提示词已传入但工作流未配置 negative 节点映射，将忽略（可在 RunningHub 工作流中设置默认负面提示词）');
      }
    } else {
      // 标准模型 API：简单 { prompt } 格式
      submitBody = { prompt: req.prompt };
      if (cfg.model) submitBody.model = cfg.model;
      if (req.negativePrompt) submitBody.negative_prompt = req.negativePrompt;
    }

    console.log('[RunningHub] 提交任务 body:', JSON.stringify(submitBody));

    const submitResp = await axios.post(`${baseUrl}/${apiPath}`, submitBody, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024
    });

    console.log('[RunningHub] 提交响应:', JSON.stringify(submitResp.data).slice(0, 500));

    const taskId = pickTaskId(submitResp.data);
    if (!taskId) {
      const err = new Error('RunningHub 未返回任务 ID，请检查 api_path 配置（提交响应已打印到日志）');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    console.log('[RunningHub] taskId =', taskId);
    if (req.taskInfo) req.taskInfo.taskId = taskId;

    // 轮询任务结果
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
          timeout: 30000,
          maxContentLength: 100 * 1024 * 1024,
          maxBodyLength: 100 * 1024 * 1024
        });
      } catch (err) {
        // 响应体过大时打印警告，继续轮询（下一次可能返回不同大小的响应）
        if (err.code === 'ERR_BAD_RESPONSE' || (err.message && err.message.includes('maxContentLength'))) {
          console.warn(`[RunningHub] 轮询 #${i} 响应体过大，继续轮询:`, err.message);
        }
        continue;
      }

      const data = queryResp.data || {};
      const status = extractStatus(data);

      // 每 10 次轮询打印一次状态，避免日志过多
      if (i % 10 === 0) {
        console.log(`[RunningHub] 轮询 #${i} status=${status} 响应片段=${JSON.stringify(data).slice(0, 300)}`);
      }

      // 任务成功：递归提取图片 URL
      if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE', 'FINISHED', 'OK'].includes(status)) {
        const urls = extractUrls(data);
        console.log('[RunningHub] 任务成功，提取到图片 URL 数量:', urls.length, urls.slice(0, 3));

        if (!urls.length) {
          // 解析失败时打印完整响应，方便对照 RunningHub 平台实际返回结构排查
          console.error('[RunningHub] 图片 URL 解析失败，完整响应如下：');
          console.error(JSON.stringify(data, null, 2).slice(0, 4000));
          const err = new Error('RunningHub 任务成功但未解析到图片地址（请查看服务器日志中 [RunningHub] 完整响应，对照 RunningHub 平台返回结构）');
          err.code = 'EMPTY_RESPONSE';
          throw err;
        }

        const images = [];
        for (const url of urls) {
          images.push({ buffer: await downloadImage(url), mime: 'image/png' });
        }
        return { images };
      }

      // 任务失败
      if (['FAILED', 'ERROR', 'FAIL', 'CANCELLED', 'CANCELED'].includes(status)) {
        const errMsg = data.message || data.error || data.msg || data.err || status;
        const err = new Error(`RunningHub 任务失败：${errMsg}`);
        err.code = 'PROVIDER_FAILED';
        throw err;
      }
    }

    const err = new Error('RunningHub 任务超时（轮询 200 次 / 600 秒）');
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
