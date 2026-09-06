/**
 * AI 聊天模型提供方：模型解析 + OpenAI 兼容 chat/completions 调用（流式/非流式）+ embeddings
 * 模型优先级：用户自建 ai_models(user_id=当前用户) → 后台全局 ai_models(user_id IS NULL)
 *            → settings.ai_default_model → 免费 Pollinations 兜底
 */
const axios = require('axios');
const { queryAll, queryOne } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { decrypt } = require('../../config/crypto-secure');
const { normalizeError } = require('./utils');

const POLLINATIONS_ENDPOINT = 'https://text.pollinations.ai/openai';

/**
 * 解析当前用户可用的模型配置
 * @param {Object} db
 * @param {number} userId
 * @param {string} [convModel] 会话指定模型 model_key（空则按默认优先级）
 * @returns {Object|null} { id, name, provider, model_key, api_endpoint, api_key, max_tokens, temperature }
 */
function resolveModel(db, userId, convModel) {
  const settings = getSettings(db);
  const allowUserModels = String(settings.ai_allow_user_models || '1') !== '0';

  let rows;
  if (allowUserModels && userId) {
    rows = queryAll(db, `SELECT * FROM ai_models WHERE is_enabled = 1 AND (user_id = ? OR user_id IS NULL)
      ORDER BY is_default DESC, sort_order ASC, id ASC`, [userId]);
  } else {
    rows = queryAll(db, 'SELECT * FROM ai_models WHERE is_enabled = 1 AND user_id IS NULL ORDER BY is_default DESC, sort_order ASC, id ASC');
  }

  // 会话指定模型：按 model_key 匹配，用户自建优先于全局
  const convModelKey = String(convModel || '').trim();
  if (convModelKey) {
    const userRow = rows.find(r => String(r.user_id) === String(userId) && r.model_key === convModelKey);
    const globalRow = userRow ? null : rows.find(r => (r.user_id === null || r.user_id === undefined) && r.model_key === convModelKey);
    if (userRow || globalRow) return modelInfoFromRow(userRow || globalRow);
  }

  const defaultModelKey = String(settings.ai_default_model || '').trim();

  // 1. 优先级最高的行；2. model_key 匹配默认设置的行；3. 任意启用行
  let row = rows[0] || null;
  if (defaultModelKey && rows.length > 1) {
    const matched = rows.find(r => r.model_key === defaultModelKey);
    if (matched) row = matched;
  }
  if (!row) row = rows[0] || null;

  if (row) return modelInfoFromRow(row);

  // 3. settings.ai_default_model（无对应行时，作为 pollinations 免费兜底模型名）
  // 4. 完全无配置 → Pollinations 免费接口
  return {
    id: null,
    name: 'Pollinations',
    provider: 'pollinations',
    model_key: defaultModelKey || 'openai',
    api_endpoint: POLLINATIONS_ENDPOINT,
    api_key: null,
    max_tokens: 4096,
    temperature: 0.7
  };
}

function modelInfoFromRow(row) {
  return {
    id: row.id,
    name: row.name || row.model_key,
    provider: row.provider || 'openai',
    model_key: row.model_key,
    api_endpoint: row.api_endpoint || '',
    api_key: decrypt(row.api_key || '') || null,
    max_tokens: parseInt(row.max_tokens, 10) || 4096,
    temperature: parseFloat(row.temperature) || 0.7
  };
}

/**
 * 获取 OpenAI 兼容 /models 模型列表（用户填写 API Key / 端点后自动拉取可用模型）
 * @param {string} apiEndpoint - OpenAI 兼容端点（如 https://api.deepseek.com/v1）
 * @param {string|null} apiKey - Bearer Key（可为空，部分免费端点无需 Key）
 * @returns {Promise<Array<{id: string, owned_by: string}>>}
 */
async function fetchModelList(apiEndpoint, apiKey) {
  const base = String(apiEndpoint || '').trim().replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('请先填写 API 端点'), { status: 400 });
  const url = base + '/models';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const resp = await axios.get(url, { headers, timeout: 30000 });
  const data = resp.data && resp.data.data;
  if (!Array.isArray(data)) throw Object.assign(new Error('接口未返回模型列表（非 OpenAI 兼容）'), { status: 400 });
  const list = data
    .map(d => ({ id: String(d.id || ''), owned_by: String(d.owned_by || '') }))
    .filter(d => d.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!list.length) throw Object.assign(new Error('模型列表为空'), { status: 400 });
  return list;
}

/**
 * 解析 embeddings 配置（向量记忆/RAG 用；未配置返回 null 表示降级）
 */
function resolveEmbeddings(db) {
  const settings = getSettings(db);
  const base = String(settings.ai_embedding_api_base || '').trim();
  const model = String(settings.ai_embedding_model || '').trim();
  if (!base || !model) return null;
  return {
    api_endpoint: base.replace(/\/+$/, ''),
    model_key: model,
    api_key: decrypt(settings.ai_embedding_api_key || '') || null
  };
}

/**
 * 调用 OpenAI 兼容 chat/completions
 * @param {Object} modelInfo - resolveModel 返回值
 * @param {Array} messages
 * @param {Object} opts - { stream, signal, onDelta }
 * @returns {Promise<{content: string, finishReason: string}>}
 */
async function callChatCompletion(modelInfo, messages, opts = {}) {
  const { stream = false, signal, onDelta } = opts;
  const isPollinations = modelInfo.provider === 'pollinations';
  // Pollinations 免费接口直接 POST 端点本身；其余 OpenAI 兼容端点拼 /chat/completions
  const url = isPollinations
    ? (modelInfo.api_endpoint || POLLINATIONS_ENDPOINT)
    : (modelInfo.api_endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';

  const headers = { 'Content-Type': 'application/json' };
  if (modelInfo.api_key) {
    headers.Authorization = 'Bearer ' + modelInfo.api_key;
  } else if (isPollinations) {
    headers.referer = 'http://localhost:3000';
  }

  const body = {
    model: modelInfo.model_key,
    messages,
    temperature: modelInfo.temperature,
    max_tokens: modelInfo.max_tokens
  };
  if (stream) body.stream = true;

  if (stream) {
    return streamCompletion(url, headers, body, signal, onDelta);
  }

  const resp = await axios.post(url, body, { headers, timeout: 90000, signal });
  const content = resp.data && resp.data.choices && resp.data.choices[0] &&
    resp.data.choices[0].message && resp.data.choices[0].message.content;
  return { content: String(content || ''), finishReason: (resp.data.choices[0] && resp.data.choices[0].finish_reason) || 'stop' };
}

// 流式解析：逐行解析 SSE `data: {...}`，跨 chunk 缓冲
function streamCompletion(url, headers, body, signal, onDelta) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let content = '';
    let settled = false;

    axios.post(url, body, { headers, responseType: 'stream', timeout: 0, signal })
      .then(resp => {
        resp.data.on('data', chunk => {
          if (settled) return;
          buffer += chunk.toString('utf8');
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              settled = true;
              resolve({ content, finishReason: 'stop' });
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch (e) {
              continue;
            }
            if (parsed.error) {
              const err = new Error(parsed.error.message || '流式响应错误');
              err.response = { status: parsed.error.code || 500, data: parsed.error };
              settled = true;
              reject(err);
              return;
            }
            const delta = parsed.choices && parsed.choices[0] &&
              parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (delta) {
              content += delta;
              if (typeof onDelta === 'function') onDelta(delta);
            }
          }
        });
        resp.data.on('end', () => {
          if (!settled) {
            settled = true;
            if (content) resolve({ content, finishReason: 'stop' });
            else reject(new Error('流式响应意外结束'));
          }
        });
        resp.data.on('error', err => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        const wrapped = new Error(normalizeError(err));
        wrapped.code = err.code;
        wrapped.response = err.response;
        reject(wrapped);
      });
  });
}

/**
 * 调用 embeddings 接口
 * @param {Object} embCfg - resolveEmbeddings 返回值
 * @param {Array<string>} texts
 * @returns {Promise<Array<Array<number>>|null>} 失败返回 null（调用方降级）
 */
async function callEmbeddings(embCfg, texts) {
  if (!embCfg || !Array.isArray(texts) || texts.length === 0) return null;
  const url = embCfg.api_endpoint.replace(/\/+$/, '') + '/embeddings';
  const headers = { 'Content-Type': 'application/json' };
  if (embCfg.api_key) headers.Authorization = 'Bearer ' + embCfg.api_key;
  try {
    const resp = await axios.post(url, { model: embCfg.model_key, input: texts }, { headers, timeout: 60000 });
    const data = resp.data && resp.data.data;
    if (!Array.isArray(data)) return null;
    return data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  } catch (err) {
    console.error('[ai-chat] embeddings 调用失败:', normalizeError(err));
    return null;
  }
}

module.exports = { resolveModel, resolveEmbeddings, callChatCompletion, callEmbeddings, fetchModelList, POLLINATIONS_ENDPOINT };
