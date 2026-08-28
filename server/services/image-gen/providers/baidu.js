/**
 * 文心一格 ERNIE-ViLG 适配器
 * OAuth token（client_credentials）+ txt2img REST 接口
 * apiKey 格式：AK:SK；token 内存缓存，过期前 5 分钟自动刷新
 */
const axios = require('axios');
const { parseSize } = require('../utils');

let cachedToken = null;
let tokenExpireAt = 0;

async function getAccessToken(ak, sk) {
  const now = Date.now();
  if (cachedToken && tokenExpireAt - now > 5 * 60 * 1000) {
    return cachedToken;
  }
  const resp = await axios.post(
    'https://aip.baidubce.com/oauth/2.0/token',
    null,
    {
      params: {
        grant_type: 'client_credentials',
        client_id: ak,
        client_secret: sk
      },
      timeout: 30000
    }
  );
  if (!resp.data || !resp.data.access_token) {
    const err = new Error('文心一格获取 access_token 失败，请检查 AK/SK');
    err.code = 'AUTH_FAILED';
    throw err;
  }
  cachedToken = resp.data.access_token;
  tokenExpireAt = now + (resp.data.expires_in || 2592000) * 1000;
  return cachedToken;
}

function parseAkSk(apiKey) {
  const idx = String(apiKey || '').indexOf(':');
  if (idx <= 0) return null;
  return { ak: apiKey.slice(0, idx).trim(), sk: apiKey.slice(idx + 1).trim() };
}

module.exports = {
  key: 'baidu',

  async generate(cfg, req) {
    const cred = parseAkSk(cfg.apiKey);
    if (!cred) {
      const err = new Error('文心一格 API Key 需填写 AK:SK 格式');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const { baseUrl, model } = cfg;
    const { width, height } = parseSize(req.size);
    const token = await getAccessToken(cred.ak, cred.sk);
    const body = {
      prompt: req.prompt,
      width,
      height,
      n: req.n || 1
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

    const resp = await axios.post(
      `${baseUrl}/rpc/2.0/ai_custom/v1/wenxinworkshop/text2image/${model || 'ernie-vilg-xl-2'}`,
      body,
      {
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000
      }
    );
    const items = (resp.data && resp.data.data) || [];
    const images = [];
    for (const item of items) {
      if (!item.b64_image) continue;
      images.push({ buffer: Buffer.from(item.b64_image, 'base64'), mime: 'image/png' });
    }
    if (!images.length) {
      const msg = resp.data && (resp.data.error_msg || resp.data.msg);
      const err = new Error(msg ? `文心一格：${msg}` : '文心一格未返回图片数据');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    return { images };
  },

  async fetchModels() {
    return null;
  },

  // 轻量验证：能拿到 access_token 即 AK/SK 有效
  async verify(cfg) {
    const cred = parseAkSk(cfg.apiKey);
    if (!cred) return false;
    try {
      await getAccessToken(cred.ak, cred.sk);
      return true;
    } catch (err) {
      return false;
    }
  }
};
