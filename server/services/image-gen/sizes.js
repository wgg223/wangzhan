/**
 * AI 生图尺寸策略
 * 统一维护页面可选尺寸、服务商上限与「4K 请求 → 低分辨率自动降级」。
 *
 * 设计原则：
 *  - 旧尺寸（1024x1024 / 1792x1024 / 1536x1024 …）原样保留，保证向下兼容；
 *  - 4K 只是新增档位，是否真正出 4K 由服务商/模型决定；
 *  - 服务商有明确上限时先在请求前降到最接近的尺寸；没有明确上限时允许 4K，
 *    若运行时被服务商以尺寸/显存错误拒绝，再由 index.js 自动降一档重试。
 */

const FOUR_K_PIXELS = 3840 * 2160; // 4K UHD 总像素 8,294,400
const FULL_4K_PIXELS = 4096 * 4096;

const SIZE_PRESETS = [
  { value: '3840x2160', group: '4K', label: '3840 × 2160（4K 横屏）' },
  { value: '2160x3840', group: '4K', label: '2160 × 3840（4K 竖屏）' },
  { value: '2880x2880', group: '4K', label: '2880 × 2880（4K 方形）' },
  { value: '2560x1440', group: '2K', label: '2560 × 1440（2K 横屏）' },
  { value: '1440x2560', group: '2K', label: '1440 × 2560（2K 竖屏）' },
  { value: '2048x2048', group: '2K', label: '2048 × 2048（2K 方形）' },
  { value: '1792x1024', group: '兼容', label: '1792 × 1024（宽屏）' },
  { value: '1024x1792', group: '兼容', label: '1024 × 1792（竖屏）' },
  { value: '1536x1024', group: '兼容', label: '1536 × 1024（横屏）' },
  { value: '1024x1536', group: '兼容', label: '1024 × 1536（竖屏）' },
  { value: '1024x1024', group: '兼容', label: '1024 × 1024（方形）' },
  { value: '1280x720', group: '兼容', label: '1280 × 720' },
  { value: '720x1280', group: '兼容', label: '720 × 1280' },
  { value: '768x768', group: '兼容', label: '768 × 768' },
  { value: '512x512', group: '兼容', label: '512 × 512' }
];

const GROUP_META = [
  { key: '4K', label: '4K 超高清（需服务商/模型支持）' },
  { key: '2K', label: '2K 高清' },
  { key: '兼容', label: '兼容 / 常用尺寸（原有档位）' }
];

const SIZE_GROUPS = GROUP_META.map((meta) => ({
  key: meta.key,
  label: meta.label,
  options: SIZE_PRESETS.filter((item) => item.group === meta.key)
}));

const PROVIDER_LIMITS = {
  // 4K 档位明确支持/可尝试的服务商
  comfyui: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  momoapi: { maxSide: 3840, maxPixels: FOUR_K_PIXELS },
  seedance: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  runninghub: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  replicate: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  fal: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  aihubmix: { maxSide: 3840, maxPixels: FOUR_K_PIXELS },
  doubao: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  // OpenAI 只接受离散尺寸，按横竖方向映射
  openai: { presets: ['1024x1024', '1792x1024', '1024x1792'] }
};

const DEFAULT_LIMIT = { maxSide: 2048, maxPixels: 2048 * 2048 };

function parseSize(value) {
  const match = String(value || '').trim().match(/^(\d{1,4})[x*](\d{1,4})$/i);
  if (!match) return null;
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (!width || !height || width < 64 || height < 64) return null;
  return { width, height };
}

function sizeValue(width, height) {
  return `${width}x${height}`;
}

function fitToLimit(width, height, maxSide, maxPixels) {
  let scale = 1;
  const longSide = Math.max(width, height);
  if (longSide > maxSide) scale = Math.min(scale, maxSide / longSide);
  const pixels = width * height;
  if (pixels * scale * scale > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / pixels));
  }
  if (scale >= 1) return { width, height };
  // 统一向下取到 16 的倍数：既满足 OpenAI 自定义尺寸要求，也兼容 ComfyUI 的 8 倍数校验。
  const nextWidth = Math.max(64, Math.floor((width * scale) / 16) * 16);
  const nextHeight = Math.max(64, Math.floor((height * scale) / 16) * 16);
  return { width: nextWidth, height: nextHeight };
}

function buildResult(size, requested, parsed, adjusted) {
  const normalized = parseSize(size);
  return {
    size,
    requested: String(requested || ''),
    width: normalized ? normalized.width : 1024,
    height: normalized ? normalized.height : 1024,
    requestedWidth: parsed ? parsed.width : null,
    requestedHeight: parsed ? parsed.height : null,
    adjusted: Boolean(adjusted)
  };
}

/**
 * 按服务商解析最终请求尺寸。
 * @param {string} providerKey
 * @param {string} requested - 用户请求尺寸，如 3840x2160
 * @returns {{size:string,requested:string,width:number,height:number,requestedWidth:number|null,requestedHeight:number|null,adjusted:boolean}}
 */
function resolveSizeForProvider(providerKey, requested) {
  const clean = String(requested || '').trim();
  const parsed = parseSize(clean);
  if (!parsed) {
    return buildResult('1024x1024', clean || '1024x1024', null, clean !== '1024x1024');
  }
  const normalized = sizeValue(parsed.width, parsed.height);
  const limit = PROVIDER_LIMITS[providerKey] || DEFAULT_LIMIT;

  if (Array.isArray(limit.presets) && limit.presets.length) {
    let chosen = limit.presets.find((item) => parseSize(item) && sizeValue(parseSize(item).width, parseSize(item).height) === normalized);
    if (!chosen) {
      const ratio = parsed.width / parsed.height;
      chosen = ratio >= 1.2 ? '1792x1024' : ratio <= 0.83 ? '1024x1792' : '1024x1024';
      if (!limit.presets.includes(chosen)) chosen = limit.presets[0];
    }
    return buildResult(chosen, clean, parsed, chosen !== normalized);
  }

  const fitted = fitToLimit(parsed.width, parsed.height, limit.maxSide, limit.maxPixels);
  const size = sizeValue(fitted.width, fitted.height);
  return buildResult(size, clean, parsed, size !== normalized);
}

/**
 * 运行时尺寸降级阶梯：原尺寸 → 2K → 1K。
 * 只用于服务商实际拒绝 4K/大尺寸时自动重试，不改变用户可选档位。
 */
function sizeFallbacks(size) {
  const parsed = parseSize(size);
  if (!parsed) return [size || '1024x1024'];
  const list = [sizeValue(parsed.width, parsed.height)];
  [
    { maxSide: 2048, maxPixels: 2048 * 2048 },
    { maxSide: 1024, maxPixels: 1024 * 1024 }
  ].forEach((limit) => {
    const fitted = fitToLimit(parsed.width, parsed.height, limit.maxSide, limit.maxPixels);
    const value = sizeValue(fitted.width, fitted.height);
    if (list.indexOf(value) === -1) list.push(value);
  });
  return list;
}

function errorText(err) {
  if (!err) return '';
  let text = String(err.message || '');
  const data = err.response && err.response.data;
  if (typeof data === 'string') {
    text += ' ' + data.slice(0, 600);
  } else if (data && typeof data === 'object') {
    try {
      text += ' ' + JSON.stringify(data).slice(0, 1000);
    } catch (e) {
      // 忽略无法序列化的错误体。
    }
  }
  return text;
}

/**
 * 判断错误是否可能由尺寸/显存导致，适合降一档重试。
 * 鉴权、余额、限流、模型通道等问题不在此列（换小尺寸也不会好）。
 */
function isSizeFallbackError(err) {
  if (!err) return false;
  if (err.code === 'IMAGE_TOO_LARGE') return true;
  const text = errorText(err);
  return /(?:^|[^a-z])(size|resolution|dimension|width|height)(?:[^a-z]|$)|分辨率|尺寸|宽高|too large|out of memory|oom|显存|内存不足/i.test(text);
}

module.exports = {
  FOUR_K_PIXELS,
  SIZE_PRESETS,
  SIZE_GROUPS,
  PROVIDER_LIMITS,
  resolveSizeForProvider,
  sizeFallbacks,
  isSizeFallbackError,
  parseSize
};
