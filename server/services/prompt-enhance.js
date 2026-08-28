/**
 * 提示词优化服务
 * 将用户的简短描述优化为高质量生图提示词
 * 调用策略（按优先级）：
 * 1. 后台配置了 prompt_enhance_api_key → OpenAI 兼容 chat/completions（自建/商用 LLM）
 * 2. 未配置 → 免费 Pollinations text（POST /openai，需 referer；对中文/长内容可能 402）
 * 3. 外部接口均失败 → 内置本地规则优化兜底（无网络依赖，保证功能始终可用）
 * 返回 { enhanced, source }，source: api | free | local
 */
const axios = require('axios');
const { getSettings } = require('../utils/settings');
const { decrypt } = require('../config/crypto-secure');

// 中文系统提示词：要求输出优化后的英文生图提示词
const ENHANCE_SYSTEM_PROMPT =
  '你是一位专业的 AI 绘画提示词优化专家。' +
  '用户会给你一段简短的中文或英文画面描述，请你将其扩展为一段高质量、详细的英文提示词，' +
  '包含：主体描述、场景细节、光线与氛围、镜头与构图、艺术风格与质量词（如 8k、detailed、cinematic lighting 等）。' +
  '只输出优化后的英文提示词本身，不要任何解释、前缀或引号，控制在 200 个英文单词以内。';

/**
 * 内置本地规则优化（兜底）：追加通用质量词，保证无外部接口也可用
 * @param {string} prompt
 * @returns {string}
 */
function localEnhance(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return '';
  // 不含中日韩字符即视为英文描述
  const isEnglish = !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed);
  const qualitySuffix = 'highly detailed, 8k resolution, cinematic lighting, professional composition, sharp focus';
  if (isEnglish) {
    return trimmed.toLowerCase().indexOf('detailed') !== -1 ? trimmed : trimmed + ', ' + qualitySuffix;
  }
  return `${trimmed}，高质量细节丰富，电影级光影，专业构图，8K 高清`;
}

/**
 * 调用 OpenAI 兼容 chat/completions
 * @param {string} base
 * @param {string} model
 * @param {string|null} apiKey - null 表示免费接口（带 referer）
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callLlm(base, model, apiKey, prompt) {
  const messages = [
    { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.referer = 'http://localhost:3000';
  }
  const resp = await axios.post(base, { model, messages, temperature: 0.8, max_tokens: 500 }, {
    headers,
    timeout: 60000
  });
  const content = resp.data && resp.data.choices && resp.data.choices[0] &&
    resp.data.choices[0].message && resp.data.choices[0].message.content;
  const text = String(content || '').trim();
  if (!text) {
    const err = new Error('提示词优化服务未返回内容');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  return text;
}

/**
 * 优化提示词
 * @param {Object} db
 * @param {string} prompt - 用户输入的简短描述
 * @returns {Promise<{enhanced: string, source: string}>}
 */
async function enhancePrompt(db, prompt) {
  const settings = getSettings(db);
  const base = (settings.prompt_enhance_api_base || 'https://text.pollinations.ai/openai').trim();
  const model = (settings.prompt_enhance_model || 'openai').trim();
  const apiKey = decrypt(settings.prompt_enhance_api_key || '');

  if (apiKey) {
    // 配置了自建接口：失败直接抛出，让用户知道配置问题
    const enhanced = await callLlm(base, model, apiKey, prompt);
    return { enhanced, source: 'api' };
  }

  // 免费 Pollinations：失败自动降级为本地规则优化
  try {
    const enhanced = await callLlm(base, model, null, prompt);
    return { enhanced, source: 'free' };
  } catch (err) {
    return { enhanced: localEnhance(prompt), source: 'local' };
  }
}

module.exports = { enhancePrompt, localEnhance, ENHANCE_SYSTEM_PROMPT };
