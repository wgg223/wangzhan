/**
 * AI 生图平台协议模板
 *
 * 一个「协议」可以创建多个平台实例（多账号 / 国内国际节点 / 不同中转站），
 * 实例的 provider_key 形如 `模板key__后缀`，适配器按前缀解析到模板对应的 adapter。
 *
 * 新增平台的流程：后台选择模板 → 填名称/域名/Key → 生成 `模板key__后缀` 的
 * ai_image_providers 行；前台服务商下拉自动出现，无需改代码。
 */
const TEMPLATES = [
  {
    key: 'openai_compat',
    label: 'OpenAI 兼容站点（通用）',
    adapter: 'openai_compat',
    description: '标准 /images/generations 与 /images/edits，支持 b64_json / url 返回。'
      + '适用于绝大多数 OpenAI 兼容中转站；只需要填站点主域名和 Key。',
    apiBase: '',
    apiPath: '',
    defaultModel: '',
    models: [],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: ''
  },
  {
    key: 'grsai',
    label: 'GrsAI 中转站',
    adapter: 'openai_compat',
    description: 'GrsAI（grsaiapi.com）OpenAI 兼容协议，支持 GPT-Image / 纳米香蕉 / Seedream 等模型。',
    apiBase: 'https://grsaiapi.com/v1',
    apiPath: '',
    defaultModel: 'gpt-image-1',
    models: [],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: 'https://grsaiapi.com/'
  },
  {
    key: 't8star',
    label: '贞贞 / T8Star',
    adapter: 'openai_compat',
    description: 'T8Star（ai.t8star.cn）OpenAI 兼容中转，常见 gpt-image / nano-banana 系列。',
    apiBase: 'https://ai.t8star.cn/v1',
    apiPath: '',
    defaultModel: 'gpt-image-1',
    models: [],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: ''
  },
  {
    key: 'seedance',
    label: 'Seedance（异步任务）',
    adapter: 'seedance',
    description: 'Seedance：按 TT AI 协议提交 Seedream 5.5 异步任务，支持 1K/1.5K/2K、10 张参考图、钱包余额验证。',
    apiBase: 'https://api.seedance.nz',
    apiPath: '',
    defaultModel: 'seedream-v5.5__2k',
    models: ['seedream-v5.5__2k', 'seedream-v5.5__1.5k', 'seedream-v5.5__1k'],
    supportsNegative: 0,
    supportsN: 0,
    supportsImg2img: 1,
    keyUrl: 'https://api.seedance.nz/docs/'
  },
  {
    key: 'runninghub',
    label: 'RunningHub 云工作流',
    adapter: 'runninghub',
    description: 'RunningHub OpenAPI：按后台配置的 workflowId 提交任务并轮询。国内 international 节点用不同域名即可。',
    apiBase: 'https://www.runninghub.cn/openapi/v2',
    apiPath: '',
    defaultModel: '',
    models: [],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 0,
    keyUrl: 'https://www.runninghub.cn/enterprise-api/consumerApi'
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    adapter: 'minimax',
    description: 'MiniMax 图片生成（国内 api.minimax.chat / 国际 api.minimaxi.chat），同一适配器建两个实例即可。',
    apiBase: 'https://api.minimax.chat/v1',
    apiPath: '',
    defaultModel: 'image-01',
    models: ['image-01'],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 0,
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
  },
  {
    key: 'wavespeed',
    label: 'WaveSpeed AI（异步）',
    adapter: 'wavespeed',
    description: 'WaveSpeed：POST /api/v3/{模型路径} 提交，GET /api/v3/predictions/{id}/result 轮询。'
      + '该适配器尚未与官方账号联调，接口若变更请按官方文档调整「模型路径」。',
    apiBase: 'https://api.wavespeed.ai',
    apiPath: 'wavespeed-ai/flux-dev',
    defaultModel: '',
    models: [],
    supportsNegative: 1,
    supportsN: 1,
    supportsImg2img: 0,
    keyUrl: 'https://wavespeed.ai/accesskey'
  },
  {
    key: 'momoapi',
    label: 'MomoAPI',
    adapter: 'momoapi',
    description: 'MomoAPI：模型列表以当前 Key 的认证结果为准，保存 Key 后自动同步；保存 Key 会顺带查询 New API 计费余额。'
      + '国内/国际节点用不同域名再建一个实例即可（如 momoapi__intl）。',
    apiBase: 'https://api.momoapi.icu',
    apiPath: '',
    defaultModel: '',
    models: [],
    supportsNegative: 0,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: 'https://api.momoapi.icu/console'
  },
  {
    key: 'doubao',
    label: '火山引擎豆包',
    adapter: 'doubao',
    description: '火山方舟 OpenAI 兼容 /images/generations，默认 doubao-seedream 系列。',
    apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    apiPath: '',
    defaultModel: 'doubao-seedream-4-0-250828',
    models: ['doubao-seedream-4-0-250828', 'doubao-seedream-4-5-251128', 'doubao-seedream-5-0-260128'],
    supportsNegative: 1,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  {
    key: 'siliconflow',
    label: '硅基流动',
    adapter: 'siliconflow',
    description: '硅基流动 OpenAI 兼容 /images/generations，支持 FLUX / Qwen-Image 等。',
    apiBase: 'https://api.siliconflow.cn/v1',
    apiPath: '',
    defaultModel: 'black-forest-labs/FLUX.1-schnell',
    models: ['black-forest-labs/FLUX.1-schnell', 'Qwen/Qwen-Image'],
    supportsNegative: 1,
    supportsN: 1,
    supportsImg2img: 1,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  }
];

const TEMPLATE_MAP = new Map(TEMPLATES.map(t => [t.key, t]));

/**
 * 平台实例 key 的协议前缀：`seedance__hk` → seedance，`custom__my` → custom。
 * @param {string} providerKey
 * @returns {string}
 */
function templatePrefix(providerKey) {
  return String(providerKey || '').split('__')[0].trim().toLowerCase();
}

/**
 * 按 provider_key 找协议模板（含实例后缀的情况）。
 * @param {string} providerKey
 * @returns {Object|null}
 */
function getTemplateForProvider(providerKey) {
  const key = String(providerKey || '');
  const direct = TEMPLATE_MAP.get(key);
  if (direct) return direct;
  return TEMPLATE_MAP.get(templatePrefix(key)) || null;
}

/**
 * 按模板 key 取模板。
 * @param {string} key
 * @returns {Object|null}
 */
function getTemplate(key) {
  return TEMPLATE_MAP.get(String(key || '')) || null;
}

/**
 * 后台「新增平台」下拉需要的模板列表（不含内部字段）。
 * @returns {Array<Object>}
 */
function listTemplates() {
  return TEMPLATES.map(t => ({
    key: t.key,
    label: t.label,
    adapter: t.adapter,
    description: t.description,
    apiBase: t.apiBase,
    apiPath: t.apiPath,
    defaultModel: t.defaultModel,
    models: t.models.slice(),
    supportsNegative: t.supportsNegative,
    supportsN: t.supportsN,
    supportsImg2img: t.supportsImg2img,
    keyUrl: t.keyUrl
  }));
}

module.exports = {
  TEMPLATES,
  templatePrefix,
  getTemplate,
  getTemplateForProvider,
  listTemplates
};
