/**
 * AI 聊天服务通用工具
 */
const crypto = require('crypto');

/**
 * 更精确的 token 估算（基于 GPT 系列模型的分词规律）
 * 
 * 规则：
 * - CJK 字符（中日韩）：约 1.5 tokens/字（常用字 1 token，生僻字 2 tokens）
 * - 英文单词：约 1.3 tokens/词（常见短词 1 token，长词/专业术语 2+ tokens）
 * - 数字：约 1 token/3-4 位数字
 * - 标点符号：约 1 token/个
 * - 空白字符：约 0.5 tokens/个（空格、换行等）
 * - 特殊字符/emoji：约 2 tokens/个
 * 
 * @param {string} text - 输入文本
 * @returns {number} 估算的 token 数
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let tokens = 0;

  // CJK 字符（中日韩统一表意文字 + 日文假名 + 韩文谚文）
  const cjkChars = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  tokens += cjkChars * 1.5;

  // Emoji 和特殊符号（通常在 2 tokens 左右）
  const emojiChars = (str.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  tokens += emojiChars * 2;

  // 数字序列（每 3-4 位数字约 1 token）
  const numberSequences = str.match(/\d+/g) || [];
  for (const num of numberSequences) {
    tokens += Math.ceil(num.length / 3.5);
  }

  // 英文单词（每词约 1.3 tokens）
  // 先移除 CJK、emoji、数字，再统计英文单词
  const remaining = str
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g, '') // 移除 CJK
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '') // 移除 emoji
    .replace(/\d+/g, ''); // 移除数字
  
  const words = remaining.match(/[a-zA-Z]+/g) || [];
  tokens += words.length * 1.3;

  // 标点符号（每个约 1 token）
  const punctuation = (str.match(/[.,!?;:'"()\[\]{}<>\/\\|`~@#$%^&*_+=\-]/g) || []).length;
  tokens += punctuation;

  // 空白字符（空格、换行等，约 0.3 tokens/个）
  const whitespace = (str.match(/\s/g) || []).length;
  tokens += whitespace * 0.3;

  return Math.ceil(tokens);
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
