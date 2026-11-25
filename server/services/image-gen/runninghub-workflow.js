/**
 * RunningHub 工作流自动解析（对齐 TTAI 插件）
 *
 * 插件里有两个自动获取逻辑，这里复用：
 * 1) 只知道应用 ID（appId / webappId）时，调 `/api/webapp/apiCallDemo` 反查真正的 workflowId
 *    （响应里任意层级出现 workflowId / workflowids 且是 6 位以上数字都算命中）
 * 2) 知道 workflowId 时，调 `/api/openapi/getJsonApiFormat` 拉取工作流 JSON（API 格式），
 *    从图结构里自动定位 prompt 文本节点，免去手填 `nodeId:fieldName`
 */
const axios = require('axios');

const WORKFLOW_ID_RE = /^\d{6,}$/;
const CACHE_TTL = 10 * 60 * 1000;
const idCache = new Map();
const graphCache = new Map();

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function normalizeKey(baseUrl, value) {
  return `${normalizeBase(baseUrl)}|${String(value || '')}`;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
}

/**
 * 递归找 workflowId：字段名忽略大小写与分隔符，值必须是 6 位以上纯数字。
 * 兼容响应里把 JSON 塞进字符串字段的情况（与插件 extractRunningCloudWorkflowIdFromPayload 一致）。
 */
function extractWorkflowId(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length && seen.size < 200) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((item) => {
        if (item && typeof item === 'object') queue.push(item);
      });
      continue;
    }
    const entries = Object.entries(node);
    for (let i = 0; i < entries.length; i++) {
      const key = String(entries[i][0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const value = entries[i][1];
      if (key === 'workflowid' || key === 'workflowids') {
        const text = String(value === null || value === undefined ? '' : value).trim();
        if (WORKFLOW_ID_RE.test(text)) return text;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
        continue;
      }
      if (typeof value === 'string') {
        const text = value.trim();
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 200000) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') queue.push(parsed);
          } catch (err) {
            // 非 JSON 字符串直接忽略
          }
        }
      }
    }
  }
  return '';
}

function appDemoHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/**
 * 用 appId / webappId 反查 workflowId。
 * @returns {Promise<string>} 解析不到返回 ''
 */
async function resolveWorkflowId(baseUrl, apiKey, appId) {
  const base = normalizeBase(baseUrl);
  const app = String(appId || '').trim();
  if (!base || !apiKey || !app) return '';
  if (WORKFLOW_ID_RE.test(app)) return app;
  const cacheKey = normalizeKey(base, app);
  const cached = cacheGet(idCache, cacheKey);
  if (cached) return cached;

  const fields = ['webappId', 'webAppId', 'appId'];
  for (let i = 0; i < fields.length; i++) {
    const query = new URLSearchParams();
    query.set('apiKey', apiKey);
    query.set(fields[i], app);
    try {
      const resp = await axios.get(`${base}/api/webapp/apiCallDemo?${query.toString()}`, {
        headers: appDemoHeaders(apiKey),
        timeout: 20000
      });
      const found = extractWorkflowId(resp.data && resp.data.data);
      if (found) {
        cacheSet(idCache, cacheKey, found);
        return found;
      }
    } catch (err) {
      // 继续尝试下一种写法
    }
  }
  for (let i = 0; i < fields.length; i++) {
    const body = { apiKey };
    body[fields[i]] = app;
    try {
      const resp = await axios.post(`${base}/api/webapp/apiCallDemo`, body, {
        headers: appDemoHeaders(apiKey),
        timeout: 20000
      });
      const found = extractWorkflowId(resp.data && resp.data.data);
      if (found) {
        cacheSet(idCache, cacheKey, found);
        return found;
      }
    } catch (err) {
      // 继续尝试
    }
  }
  return '';
}

/**
 * 拉取工作流 JSON（API 格式），失败返回 null。
 */
async function fetchWorkflowGraph(baseUrl, apiKey, workflowId) {
  const base = normalizeBase(baseUrl);
  const id = String(workflowId || '').trim();
  if (!base || !apiKey || !id) return null;
  const cacheKey = normalizeKey(base, id);
  const cached = cacheGet(graphCache, cacheKey);
  if (cached) return cached;

  const paths = ['/api/openapi/getJsonApiFormat', '/openapi/getJsonApiFormat'];
  const bodies = [{ apiKey, workflowId: id }, { apiKey, workflowId: id, workflow_id: id }];
  for (let p = 0; p < paths.length; p++) {
    for (let b = 0; b < bodies.length; b++) {
      try {
        const resp = await axios.post(`${base}${paths[p]}`, bodies[b], {
          headers: appDemoHeaders(apiKey),
          timeout: 20000
        });
        const data = resp.data || {};
        const code = data.code === undefined ? (data.errorCode === undefined ? null : data.errorCode) : data.code;
        if (code !== null && code !== 0 && code !== 200 && code !== '0' && code !== '200') continue;
        const raw = (data.data && (data.data.prompt || data.data.json)) || data.prompt || data.json || '';
        const graph = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!graph || typeof graph !== 'object' || Array.isArray(graph)) continue;
        cacheSet(graphCache, cacheKey, graph);
        return graph;
      } catch (err) {
        // 尝试下一个路径/参数组合
      }
    }
  }
  return null;
}

/**
 * 从工作流 JSON 里找 prompt 节点。
 * 优先 CLIPTextEncode 之类的文本节点，其次任何带 inputs.text / inputs.prompt 的节点。
 * @returns {{nodeId:string, fieldName:string}|null}
 */
function pickPromptNode(graph) {
  if (!graph || typeof graph !== 'object') return null;
  const entries = Object.entries(graph);
  let fallback = null;
  for (let i = 0; i < entries.length; i++) {
    const nodeId = entries[i][0];
    const node = entries[i][1] || {};
    const className = String(node.class_type || node.classType || node.type || '');
    const inputs = node.inputs || {};
    if (typeof inputs.text === 'string' && /CLIPTextEncode|TextEncode|Prompt/i.test(className)) {
      return { nodeId, fieldName: 'text' };
    }
    if (typeof inputs.text === 'string' && !fallback) fallback = { nodeId, fieldName: 'text' };
    else if (typeof inputs.prompt === 'string' && !fallback) fallback = { nodeId, fieldName: 'prompt' };
  }
  return fallback;
}

/**
 * 解析 apiPath 里的 id 段，补全为可用的 workflowId。
 * 支持：/run/workflow/<workflowId|appId>、/workflow/<id>
 */
async function resolveApiPath(cfg) {
  const baseUrl = normalizeBase(cfg && cfg.baseUrl);
  const apiPath = String((cfg && cfg.apiPath) || '');
  const match = apiPath.match(/(\/workflow\/)([^/?#]+)/i);
  if (!match) return { apiPath, workflowId: '', graph: null };
  const rawId = decodeURIComponent(match[2]);
  const workflowId = await resolveWorkflowId(baseUrl, cfg.apiKey, rawId);
  if (!workflowId) return { apiPath, workflowId: '', graph: null };
  const graph = await fetchWorkflowGraph(baseUrl, cfg.apiKey, workflowId);
  return {
    apiPath: apiPath.replace(match[2], encodeURIComponent(workflowId)),
    workflowId,
    graph
  };
}

module.exports = {
  extractWorkflowId,
  resolveWorkflowId,
  fetchWorkflowGraph,
  pickPromptNode,
  resolveApiPath
};
