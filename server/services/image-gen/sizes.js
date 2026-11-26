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
  // 比例 × 画质矩阵（与 TTAI 插件的「比例 + 画质」逻辑一致，长边 1K/2K/4K）
  { value: '1024x1024', ratio: '1:1', quality: '1K', label: '1:1 · 1024 × 1024（1K 方形）' },
  { value: '1024x576', ratio: '16:9', quality: '1K', label: '16:9 · 1024 × 576（1K 横屏）' },
  { value: '576x1024', ratio: '9:16', quality: '1K', label: '9:16 · 576 × 1024（1K 竖屏）' },
  { value: '1024x768', ratio: '4:3', quality: '1K', label: '4:3 · 1024 × 768（1K）' },
  { value: '768x1024', ratio: '3:4', quality: '1K', label: '3:4 · 768 × 1024（1K）' },
  { value: '1024x688', ratio: '3:2', quality: '1K', label: '3:2 · 1024 × 688（1K）' },
  { value: '688x1024', ratio: '2:3', quality: '1K', label: '2:3 · 688 × 1024（1K）' },
  { value: '2048x2048', ratio: '1:1', quality: '2K', label: '1:1 · 2048 × 2048（2K 方形）' },
  { value: '2048x1152', ratio: '16:9', quality: '2K', label: '16:9 · 2048 × 1152（2K 横屏）' },
  { value: '1152x2048', ratio: '9:16', quality: '2K', label: '9:16 · 1152 × 2048（2K 竖屏）' },
  { value: '2048x1536', ratio: '4:3', quality: '2K', label: '4:3 · 2048 × 1536（2K）' },
  { value: '1536x2048', ratio: '3:4', quality: '2K', label: '3:4 · 1536 × 2048（2K）' },
  { value: '3840x2160', ratio: '16:9', quality: '4K', label: '16:9 · 3840 × 2160（4K 横屏）' },
  { value: '2160x3840', ratio: '9:16', quality: '4K', label: '9:16 · 2160 × 3840（4K 竖屏）' },
  { value: '2880x2880', ratio: '1:1', quality: '4K', label: '1:1 · 2880 × 2880（4K 方形）' },
  { value: '3840x2880', ratio: '4:3', quality: '4K', label: '4:3 · 3840 × 2880（4K）' },
  { value: '2880x3840', ratio: '3:4', quality: '4K', label: '3:4 · 2880 × 3840（4K）' },
  // 兼容档位（旧版本保存的尺寸继续可用）
  { value: '2560x1440', ratio: '16:9', quality: '2K', label: '16:9 · 2560 × 1440（2K 宽屏）' },
  { value: '1440x2560', ratio: '9:16', quality: '2K', label: '9:16 · 1440 × 2560（2K 竖屏）' },
  { value: '1792x1024', ratio: '7:4', quality: '兼容', label: '1792 × 1024（宽屏）' },
  { value: '1024x1792', ratio: '4:7', quality: '兼容', label: '1024 × 1792（竖屏）' },
  { value: '1536x1024', ratio: '3:2', quality: '兼容', label: '1536 × 1024（横屏）' },
  { value: '1024x1536', ratio: '2:3', quality: '兼容', label: '1024 × 1536（竖屏）' },
  { value: '1280x720', ratio: '16:9', quality: '兼容', label: '1280 × 720' },
  { value: '720x1280', ratio: '9:16', quality: '兼容', label: '720 × 1280' },
  { value: '768x768', ratio: '1:1', quality: '兼容', label: '768 × 768' },
  { value: '512x512', ratio: '1:1', quality: '兼容', label: '512 × 512' }
];

// 比例与画质：与 TTAI 插件的「比例（含自适应）+ 画质（1K/2K/4K）」一致
const RATIOS = [
  { value: 'auto', label: '自适应（按画面/参考图）' },
  { value: '1:1', label: '1:1 方形' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '5:4', label: '5:4' },
  { value: '4:5', label: '4:5' },
  { value: '21:9', label: '21:9 超宽' }
];

const QUALITY_TIERS = [
  { value: '1k', label: '1K（1024 长边）', longEdge: 1024 },
  { value: '2k', label: '2K（2048 长边）', longEdge: 2048 },
  { value: '4k', label: '4K（3840 长边）', longEdge: 3840 }
];

const GROUP_META = [
  { key: '4K', label: '4K 超高清（需服务商/模型支持）' },
  { key: '2K', label: '2K 高清' },
  { key: '1K', label: '1K 标准' },
  { key: '兼容', label: '兼容 / 常用尺寸（原有档位）' }
];

const SIZE_GROUPS = GROUP_META.map((meta) => ({
  key: meta.key,
  label: meta.label,
  options: SIZE_PRESETS.filter((item) => item.quality === meta.key)
}));

/**
 * 比例 × 画质 → 具体像素（与 TTAI 插件的「比例 + 画质」一致）。
 * 长边取档位（1K=1024 / 2K=2048 / 4K=3840），短边按比例取 16 的倍数。
 * @param {string} ratio 'auto' | '1:1' | '16:9' ...
 * @param {string} quality '1k' | '2k' | '4k'
 * @returns {string|null} 'WxH'，ratio=auto 时返回 null（由调用方决定）
 */
function sizeFromRatioQuality(ratio, quality) {
  const ratioKey = String(ratio || '').trim();
  const tier = QUALITY_TIERS.find(item => item.value === String(quality || '').toLowerCase());
  if (!tier) return null;
  const preset = RATIOS.find(item => item.value === ratioKey);
  if (!preset || preset.value === 'auto') return null;
  const pair = ratioKey.split(':').map(Number);
  if (pair.length !== 2 || !pair[0] || !pair[1]) return null;
  const longEdge = tier.longEdge;
  const shortEdge = Math.max(64, Math.min(longEdge, Math.round((longEdge * Math.min(pair[0], pair[1]) /
    Math.max(pair[0], pair[1])) / 16) * 16));
  return pair[0] >= pair[1] ? `${longEdge}x${shortEdge}` : `${shortEdge}x${longEdge}`;
}

/**
 * 完整的比例 × 画质矩阵，随页面下发，前端切换时无需再请求。
 * @returns {Object<string, Object<string, string>>}
 */
function ratioQualityMatrix() {
  const matrix = {};
  QUALITY_TIERS.forEach((tier) => {
    matrix[tier.value] = {};
    RATIOS.forEach((ratio) => {
      if (ratio.value === 'auto') return;
      const size = sizeFromRatioQuality(ratio.value, tier.value);
      if (size) matrix[tier.value][ratio.value] = size;
    });
  });
  return matrix;
}

const PROVIDER_LIMITS = {
  // 4K 档位明确支持/可尝试的服务商
  comfyui: { maxSide: 4096, maxPixels: FULL_4K_PIXELS },
  momoapi: { maxSide: 3840, maxPixels: FOUR_K_PIXELS },
  // Seedance / WaveSpeed 的 Seedream 5.5 官方画质档位只有 1K/1.5K/2K
  seedance: { maxSide: 2048, maxPixels: 2048 * 2048 },
  wavespeed: { maxSide: 2048, maxPixels: 2048 * 2048 },
  // 通用 OpenAI 兼容站点：各家上限不一，先按 2K 放行，运行时被拒会按 4K→2K→1K 自动降级
  openai_compat: { maxSide: 2048, maxPixels: 2048 * 2048 },
  // OpenAI 只接受离散尺寸，按横竖方向映射
  openai: { presets: ['1024x1024', '1792x1024', '1024x1792'] }
};

/**
 * 模型级尺寸上限：同一服务商下不同模型能力差异很大（如 gpt-image 系列只接受
 * 1024/1536 档，而 seedream 支持 4K）。命中时优先于服务商上限。
 *
 * 注意：这里只约束「OpenAI 官方 / 通用兼容站」的 gpt-image；
 * MomoAPI 的 gpt-image-2 走的是它自己的 1K/2K/4K 通道（见 MOMO_GPT_IMAGE_SIZES）。
 */
const MODEL_LIMITS = [
  { test: /gpt[-_. ]?image/i, providers: ['openai', 'openai_compat', 'aihubmix'], presets: ['1024x1024', '1536x1024', '1024x1536'] },
  { test: /dall[-_. ]?e/i, presets: ['1024x1024', '1792x1024', '1024x1792'] },
  { test: /imagen/i, maxSide: 2048, maxPixels: 2048 * 2048 },
  // 豆包 Seedream 5.0 / 5.5 自定义像素模式：总像素 921600–4624220，宽高比 1/16–16。
  // 1024x576 / 576x1024 等旧 1K 档位低于官方下限，需要提升到最近的合法尺寸。
  { test: /doubao-seedream-5/i, providers: ['doubao'], maxSide: 4096, maxPixels: 4624220, minPixels: 921600 },
  // Momo 的 seedream-v5.5 只有 1K/1.5K/2K（插件表），不发 4K
  { test: /seedream/i, providers: ['momoapi'], maxSide: 2048, maxPixels: 2048 * 2048 }
];

/**
 * MomoAPI gpt-image-2 的「比例 × 画质 → 像素」表（来自 TTAI 插件
 * getGptImage2OfficialRatioSize，1K/2K/4K 全档，16:9 4K 即 3840×2160）。
 */
const MOMO_GPT_IMAGE_SIZES = {
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '16:9': { '1k': '1280x720', '2k': '2560x1440', '4k': '3840x2160' },
  '9:16': { '1k': '720x1280', '2k': '1440x2560', '4k': '2160x3840' },
  '4:3': { '1k': '1152x864', '2k': '2304x1728', '4k': '3264x2448' },
  '3:4': { '1k': '864x1152', '2k': '1728x2304', '4k': '2448x3264' },
  '3:2': { '1k': '1248x832', '2k': '2496x1664', '4k': '3504x2336' },
  '2:3': { '1k': '832x1248', '2k': '1664x2496', '4k': '2336x3504' },
  '5:4': { '1k': '1120x896', '2k': '2240x1792', '4k': '3200x2560' },
  '4:5': { '1k': '896x1120', '2k': '1792x2240', '4k': '2560x3200' },
  '21:9': { '1k': '1456x624', '2k': '3024x1296', '4k': '3696x1584' },
  '9:21': { '1k': '624x1456', '2k': '1296x3024', '4k': '1584x3696' },
  '2:1': { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2': { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' }
};

/**
 * 把任意请求尺寸映射到 MomoAPI gpt-image-2 的合法档位：
 * 选比例最接近、清晰度按长边落档（≤1024→1k，≤2048→2k，否则 4k）。
 */
function momoGptImageSize(requested) {
  const parsed = parseSize(requested);
  if (!parsed) return '';
  const ratio = parsed.width / parsed.height;
  const longEdge = Math.max(parsed.width, parsed.height);
  const tier = longEdge <= 1024 ? '1k' : longEdge <= 2048 ? '2k' : '4k';
  let best = '';
  let bestScore = Infinity;
  Object.keys(MOMO_GPT_IMAGE_SIZES).forEach((key) => {
    const pair = key.split(':').map(Number);
    const score = Math.abs(Math.log((pair[0] / pair[1]) / ratio));
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  });
  const size = MOMO_GPT_IMAGE_SIZES[best] && MOMO_GPT_IMAGE_SIZES[best][tier];
  return size || '';
}

/**
 * 取服务商尺寸上限：平台实例（如 seedance__hk）回退到协议默认值；
 * 传入 model 时再叠加模型级限制。
 * @param {string} providerKey
 * @param {string} [model]
 * @returns {Object}
 */
function providerLimit(providerKey, model) {
  const key = String(providerKey || '');
  const modelName = String(model || '');
  const baseKey = key.split('__')[0];
  if (modelName) {
    const matched = MODEL_LIMITS.find(item => item.test.test(modelName) &&
      (!item.providers || item.providers.indexOf(baseKey) !== -1));
    if (matched) {
      return {
        presets: matched.presets,
        maxSide: matched.maxSide || (PROVIDER_LIMITS[key] || PROVIDER_LIMITS[baseKey] || DEFAULT_LIMIT).maxSide,
        maxPixels: matched.maxPixels || (PROVIDER_LIMITS[key] || PROVIDER_LIMITS[baseKey] || DEFAULT_LIMIT).maxPixels,
        minPixels: matched.minPixels || 0
      };
    }
  }
  if (PROVIDER_LIMITS[key]) return PROVIDER_LIMITS[key];
  return PROVIDER_LIMITS[baseKey] || DEFAULT_LIMIT;
}

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

function fitToLimit(width, height, maxSide, maxPixels, minPixels = 0) {
  const pixels = width * height;
  const longSide = Math.max(width, height);
  let scale = Math.min(1, maxSide / longSide);
  if (pixels * scale * scale > maxPixels) {
    scale = Math.min(scale, Math.sqrt(maxPixels / pixels));
  }
  if (minPixels && pixels < minPixels) {
    scale = Math.max(scale, Math.sqrt(minPixels / pixels));
  }
  // 放大补足最低像素时也不能突破单边上限。
  scale = Math.min(scale, maxSide / longSide);
  if (scale >= 1 && pixels <= maxPixels && pixels >= minPixels) return { width, height };

  // 统一向下取到 16 的倍数：既满足 OpenAI 自定义尺寸要求，也兼容 ComfyUI 的 8 倍数校验。
  let nextWidth = Math.max(64, Math.floor((width * scale) / 16) * 16);
  let nextHeight = Math.max(64, Math.floor((height * scale) / 16) * 16);
  // 两边分别取整可能让总像素略微超限，按长边继续微调到合法范围。
  while (nextWidth * nextHeight > maxPixels && (nextWidth > 64 || nextHeight > 64)) {
    if (nextWidth >= nextHeight && nextWidth > 64) nextWidth -= 16;
    else if (nextHeight > 64) nextHeight -= 16;
  }
  // 旧 1K 尺寸（如 1024x576）低于豆包 5.0 的 921600 像素下限，按同方向补足。
  for (let sizeGuard = 0; sizeGuard < 512; sizeGuard += 1) {
    if (!minPixels || nextWidth * nextHeight >= minPixels) break;
    if (nextWidth <= nextHeight && nextWidth + 16 <= maxSide) nextWidth += 16;
    else if (nextHeight + 16 <= maxSide) nextHeight += 16;
    else break;
  }
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
function resolveSizeForProvider(providerKey, requested, model) {
  const clean = String(requested || '').trim();
  const parsed = parseSize(clean);
  if (!parsed) {
    return buildResult('1024x1024', clean || '1024x1024', null, clean !== '1024x1024');
  }
  const normalized = sizeValue(parsed.width, parsed.height);
  // MomoAPI 的 gpt-image-2 走自己的 1K/2K/4K 尺寸表（4K 16:9 = 3840×2160）
  if (String(providerKey || '').split('__')[0] === 'momoapi' && /gpt[-_. ]?image/i.test(String(model || ''))) {
    const mapped = momoGptImageSize(clean);
    if (mapped) return buildResult(mapped, clean, parsed, mapped !== normalized);
  }
  const limit = providerLimit(providerKey, model);

  if (Array.isArray(limit.presets) && limit.presets.length) {
    let chosen = limit.presets.find((item) => parseSize(item) && sizeValue(parseSize(item).width, parseSize(item).height) === normalized);
    if (!chosen) {
      // 预设列表按「同方向 + 比例最接近」挑选，不能写死 1792/1024 这类固定值
      const ratio = parsed.width / parsed.height;
      const orientationOf = (value) => (value >= 1.2 ? 'landscape' : value <= 0.83 ? 'portrait' : 'square');
      const target = orientationOf(ratio);
      let best = null;
      let bestScore = Infinity;
      limit.presets.forEach((item) => {
        const preset = parseSize(item);
        if (!preset) return;
        const presetRatio = preset.width / preset.height;
        const score = (orientationOf(presetRatio) === target ? 0 : 10) + Math.abs(Math.log(presetRatio / ratio));
        if (score < bestScore) {
          bestScore = score;
          best = item;
        }
      });
      chosen = best || limit.presets[0];
    }
    return buildResult(chosen, clean, parsed, chosen !== normalized);
  }

  const fitted = fitToLimit(
    parsed.width, parsed.height, limit.maxSide, limit.maxPixels, limit.minPixels
  );
  const size = sizeValue(fitted.width, fitted.height);
  return buildResult(size, clean, parsed, size !== normalized);
}

/**
 * 自定义分辨率：校验宽高范围并按 8 的倍数取整（部分服务商要求 8/16 倍数）。
 * 只做规范化，最终是否降级由 resolveSizeForProvider 按服务商上限处理。
 * @param {number|string} width
 * @param {number|string} height
 * @returns {string|null} 'WxH' 或 null（非法）
 */
function normalizeCustomSize(width, height) {
  const w = parseInt(width, 10);
  const h = parseInt(height, 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 64 || h < 64 || w > 4096 || h > 4096) return null;
  const snappedW = Math.max(64, Math.round(w / 8) * 8);
  const snappedH = Math.max(64, Math.round(h / 8) * 8);
  if (snappedW > 4096 || snappedH > 4096) return null;
  return sizeValue(snappedW, snappedH);
}

/**
 * 把尺寸换算成服务商常用的「画质档位」关键词（插件里 1K/1.5K/2K/4K 的等价物）。
 * WaveSpeed 用 1k/1.5k/2k；MiniMax 用 1K/2K/4K；Seedream 用 1k/1.5k/2k/4k。
 */
function qualityKeyword(size) {
  const parsed = parseSize(size);
  if (!parsed) return '1k';
  const longEdge = Math.max(parsed.width, parsed.height);
  if (longEdge <= 1024) return '1k';
  if (longEdge <= 1536) return '1.5k';
  if (longEdge <= 2048) return '2k';
  return '4k';
}

// 尺寸 → 最接近的常见比例字符串（供 aspect_ratio 参数使用）
function aspectRatioOf(size) {
  const parsed = parseSize(size);
  if (!parsed) return '';
  const ratio = parsed.width / parsed.height;
  const candidates = [
    ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 1.5], ['2:3', 2 / 3],
    ['16:9', 16 / 9], ['9:16', 9 / 16], ['5:4', 1.25], ['4:5', 0.8],
    ['21:9', 21 / 9], ['9:21', 9 / 21]
  ];
  let best = '';
  let bestScore = Infinity;
  candidates.forEach(([key, value]) => {
    const score = Math.abs(Math.log(value / ratio));
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  });
  return best;
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
  // 适配器/网关把「尺寸不支持」包装成别的错误时，由适配器显式打标
  if (err.sizeFallback) return true;
  const text = errorText(err);
  return /(?:^|[^a-z])(size|resolution|dimension|width|height)(?:[^a-z]|$)|分辨率|尺寸|宽高|too large|out of memory|oom|显存|内存不足/i.test(text);
}

module.exports = {
  FOUR_K_PIXELS,
  SIZE_PRESETS,
  SIZE_GROUPS,
  RATIOS,
  QUALITY_TIERS,
  PROVIDER_LIMITS,
  resolveSizeForProvider,
  sizeFromRatioQuality,
  ratioQualityMatrix,
  qualityKeyword,
  aspectRatioOf,
  sizeFallbacks,
  isSizeFallbackError,
  parseSize,
  normalizeCustomSize
};
