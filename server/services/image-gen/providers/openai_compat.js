/**
 * 通用 OpenAI 兼容适配器
 *
 * 目的：一个适配器接住所有「标准 OpenAI 图片协议」的站点（官方、中转站、自建网关），
 * 后台只需填站点 Base URL + Key + 模型，就能以平台实例的形式出现在前台下拉里。
 *
 * 接口约定：
 *  - 文生图：POST {base}/images/generations，返回 data[].b64_json 或 data[].url
 *  - 图生图：POST {base}/images/edits（multipart），站点不支持时给出明确报错
 *  - 模型：  GET  {base}/models
 *  - 余额：  GET  {base}/dashboard/billing/subscription + credit_grants（部分站点实现）
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { downloadImageSafely, sniffImageType, MAX_IMAGE_SIZE } = require('../utils');

const MAX_COUNT = 4;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function trimBase(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw codedError('未配置站点 Base URL（例如 https://example.com/v1）', 'BAD_CONFIG');
  return base;
}

function joinPath(baseUrl, apiPath, fallback) {
  const suffix = String(apiPath || fallback || '').trim();
  if (!suffix) return trimBase(baseUrl);
  if (/^https?:\/\//i.test(suffix)) return suffix.replace(/\/+$/, '');
  return `${trimBase(baseUrl)}/${suffix.replace(/^\/+/, '')}`;
}

function getHeaders(cfg) {
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) throw codedError('该平台未配置 API Key', 'BAD_CONFIG');
  return { Authorization: `Bearer ${apiKey}` };
}

function normalizeCount(value) {
  return Math.min(Math.max(parseInt(value, 10) || 1, 1), MAX_COUNT);
}

/**
 * 从 OpenAI 兼容响应里取图片：优先 b64，其次 url（走安全下载）。
 * @param {Object} data
 * @param {Object} req
 * @returns {Promise<{images: Array<{buffer: Buffer, mime: string}>, model?: string, size?: string}>}
 */
async function collectImages(data, req) {
  const body = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(body.data) ? body.data : (Array.isArray(body.images) ? body.images : []);
  const signal = req && req.cancelRef && req.cancelRef.signal;
  const images = [];
  for (const item of list) {
    const entry = typeof item === 'string' ? { url: item } : (item || {});
    const b64 = entry.b64_json || entry.b64_image || entry.image_base64;
    if (b64) {
      const buffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const type = sniffImageType(buffer);
      if (!type) throw codedError('站点返回的 base64 不是有效图片', 'INVALID_IMAGE');
      images.push({ buffer, mime: type.mime });
      continue;
    }
    const url = entry.url || entry.image_url || entry.imageUrl;
    if (url) {
      const buffer = await downloadImageSafely(url, { signal });
      const type = sniffImageType(buffer);
      if (!type) throw codedError('站点返回的图片地址内容不是有效图片', 'INVALID_IMAGE');
      if (buffer.length > MAX_IMAGE_SIZE) throw codedError('生成图片超过大小限制', 'IMAGE_TOO_LARGE');
      images.push({ buffer, mime: type.mime });
    }
  }
  if (!images.length) throw codedError('站点未返回任何图片数据', 'EMPTY_RESPONSE');
  return {
    images,
    model: typeof body.model === 'string' ? body.model : undefined,
    size: typeof body.size === 'string' ? body.size : undefined
  };
}

function buildMultipart(fields, file) {
  const boundary = `----ttai${crypto.randomBytes(10).toString('hex')}`;
  const parts = [];
  Object.keys(fields).forEach((name) => {
    const value = fields[name];
    if (value === undefined || value === null || value === '') return;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  });
  const filename = path.basename(file.filename || 'reference.png').replace(/["\r\n]/g, '_');
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n`
    + `Content-Type: ${file.mime || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readReference(refPath) {
  const buffer = await fs.promises.readFile(refPath);
  if (!buffer.length) throw codedError('参考图为空', 'INVALID_IMAGE');
  if (buffer.length > MAX_IMAGE_SIZE) throw codedError('参考图超过大小限制', 'IMAGE_TOO_LARGE');
  const type = sniffImageType(buffer);
  if (!type) throw codedError('参考图不是有效图片', 'INVALID_IMAGE');
  return { buffer, mime: type.mime, filename: path.basename(refPath) };
}

module.exports = {
  key: 'openai_compat',

  async generate(cfg, req) {
    const url = joinPath(cfg && cfg.baseUrl, cfg && cfg.apiPath, '/images/generations');
    const body = {
      model: (cfg && cfg.model) || (cfg && cfg.defaultModel) || '',
      prompt: req.prompt,
      n: normalizeCount(req.n),
      size: req.size,
      response_format: 'b64_json'
    };
    if (cfg && cfg.supportsNegative && req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed) body.seed = req.seed;
    const resp = await axios.post(url, body, {
      headers: { ...getHeaders(cfg), 'Content-Type': 'application/json' },
      timeout: 180000,
      maxBodyLength: 64 * 1024 * 1024,
      signal: req.cancelRef && req.cancelRef.signal
    });
    return collectImages(resp.data, req);
  },

  async generateWithReference(cfg, req, refPath) {
    let file;
    try {
      file = await readReference(refPath);
    } catch (err) {
      if (err.code) throw err;
      throw codedError('参考图读取失败', 'INVALID_IMAGE');
    }
    const url = joinPath(cfg && cfg.baseUrl, cfg && cfg.apiPath, '/images/edits');
    const form = buildMultipart({
      model: (cfg && cfg.model) || (cfg && cfg.defaultModel) || '',
      prompt: req.prompt,
      n: normalizeCount(req.n),
      size: req.size,
      ...(cfg && cfg.supportsNegative && req.negativePrompt ? { negative_prompt: req.negativePrompt } : {})
    }, file);
    let resp;
    try {
      resp = await axios.post(url, form.body, {
        headers: { ...getHeaders(cfg), 'Content-Type': form.contentType },
        timeout: 180000,
        maxBodyLength: MAX_IMAGE_SIZE + 64 * 1024,
        signal: req.cancelRef && req.cancelRef.signal
      });
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 404 || status === 405) {
        throw codedError('该站点没有提供 /images/edits 图生图接口，请关闭图生图或换用支持图生图的服务商', 'BAD_RESPONSE');
      }
      throw err;
    }
    return collectImages(resp.data, req);
  },

  async fetchModels(cfg) {
    const base = String((cfg && cfg.baseUrl) || '').trim();
    const apiKey = String((cfg && cfg.apiKey) || '').trim();
    if (!base || !apiKey) return null;
    try {
      const resp = await axios.get(`${trimBase(base)}/models`, {
        headers: getHeaders(cfg),
        timeout: 20000
      });
      const ids = ((resp.data && resp.data.data) || []).map(m => m && m.id).filter(Boolean);
      const imageModelPattern = /image|dall|flux|imagen|seedream|seedance|kolors|qwen-image|gpt-image|nano-banana/i;
      return ids.filter(id => imageModelPattern.test(id));
    } catch (err) {
      return null;
    }
  },

  async verify(cfg) {
    const base = String((cfg && cfg.baseUrl) || '').trim();
    const apiKey = String((cfg && cfg.apiKey) || '').trim();
    if (!base || !apiKey) return false;
    try {
      const resp = await axios.get(`${trimBase(base)}/models`, {
        headers: getHeaders(cfg),
        timeout: 15000
      });
      return resp.status >= 200 && resp.status < 300;
    } catch (err) {
      return false;
    }
  },

  /**
   * 余额查询：不同中转站实现不一，能查到就展示，查不到返回 null（前端按钮自动隐藏结果）。
   * @param {Object} cfg
   * @returns {Promise<null|{amount: number, currency: string, label: string}>}
   */
  async fetchBalance(cfg) {
    const base = String((cfg && cfg.baseUrl) || '').trim();
    const apiKey = String((cfg && cfg.apiKey) || '').trim();
    if (!base || !apiKey) return null;
    const headers = getHeaders(cfg);
    try {
      const resp = await axios.get(`${trimBase(base)}/dashboard/billing/credit_grants`, {
        headers, timeout: 15000
      });
      const data = (resp.data && resp.data.data) || resp.data || {};
      const available = Number(
        data.total_available !== undefined ? data.total_available : data.total_granted
      );
      if (Number.isFinite(available)) {
        return { amount: available, currency: 'USD', label: `$${available.toFixed(2)}` };
      }
    } catch (err) {
      // 该站点未实现计费接口，继续尝试下一种形式。
    }
    try {
      const resp = await axios.get(`${trimBase(base)}/dashboard/billing/subscription`, {
        headers, timeout: 15000
      });
      const data = (resp.data && resp.data.data) || resp.data || {};
      const limit = Number(data.hard_limit_usd !== undefined ? data.hard_limit_usd : data.system_hard_limit_usd);
      if (Number.isFinite(limit)) {
        return { amount: limit, currency: 'USD', label: `额度 $${limit.toFixed(2)}` };
      }
    } catch (err) {
      // 无计费接口。
    }
    return null;
  }
};
