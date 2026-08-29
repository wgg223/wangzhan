/**
 * AI 聊天服务通用工具
 */
const crypto = require('crypto');

// 粗略 token 估算（中文约 1 字 ≈ 1 token，西文约 4 字符 ≈ 1 token）
function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  const cjk = (str.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = str.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

// 余弦相似度（两个等长数值数组）
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 将错误归一化为中文可读消息
function normalizeError(err) {
  if (!err) return '未知错误，请稍后重试';
  const code = err.code || '';
  const status = err.response && err.response.status;
  const data = err.response && err.response.data;
  const dataMsg = (data && (data.error && (data.error.message || data.error.code) || data.message)) || '';

  if (err.name === 'AbortError' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return '请求超时，请重试';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return '网络异常，请检查网络连接后重试';
  }
  if (status === 401) return 'API Key 无效或已过期，请检查配置';
  if (status === 402 || status === 429 || /insufficient|quota|balance/i.test(String(dataMsg))) {
    return '余额不足或请求过于频繁，请稍后再试';
  }
  if (status === 404 || /not.?found|invalid.?endpoint|model/i.test(String(dataMsg))) {
    return '模型不存在或未开通，请更换模型';
  }
  if (status === 403) return '服务商拒绝了请求（403），请检查权限配置';
  if (status >= 500) return '服务商暂时不可用，请稍后重试';
  if (dataMsg) return String(dataMsg).slice(0, 120);
  if (err.message) return String(err.message).slice(0, 120);
  return '未知错误，请稍后重试';
}

// 文本分块（RAG 用）：按段落合并，每块约 maxChars 字符
function chunkText(text, maxChars = 800) {
  const str = String(text || '').trim();
  if (!str) return [];
  const paragraphs = str.split(/\n{2,}|\r?\n/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n' + p).length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? current + '\n' + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// 随机 base64 token（分享/短 ID 用）
function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { estimateTokens, cosineSimilarity, normalizeError, chunkText, randomToken };
