/**
 * AI 聊天 / 角色卡广场外观偏好（RP-Hub 式 UI 自定义）
 * 作用：把用户自选的外观设置做白名单收敛后按账户持久化到 users.ai_ui_settings（JSON），
 *      跨设备生效；游客访问角色卡广场时用 localStorage 镜像同一套设置。
 * 作用范围：仅 /ai-chat 与 /characters 两个页面（通过 CSS 变量 + data-ac-* 属性注入），
 *          不影响前台其他页面与后台。
 * 安全：只接受枚举值与受限颜色（预设名或 #RGB/#RRGGBB），数值钳制在区间内；
 *      不接受任何自定义 CSS / HTML / 远程资源，避免样式注入与外链追踪。
 */

// 可选值白名单（前端选项必须与此一致）
const OPTIONS = {
  theme: ['auto', 'light', 'dark'],
  primary: ['iris', 'violet', 'azure', 'teal', 'emerald', 'amber', 'rose', 'crimson', 'slate', 'custom'],
  accent: ['auto', 'violet', 'azure', 'teal', 'emerald', 'amber', 'rose', 'crimson', 'custom'],
  fontUi: ['sans', 'rounded', 'serif', 'system'],
  fontBody: ['system', 'sans', 'serif', 'rounded', 'mono'],
  fontSize: [85, 130],          // 百分比区间
  bubble: ['glass', 'soft', 'flat', 'sharp', 'wechat'],
  avatar: ['circle', 'rounded', 'square'],
  density: ['compact', 'cozy', 'roomy'],
  background: ['aurora', 'none', 'grid', 'dots', 'gradient'],
  lineHeight: [130, 220]        // 百分比区间
};

const DEFAULTS = {
  theme: 'auto',
  primary: 'iris',
  primaryCustom: '',
  accent: 'auto',
  accentCustom: '',
  fontUi: 'sans',
  fontBody: 'system',
  fontSize: 100,
  lineHeight: 165,
  bubble: 'glass',
  avatar: 'circle',
  density: 'cozy',
  background: 'aurora',
  reduceMotion: false,
  wideChat: false
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function pick(list, value, fallback) {
  return list.indexOf(value) !== -1 ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function pickColor(value, maxLen) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return HEX_RE.test(s) ? s.slice(0, maxLen || 9) : '';
}

/**
 * 收敛外观偏好：未知键丢弃、非法值回退默认
 * @param {string|object} raw users.ai_ui_settings 原始值（JSON 字符串或对象）
 * @returns {object} 归一化后的偏好（始终包含全部键）
 */
function sanitize(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch (e) { src = null; }
  }
  if (!src || typeof src !== 'object') src = {};

  const out = Object.assign({}, DEFAULTS);
  out.theme = pick(OPTIONS.theme, src.theme, DEFAULTS.theme);
  out.primary = pick(OPTIONS.primary, src.primary, DEFAULTS.primary);
  out.primaryCustom = pickColor(src.primaryCustom);
  out.accent = pick(OPTIONS.accent, src.accent, DEFAULTS.accent);
  out.accentCustom = pickColor(src.accentCustom);
  out.fontUi = pick(OPTIONS.fontUi, src.fontUi, DEFAULTS.fontUi);
  out.fontBody = pick(OPTIONS.fontBody, src.fontBody, DEFAULTS.fontBody);
  out.fontSize = clampInt(src.fontSize, OPTIONS.fontSize[0], OPTIONS.fontSize[1], DEFAULTS.fontSize);
  out.lineHeight = clampInt(src.lineHeight, OPTIONS.lineHeight[0], OPTIONS.lineHeight[1], DEFAULTS.lineHeight);
  out.bubble = pick(OPTIONS.bubble, src.bubble, DEFAULTS.bubble);
  out.avatar = pick(OPTIONS.avatar, src.avatar, DEFAULTS.avatar);
  out.density = pick(OPTIONS.density, src.density, DEFAULTS.density);
  out.background = pick(OPTIONS.background, src.background, DEFAULTS.background);
  out.reduceMotion = src.reduceMotion === true || src.reduceMotion === 1 || src.reduceMotion === '1';
  out.wideChat = src.wideChat === true || src.wideChat === 1 || src.wideChat === '1';

  // 选了 custom 却没给合法色值 → 回退默认预设，避免前端拿到空色
  if (out.primary === 'custom' && !out.primaryCustom) out.primary = DEFAULTS.primary;
  if (out.accent === 'custom' && !out.accentCustom) out.accent = 'auto';
  return out;
}

// 序列化为可入库的 JSON 字符串（先收敛，杜绝脏数据落库）
function serialize(raw) {
  try {
    return JSON.stringify(sanitize(raw));
  } catch (e) {
    return JSON.stringify(DEFAULTS);
  }
}

module.exports = { DEFAULTS, OPTIONS, sanitize, serialize };
