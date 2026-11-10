/**
 * AI 聊天 / 角色卡广场外观自定义（RP-Hub 式 UI 设置）
 * 作用：把用户偏好写入 <html> 的 data-ac-* 属性与 CSS 变量，实时预览并持久化。
 *      登录用户 → POST /ai-chat/api/ui-settings 落库（跨设备）；游客 → localStorage 镜像。
 * 依赖：public/js/utils.js（csrfFetch / showToast / getCsrfToken），public/css/ai-chat.css 的外观层。
 * 值域必须与 server/services/ai-chat/ui-prefs.js 的 OPTIONS / DEFAULTS 严格一致。
 * 本文件同时服务于 /ai-chat 与 /characters：从页面 bootstrap JSON 读取初始偏好。
 */
(function () {
  'use strict';

  // ---- 值域白名单（与服务端 ui-prefs.js 保持一致）----
  var OPTIONS = {
    theme: ['auto', 'light', 'dark'],
    primary: ['iris', 'violet', 'azure', 'teal', 'emerald', 'amber', 'rose', 'crimson', 'slate', 'custom'],
    accent: ['auto', 'violet', 'azure', 'teal', 'emerald', 'amber', 'rose', 'crimson', 'custom'],
    fontUi: ['sans', 'rounded', 'serif', 'system'],
    fontBody: ['system', 'sans', 'serif', 'rounded', 'mono'],
    fontSize: [85, 130],
    bubble: ['glass', 'soft', 'flat', 'sharp', 'wechat'],
    avatar: ['circle', 'rounded', 'square'],
    density: ['compact', 'cozy', 'roomy'],
    background: ['aurora', 'none', 'grid', 'dots', 'gradient'],
    lineHeight: [130, 220]
  };

  var DEFAULTS = {
    theme: 'auto', primary: 'iris', primaryCustom: '', accent: 'auto', accentCustom: '',
    fontUi: 'sans', fontBody: 'system', fontSize: 100, lineHeight: 165,
    bubble: 'glass', avatar: 'circle', density: 'cozy', background: 'aurora',
    reduceMotion: false, wideChat: false
  };

  var HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var LS_KEY = 'ac_ui_prefs';

  // ---- 面板控件定义（分段按钮组 + 滑块 + 开关 + 取色器）----
  var PRIMARY_LABELS = {
    iris: '鸢尾蓝', violet: '紫罗兰', azure: '天青', teal: '青碧', emerald: '翡翠',
    amber: '琥珀', rose: '蔷薇', crimson: '绯红', slate: '石板灰', custom: '自定义'
  };
  var ACCENT_LABELS = {
    auto: '跟随主色', violet: '紫罗兰', azure: '天青', teal: '青碧', emerald: '翡翠',
    amber: '琥珀', rose: '蔷薇', crimson: '绯红', custom: '自定义'
  };
  var THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };
  var FONT_UI_LABELS = { sans: '无衬线', rounded: '圆体', serif: '衬线', system: '系统' };
  var FONT_BODY_LABELS = { system: '系统', sans: '无衬线', serif: '衬线', rounded: '圆体', mono: '等宽' };
  var BUBBLE_LABELS = { glass: '玻璃', soft: '柔和', flat: '扁平', sharp: '硬朗', wechat: '微信' };
  var AVATAR_LABELS = { circle: '圆形', rounded: '圆角', square: '方形' };
  var DENSITY_LABELS = { compact: '紧凑', cozy: '适中', roomy: '宽松' };
  var BG_LABELS = { aurora: '极光', none: '纯色', grid: '网格', dots: '点阵', gradient: '渐变' };

  // ---- 读取页面 bootstrap（ai-chat / characters 共用）----
  function readBootstrap() {
    var el = document.getElementById('ai-chat-data') || document.getElementById('characters-data');
    if (!el) return {};
    try { return JSON.parse(el.textContent || '{}'); } catch (e) { return {}; }
  }

  function clampInt(v, min, max, fb) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return fb;
    return Math.min(Math.max(n, min), max);
  }

  function pick(list, v, fb) { return list.indexOf(v) !== -1 ? v : fb; }

  function pickColor(v) {
    var s = String(v == null ? '' : v).trim();
    return HEX_RE.test(s) ? s : '';
  }

  // 归一化：任何来源（服务端 / localStorage）都收敛成完整合法对象
  function sanitize(raw) {
    var src = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
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
    if (out.primary === 'custom' && !out.primaryCustom) out.primary = DEFAULTS.primary;
    if (out.accent === 'custom' && !out.accentCustom) out.accent = 'auto';
    return out;
  }

  // ---- 应用到 <html> ----
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme(theme) {
    if (theme === 'dark') return 'dark';
    if (theme === 'light') return 'light';
    return (darkQuery && darkQuery.matches) ? 'dark' : 'light';
  }

  function applyPrefs(p) {
    var root = document.documentElement;
    var resolved = resolveTheme(p.theme);

    // 主题：复用现有 [data-theme="dark"]，并额外标记 data-ac-theme 供气泡层使用
    if (resolved === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    root.setAttribute('data-ac-theme', resolved);

    root.setAttribute('data-ac-primary', p.primary);
    if (p.primary === 'custom' && p.primaryCustom) root.style.setProperty('--primary', p.primaryCustom);
    else root.style.removeProperty('--primary');

    root.setAttribute('data-ac-accent', p.accent);
    if (p.accent === 'custom' && p.accentCustom) root.style.setProperty('--accent', p.accentCustom);
    else root.style.removeProperty('--accent');

    root.setAttribute('data-ac-font-ui', p.fontUi);
    root.setAttribute('data-ac-font-body', p.fontBody);
    root.setAttribute('data-ac-bubble', p.bubble);
    root.setAttribute('data-ac-avatar', p.avatar);
    root.setAttribute('data-ac-density', p.density);
    root.setAttribute('data-ac-bg', p.background === 'aurora' ? 'aurora' : p.background);
    root.setAttribute('data-ac-wide', p.wideChat ? '1' : '0');
    root.setAttribute('data-ac-motion', p.reduceMotion ? 'reduce' : 'full');

    // 字号 / 行高：百分比 → 具体值（基准 14.5px / 1.72）
    root.style.setProperty('--ac-msg-size', (14.5 * p.fontSize / 100).toFixed(2) + 'px');
    root.style.setProperty('--ac-line-height', (p.lineHeight / 100).toFixed(3));

    // aurora 是默认背景（.ac-messages 基础规则已含极光渐变），无需额外属性覆盖
    if (p.background === 'aurora') root.removeAttribute('data-ac-bg');
  }

  // ---- 状态 ----
  var boot = readBootstrap();
  var isGuest = Boolean(boot.isGuest);
  var current = sanitize(boot.uiSettings || readLocal());

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeLocal(p) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
  }

  var saveTimer = null;
  function persist() {
    writeLocal(current); // 始终镜像到本地，登录用户换设备前也能保留
    if (isGuest) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (typeof csrfFetch !== 'function') return;
      csrfFetch('/ai-chat/api/ui-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: current })
      }).then(function (r) { return r.json(); }).then(function (json) {
        if (json && json.success && json.data) { current = sanitize(json.data); }
      }).catch(function () { /* 静默失败，本地已镜像 */ });
    }, 500);
  }

  function update(patch) {
    current = sanitize(Object.assign({}, current, patch));
    applyPrefs(current);
    persist();
    if (panelOpen) syncPanel();
  }

  // ---- 面板 UI（纯 JS 构建，两页共用）----
  var panelOpen = false;
  var panelEl = null;
  var fabEl = null;

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function segGroup(key, labels, order) {
    var wrap = el('div', 'acui-seg');
    order.forEach(function (val) {
      var b = el('button', 'acui-seg-btn', labels[val] || val);
      b.type = 'button';
      b.setAttribute('data-val', val);
      b.addEventListener('click', function () {
        var patch = {}; patch[key] = val; update(patch);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function row(labelText, control) {
    var r = el('div', 'acui-row');
    var lab = el('div', 'acui-row-label', labelText);
    r.appendChild(lab);
    r.appendChild(control);
    return r;
  }

  function buildPanel() {
    var overlay = el('div', 'acui-overlay');
    var panel = el('div', 'acui-panel');
    panel.appendChild(el('div', 'acui-head', '<h2>外观设置</h2>'));

    var body = el('div', 'acui-body');

    body.appendChild(row('主题', segGroup('theme', THEME_LABELS, OPTIONS.theme)));
    body.appendChild(row('主色', segGroup('primary', PRIMARY_LABELS, OPTIONS.primary)));

    // 主色自定义取色
    var primaryColorWrap = el('div', 'acui-color-wrap');
    var primaryColor = el('input', 'acui-color');
    primaryColor.type = 'color'; primaryColor.value = '#5a6ff0';
    var primaryHex = el('input', 'acui-hex'); primaryHex.type = 'text'; primaryHex.placeholder = '#RRGGBB'; primaryHex.maxLength = 7;
    primaryColor.addEventListener('input', function () { primaryHex.value = primaryColor.value; update({ primaryCustom: primaryColor.value, primary: 'custom' }); });
    primaryHex.addEventListener('change', function () { var c = pickColor(primaryHex.value); if (c) update({ primaryCustom: c, primary: 'custom' }); });
    primaryColorWrap.appendChild(primaryColor); primaryColorWrap.appendChild(primaryHex);
    body.appendChild(row('主色自定义', primaryColorWrap));

    body.appendChild(row('强调色', segGroup('accent', ACCENT_LABELS, OPTIONS.accent)));

    var accentColorWrap = el('div', 'acui-color-wrap');
    var accentColor = el('input', 'acui-color');
    accentColor.type = 'color'; accentColor.value = '#8b5cf6';
    var accentHex = el('input', 'acui-hex'); accentHex.type = 'text'; accentHex.placeholder = '#RRGGBB'; accentHex.maxLength = 7;
    accentColor.addEventListener('input', function () { accentHex.value = accentColor.value; update({ accentCustom: accentColor.value, accent: 'custom' }); });
    accentHex.addEventListener('change', function () { var c = pickColor(accentHex.value); if (c) update({ accentCustom: c, accent: 'custom' }); });
    accentColorWrap.appendChild(accentColor); accentColorWrap.appendChild(accentHex);
    body.appendChild(row('强调色自定义', accentColorWrap));

    body.appendChild(row('界面字体', segGroup('fontUi', FONT_UI_LABELS, OPTIONS.fontUi)));
    body.appendChild(row('正文字体', segGroup('fontBody', FONT_BODY_LABELS, OPTIONS.fontBody)));

    // 字号滑块
    var fontWrap = el('div', 'acui-slider-wrap');
    var fontRange = el('input', 'acui-range'); fontRange.type = 'range';
    fontRange.min = OPTIONS.fontSize[0]; fontRange.max = OPTIONS.fontSize[1]; fontRange.step = 1;
    var fontOut = el('span', 'acui-slider-out');
    fontRange.addEventListener('input', function () { fontOut.textContent = fontRange.value + '%'; update({ fontSize: parseInt(fontRange.value, 10) }); });
    fontWrap.appendChild(fontRange); fontWrap.appendChild(fontOut);
    body.appendChild(row('字号', fontWrap));

    // 行高滑块
    var lhWrap = el('div', 'acui-slider-wrap');
    var lhRange = el('input', 'acui-range'); lhRange.type = 'range';
    lhRange.min = OPTIONS.lineHeight[0]; lhRange.max = OPTIONS.lineHeight[1]; lhRange.step = 1;
    var lhOut = el('span', 'acui-slider-out');
    lhRange.addEventListener('input', function () { lhOut.textContent = lhRange.value + '%'; update({ lineHeight: parseInt(lhRange.value, 10) }); });
    lhWrap.appendChild(lhRange); lhWrap.appendChild(lhOut);
    body.appendChild(row('行高', lhWrap));

    body.appendChild(row('气泡样式', segGroup('bubble', BUBBLE_LABELS, OPTIONS.bubble)));
    body.appendChild(row('头像形状', segGroup('avatar', AVATAR_LABELS, OPTIONS.avatar)));
    body.appendChild(row('间距密度', segGroup('density', DENSITY_LABELS, OPTIONS.density)));
    body.appendChild(row('背景', segGroup('background', BG_LABELS, OPTIONS.background)));

    // 开关
    var toggles = el('div', 'acui-toggles');
    toggles.appendChild(makeToggle('reduceMotion', '减少动效'));
    toggles.appendChild(makeToggle('wideChat', '宽屏聊天'));
    body.appendChild(toggles);

    panel.appendChild(body);

    var foot = el('div', 'acui-foot');
    var resetBtn = el('button', 'acui-btn', '恢复默认'); resetBtn.type = 'button';
    resetBtn.addEventListener('click', function () {
      current = sanitize({});
      applyPrefs(current);
      persist();
      if (!isGuest && typeof csrfFetch === 'function') {
        csrfFetch('/ai-chat/api/ui-settings/reset', { method: 'POST' }).catch(function () {});
      }
      syncPanel();
      if (typeof showToast === 'function') showToast('已恢复默认外观', 'success');
    });
    var closeBtn = el('button', 'acui-btn acui-btn-primary', '完成'); closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () { togglePanel(false); });
    foot.appendChild(resetBtn);
    foot.appendChild(el('span', 'acui-foot-spacer'));
    foot.appendChild(closeBtn);
    panel.appendChild(foot);

    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) togglePanel(false); });

    // 保存控件引用以便 syncPanel 回填
    panel._refs = {
      primaryColor: primaryColor, primaryHex: primaryHex,
      accentColor: accentColor, accentHex: accentHex,
      fontRange: fontRange, fontOut: fontOut, lhRange: lhRange, lhOut: lhOut
    };
    return overlay;
  }

  function makeToggle(key, label) {
    var lab = el('label', 'acui-toggle');
    var cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('data-toggle', key);
    cb.addEventListener('change', function () { var p = {}; p[key] = cb.checked; update(p); });
    lab.appendChild(cb);
    lab.appendChild(el('span', null, label));
    return lab;
  }

  // 把当前状态回填到面板控件（active 高亮 / 滑块值 / 开关）
  function syncPanel() {
    if (!panelEl) return;
    var refs = panelEl._refs || {};
    // 分段按钮
    panelEl.querySelectorAll('.acui-row').forEach(function (r) {
      var lab = r.querySelector('.acui-row-label');
      var seg = r.querySelector('.acui-seg');
      if (!lab || !seg) return;
      var key = labelToKey(lab.textContent);
      if (!key) return;
      seg.querySelectorAll('.acui-seg-btn').forEach(function (b) {
        b.classList.toggle('active', String(current[key]) === b.getAttribute('data-val'));
      });
    });
    if (refs.fontRange) { refs.fontRange.value = current.fontSize; refs.fontOut.textContent = current.fontSize + '%'; }
    if (refs.lhRange) { refs.lhRange.value = current.lineHeight; refs.lhOut.textContent = current.lineHeight + '%'; }
    if (refs.primaryColor) { var pc = current.primaryCustom || '#5a6ff0'; refs.primaryColor.value = pc; refs.primaryHex.value = current.primaryCustom || ''; }
    if (refs.accentColor) { var ac = current.accentCustom || '#8b5cf6'; refs.accentColor.value = ac; refs.accentHex.value = current.accentCustom || ''; }
    panelEl.querySelectorAll('input[data-toggle]').forEach(function (cb) {
      cb.checked = Boolean(current[cb.getAttribute('data-toggle')]);
    });
  }

  var LABEL_KEY = {
    '主题': 'theme', '主色': 'primary', '强调色': 'accent', '界面字体': 'fontUi',
    '正文字体': 'fontBody', '气泡样式': 'bubble', '头像形状': 'avatar',
    '间距密度': 'density', '背景': 'background'
  };
  function labelToKey(text) { return LABEL_KEY[text] || null; }

  function togglePanel(force) {
    panelOpen = (force === undefined) ? !panelOpen : Boolean(force);
    if (panelOpen) {
      if (!panelEl) { panelEl = buildPanel(); document.body.appendChild(panelEl); }
      syncPanel();
      panelEl.classList.add('open');
      if (fabEl) fabEl.classList.add('active');
    } else if (panelEl) {
      panelEl.classList.remove('open');
      if (fabEl) fabEl.classList.remove('active');
    }
  }

  function buildFab() {
    var fab = el('button', 'acui-fab', '🎨');
    fab.type = 'button';
    fab.title = '外观设置';
    fab.setAttribute('aria-label', '外观设置');
    fab.addEventListener('click', function () { togglePanel(); });
    document.body.appendChild(fab);
    return fab;
  }

  // 系统主题变化时，若为 auto 则实时切换
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener('change', function () {
      if (current.theme === 'auto') applyPrefs(current);
    });
  }

  // 脚本置于 </body> 前：documentElement 与 body 均已就绪，立即应用避免首屏闪烁，
  // 并保证在 defer 的 ai-chat.js 之前完成主题落地（ai-chat.js 的主题按钮据此同步图标）。
  applyPrefs(current);
  fabEl = buildFab();

  // 暴露给页面脚本（可选联动）
  window.ACAppearance = {
    get: function () { return Object.assign({}, current); },
    set: function (patch) { update(patch); },
    openPanel: function () { togglePanel(true); },
    sanitize: sanitize
  };
})();
