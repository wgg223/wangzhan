/**
 * AI 图片生成服务 - 公共工具
 * 下载/解码/魔数校验/存盘/错误归一化
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 生成图存储根目录（web 可访问）
const UPLOAD_ROOT = path.join(__dirname, '../../../public/uploads/ai-images');
const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB

/**
 * 通过魔数嗅探图片类型
 * @param {Buffer} buffer
 * @returns {{mime: string, ext: string}|null}
 */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' };
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  // WebP (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { mime: 'image/gif', ext: '.gif' };
  }
  return null;
}

/**
 * 将生成的图片字节落盘到 public/uploads/ai-images/YYYYMM/
 * @param {Buffer} buffer
 * @param {string} [prefix='ai'] - 文件名前缀（ai=生成图, ref=参考图）
 * @returns {string} web 相对路径，如 /uploads/ai-images/202608/ai-xxx.png
 */
function saveImageBuffer(buffer, prefix = 'ai') {
  const type = sniffImageType(buffer);
  if (!type) {
    const err = new Error('生成结果不是有效的图片文件');
    err.code = 'INVALID_IMAGE';
    throw err;
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    const err = new Error('生成图片超过 15MB 限制');
    err.code = 'IMAGE_TOO_LARGE';
    throw err;
  }
  const now = new Date();
  const monthDir = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0');
  const dir = path.join(UPLOAD_ROOT, monthDir);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${type.ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/ai-images/${monthDir}/${filename}`;
}

/**
 * 保存参考图（图生图输入）
 * @param {Buffer} buffer
 * @returns {string} web 相对路径
 */
function saveReferenceImage(buffer) {
  return saveImageBuffer(buffer, 'ref');
}

/**
 * 下载远程图片为 Buffer（arraybuffer）
 * @param {string} url
 * @param {Object} [headers]
 * @returns {Promise<Buffer>}
 */
async function downloadImage(url, headers = {}) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: MAX_IMAGE_SIZE,
    headers: { Accept: 'image/*', ...headers }
  });
  return Buffer.from(resp.data);
}

/**
 * 从 OpenAI 兼容响应的 b64_json / url 提取图片 Buffer
 * @param {Object} item - data 数组元素
 * @returns {Promise<Buffer>}
 */
async function resolveImageItem(item) {
  if (!item) {
    const err = new Error('API 未返回图片数据');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  if (item.b64_json || item.b64_image) {
    return Buffer.from(item.b64_json || item.b64_image, 'base64');
  }
  if (item.url) {
    return downloadImage(item.url);
  }
  const err = new Error('API 返回格式无法识别（缺少 url 或 b64_json）');
  err.code = 'BAD_RESPONSE';
  throw err;
}

/**
 * 解析尺寸字符串 '1024x1024' 或 '1024*1024'
 * @param {string} size
 * @returns {{width: number, height: number}}
 */
function parseSize(size) {
  const m = String(size || '').match(/^(\d{1,4})[x*](\d{1,4})$/);
  if (!m) return { width: 1024, height: 1024 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * 归一化 axios/生成错误为中文提示
 * @param {Error} err
 * @returns {string}
 */
function normalizeError(err) {
  if (!err) return '未知错误';
  if (err.code === 'INVALID_IMAGE') return err.message;
  if (err.code === 'IMAGE_TOO_LARGE') return err.message;
  if (err.code === 'EMPTY_RESPONSE') return err.message;
  if (err.code === 'BAD_RESPONSE') return err.message;
  if (err.response) {
    const status = err.response.status;
    const data = err.response.data;
    if (status === 401 || status === 403) return 'API Key 无效或未配置，请在后台检查服务商配置';
    if (status === 429) return '触发服务商限流，请稍后再试';
    if (status === 400 || status === 404 || status === 422) {
      // 兼容各家 JSON/文本错误体（含嵌套 error.message，如豆包 InvalidEndpointOrModel.NotFound）
      const msg = data && (data.message || (data.error && data.error.message) || data.error || data.detail || data.msg);
      return msg ? `服务商拒绝请求：${String(msg).slice(0, 120)}` : `服务商返回错误（HTTP ${status}）`;
    }
    if (status === 402) return '服务商账户余额不足';
    return `服务商返回错误（HTTP ${status}）`;
  }
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return '连接服务商超时，请稍后再试';
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ||
      err.code === 'ECONNRESET' || err.code === 'ENETUNREACH' || err.code === 'ERR_NETWORK') {
    return '无法连接服务商，请检查网络或服务商配置';
  }
  if (err.code === 'TIMEOUT') return '生成超时，请稍后再试';
  if (err.code === 'BAD_CONFIG') return err.message;
  if (err.code === 'AUTH_FAILED') return err.message;
  if (err.code === 'PROVIDER_FAILED') return err.message;
  if (err.code === 'FETCH_FAILED') return err.message;
  if (err.message && err.message !== '') return err.message;
  return '生成失败，请稍后再试';
}

/**
 * 小睡（轮询用）
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  UPLOAD_ROOT,
  MAX_IMAGE_SIZE,
  sniffImageType,
  saveImageBuffer,
  saveReferenceImage,
  downloadImage,
  resolveImageItem,
  parseSize,
  normalizeError,
  sleep
};
