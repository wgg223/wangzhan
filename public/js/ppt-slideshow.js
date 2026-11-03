/* global PPTScene */
/**
 * 幻灯片放映引擎（编辑器「放映」与分享页「放映」共用）
 *
 * 用法：PPTShow.start({ doc, index, title, readOnly, onEvent })
 *
 * 覆盖 PowerPoint / WPS 演示模式的主要能力：
 *   - 全屏放映（全屏被拒绝时退化为页内铺满）
 *   - 切页动画（渐隐 / 推入 / 缩放 / 翻转，按页设置）
 *   - 键盘、鼠标单击、右键菜单三种推进方式
 *   - 跳页面板（O）、幻灯片编号与进度条
 *   - 黑屏 / 白屏（B / W）、临时擦除（Ctrl+E 或 E）、画笔标注、激光笔
 *   - 放映计时、每页计时、排练计时（R 记录，回写 slide.timings）
 *   - 自动放映、循环放映、放映范围（设置面板）
 *   - 演讲者视图（S，独立窗口：当前页 + 下一页 + 备注 + 计时 + 页列表 + 标注同步）
 *   - 超链接元素点击跳转（不推进幻灯片）
 *
 * 依赖 window.PPTScene（同一份渲染层，保证放映所见 = 编辑所得）。
 */
(function () {
  'use strict';

  var KEYS_NEXT = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, Enter: 1, n: 1, N: 1 };
  var KEYS_PREV = { ArrowLeft: 1, ArrowUp: 1, PageUp: 1, Backspace: 1, p: 1, P: 1 };
  var PEN_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#007aff', '#ffffff'];

  /** 运行时状态（单次放映会话内有效，不写回文档） */
  function createContext() {
    return {
      slides: [],
      originIdx: [],
      idx: 0,
      root: null,
      stage: null,
      canvas: null,
      ink: null,
      inkBySlide: {},
      activePath: null,
      tool: 'select', // select | pen | highlighter | eraser | laser
      penColor: PEN_COLORS[0],
      penWidth: 4,
      screen: null, // black | white | null
      blackoutBackup: null,
      timerVisible: false,
      timerStart: 0,
      elapsedBase: 0,
      timerPaused: false,
      pauseAt: 0,
      rehearsing: false,
      slideStartAt: 0,
      timings: {},
      autoTimer: null,
      settings: { mode: 'manual', perSlideMs: 5000, loop: false },
      presenterWin: null,
      laser: { points: [], raf: null },
      cursorHideTimer: null,
      destroyed: false
    };
  }

  var ctx = null;

  // ============ 小工具 ============

  function el(tag, cls, cssText) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (cssText) n.style.cssText = cssText;
    return n;
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? p(h) + ':' : '') + p(m) + ':' + p(s);
  }

  function toast(msg, type) {
    if (!ctx || !ctx.root) return;
    var box = ctx.root.querySelector('.ppt-show-toast');
    if (!box) {
      box = el('div', 'ppt-show-toast');
      ctx.root.appendChild(box);
    }
    box.textContent = msg;
    box.className = 'ppt-show-toast show' + (type ? ' is-' + type : '');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.className = 'ppt-show-toast'; }, 2200);
  }

  function now() { return Date.now(); }

  function elapsedMs() {
    if (!ctx.timerStart) return ctx.elapsedBase;
    if (ctx.timerPaused) return ctx.elapsedBase;
    return ctx.elapsedBase + (now() - ctx.timerStart);
  }

  // ============ 结构搭建 ============

  function buildDom(opts) {
    var c = ctx;
    c.root = el('div', 'ppt-show-root');
    c.root.setAttribute('tabindex', '-1');

    c.stage = el('div', 'ppt-show-stage');
    c.canvas = el('div', 'ppt-canvas');
    c.stage.appendChild(c.canvas);
    c.root.appendChild(c.stage);

    // 标注层（SVG，随画布同一变换，坐标用逻辑 960x540）
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ppt-ink-layer');
    svg.setAttribute('viewBox', '0 0 ' + PPTScene.LOGIC_W + ' ' + PPTScene.LOGIC_H);
    svg.setAttribute('preserveAspectRatio', 'none');
    c.ink = svg;
    c.stage.appendChild(svg);

    // 激光笔层
    c.laserLayer = el('div', 'ppt-laser-layer');
    c.stage.appendChild(c.laserLayer);

    // 屏幕遮罩（黑屏 / 白屏）
    c.screenMask = el('div', 'ppt-screen-mask');
    c.screenMask.hidden = true;
    c.root.appendChild(c.screenMask);

    // HUD：页码 + 计时 + 进度条
    var hud = el('div', 'ppt-show-hud');
    hud.innerHTML = ''
      + '<span class="ppt-counter"></span>'
      + '<span class="ppt-timer" hidden></span>'
      + '<span class="ppt-show-title"></span>';
    hud.querySelector('.ppt-show-title').textContent = opts.title || '';
    c.root.appendChild(hud);

    var progress = el('div', 'ppt-show-progress');
    progress.appendChild(el('i'));
    c.root.appendChild(progress);
    c.progress = progress;

    // 悬浮工具条（鼠标移动出现）
    var bar = el('div', 'ppt-show-bar');
    bar.innerHTML = ''
      + '<button type="button" data-act="prev" title="上一页（←）">◀</button>'
      + '<button type="button" data-act="next" title="下一页（→ / 空格）">▶</button>'
      + '<button type="button" data-act="grid" title="全部幻灯片（O）">▦</button>'
      + '<button type="button" data-act="pen" title="画笔（P）">✎</button>'
      + '<button type="button" data-act="laser" title="激光笔（L）">☀</button>'
      + '<button type="button" data-act="eraser" title="擦除标注（E）">⌫</button>'
      + '<button type="button" data-act="black" title="黑屏（B）">◼</button>'
      + '<button type="button" data-act="white" title="白屏（W）">◻</button>'
      + '<button type="button" data-act="timer" title="计时（T）">⏱</button>'
      + '<button type="button" data-act="rehearse" title="排练计时（R）">🎗</button>'
      + '<button type="button" data-act="presenter" title="演讲者视图（S）">🗣</button>'
      + '<button type="button" data-act="settings" title="放映设置">⚙</button>'
      + '<button type="button" data-act="help" title="快捷键（?）">?</button>'
      + '<button type="button" data-act="exit" title="退出放映（Esc）">✕</button>';
    c.root.appendChild(bar);
    c.bar = bar;

    c.grid = el('div', 'ppt-show-grid');
    c.grid.hidden = true;
    c.root.appendChild(c.grid);

    c.menu = el('div', 'ppt-show-menu');
    c.menu.hidden = true;
    c.root.appendChild(c.menu);

    c.panel = el('div', 'ppt-show-panel');
    c.panel.hidden = true;
    c.root.appendChild(c.panel);

    document.body.appendChild(c.root);
    c.root.focus();
  }

  // ============ 渲染当前页 ============

  function currentSlide() { return ctx.slides[ctx.idx] || null; }

  /** 放映页 → 文档原始页序号（隐藏页被跳过，页码提示仍需显示真实页号） */
  function originOf(i) {
    var arr = ctx && ctx.originIdx;
    return arr && arr[i] != null ? arr[i] : i;
  }

  function animate(dir) {
    var slide = currentSlide();
    var tr = (slide && slide.transition) || {};
    var type = tr.type || 'fade';
    var dur = Math.max(0, Math.min(2000, Number(tr.duration) || 400));
    var canvas = ctx.canvas;
    if (type === 'none' || !dur || !canvas.animate) return;
    var frames = type === 'slide'
      ? [{ opacity: 0, transform: 'translateX(' + (dir < 0 ? '-' : '') + '60px)' }, { opacity: 1, transform: 'translateX(0)' }]
      : type === 'zoom'
        ? [{ opacity: 0, transform: 'scale(.88)' }, { opacity: 1, transform: 'scale(1)' }]
        : type === 'flip'
          ? [{ opacity: 0, transform: 'perspective(1200px) rotateY(' + (dir < 0 ? '-' : '') + '38deg)' }, { opacity: 1, transform: 'perspective(1200px) rotateY(0deg)' }]
          : [{ opacity: 0 }, { opacity: 1 }];
    try { canvas.animate(frames, { duration: dur, easing: 'ease-out' }); } catch (e) { /* 动画失败不影响放映 */ }
  }

  function paintSlide(dir) {
    var slide = currentSlide();
    PPTScene.renderSlide(ctx.canvas, slide);
    PPTScene.fit(ctx.stage, ctx.canvas, true);
    bindLinks();
    renderInk();
    var counter = ctx.root.querySelector('.ppt-counter');
    if (counter) {
      var originIdx = slide ? originOf(ctx.idx) + 1 : '-';
      counter.textContent = '幻灯片 ' + (ctx.idx + 1) + ' / ' + ctx.slides.length + '（原第 ' + originIdx + ' 页）';
    }
    var fill = ctx.progress && ctx.progress.firstElementChild;
    if (fill && ctx.slides.length) fill.style.width = (((ctx.idx + 1) / ctx.slides.length) * 100) + '%';
    animate(dir || 1);
    scheduleAuto();
    syncPresenter();
    if (ctx.onEvent) ctx.onEvent('slidechange', { index: ctx.idx, slide: slide });
  }

  function bindLinks() {
    ctx.canvas.querySelectorAll('.ppt-clickable').forEach(function (node) {
      node.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var slide = currentSlide();
        var target = ((slide && slide.elements) || []).filter(function (e) { return e.id === node.dataset.elId; })[0];
        var url = target && target.link;
        if (url) window.open(/^https?:\/\//i.test(url) ? url : 'https://' + url, '_blank', 'noopener');
      });
    });
  }

  // ============ 翻页 ============

  function flushTiming(slide) {
    if (!ctx.rehearsing || !slide) return;
    var spent = Math.max(0, now() - ctx.slideStartAt);
    ctx.timings[slide.id] = Math.round((ctx.timings[slide.id] || 0) + spent);
  }

  function goTo(n, silent) {
    if (!ctx.slides.length) return;
    var target = Math.max(0, Math.min(ctx.slides.length - 1, n));
    if (target === ctx.idx && !silent) return;
    var dir = target > ctx.idx ? 1 : -1;
    flushTiming(ctx.slides[ctx.idx]);
    ctx.idx = target;
    ctx.slideStartAt = now();
    paintSlide(dir);
    if (!silent) hideMenu();
  }

  function next() {
    if (ctx.idx >= ctx.slides.length - 1) {
      if (ctx.settings.loop && ctx.slides.length > 1) { goTo(0); return; }
      toast('已是最后一页', 'info');
      return;
    }
    goTo(ctx.idx + 1);
  }

  function prev() {
    if (ctx.idx <= 0) { toast('已是第一页', 'info'); return; }
    goTo(ctx.idx - 1);
  }

  // ============ 自动放映 / 循环 ============

  function scheduleAuto() {
    clearTimeout(ctx.autoTimer);
    if (ctx.settings.mode !== 'auto') return;
    var slide = currentSlide();
    var ms = ctx.settings.perSlideMs;
    if (ctx.settings.useTimings && slide && ctx.timings[slide.id]) ms = ctx.timings[slide.id];
    ctx.autoTimer = setTimeout(function () {
      if (ctx.destroyed) return;
      if (ctx.idx >= ctx.slides.length - 1) {
        if (ctx.settings.loop) goTo(0);
        return;
      }
      next();
    }, Math.max(500, ms));
  }

  // ============ 标注（画笔 / 荧光笔 / 橡皮） ============

  function inkKey() { return ctx.idx; }

  function renderInk() {
    while (ctx.ink.firstChild) ctx.ink.removeChild(ctx.ink.firstChild);
    var paths = ctx.inkBySlide[inkKey()] || [];
    paths.forEach(function (p) { ctx.ink.appendChild(buildPath(p)); });
    if (ctx.activePath) ctx.ink.appendChild(buildPath(ctx.activePath));
  }

  function buildPath(p) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', p.color);
    path.setAttribute('stroke-width', p.width);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (p.highlight) { path.setAttribute('opacity', '0.35'); path.setAttribute('stroke-width', Number(p.width) * 4); }
    return path;
  }

  function inkPoint(ev) {
    var pt = PPTScene.toCanvasPoint(ctx.canvas, ev.clientX, ev.clientY);
    return { x: Math.max(0, Math.min(PPTScene.LOGIC_W, pt.x)), y: Math.max(0, Math.min(PPTScene.LOGIC_H, pt.y)) };
  }

  function startInk(ev) {
    ctx.activePath = {
      d: 'M ' + inkPoint(ev).x.toFixed(1) + ' ' + inkPoint(ev).y.toFixed(1),
      color: ctx.penColor, width: ctx.penWidth, highlight: ctx.tool === 'highlighter'
    };
    ctx.moveBase = inkPoint(ev);
  }

  function moveInk(ev) {
    if (!ctx.activePath) return;
    var p = inkPoint(ev);
    var last = ctx.moveBase || p;
    var dist = Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
    if (dist < 2) return;
    ctx.activePath.d += ' L ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    ctx.moveBase = p;
    renderInk();
    syncPresenterInk();
  }

  function endInk() {
    if (!ctx.activePath) return;
    if (!ctx.inkBySlide[inkKey()]) ctx.inkBySlide[inkKey()] = [];
    ctx.inkBySlide[inkKey()].push(ctx.activePath);
    ctx.activePath = null;
    renderInk();
    syncPresenterInk();
  }

  function eraseInk() {
    ctx.inkBySlide[inkKey()] = [];
    ctx.activePath = null;
    renderInk();
    syncPresenterInk();
    toast('已清除本页标注');
  }

  function undoInk() {
    var arr = ctx.inkBySlide[inkKey()];
    if (arr && arr.length) arr.pop();
    renderInk();
    syncPresenterInk();
  }

  function setTool(tool) {
    ctx.tool = tool;
    ctx.root.classList.toggle('is-pen', tool === 'pen' || tool === 'highlighter');
    ctx.root.classList.toggle('is-eraser', tool === 'eraser');
    ctx.root.classList.toggle('is-laser', tool === 'laser');
    ctx.bar.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.act === tool || (tool === 'highlighter' && b.dataset.act === 'pen'));
    });
    if (tool !== 'laser') stopLaser();
  }

  // ============ 激光笔 ============

  function laserMove(ev) {
    if (ctx.tool !== 'laser') return;
    var pt = PPTScene.toCanvasPoint(ctx.canvas, ev.clientX, ev.clientY);
    ctx.laser.points.push({ x: pt.x, y: pt.y, t: now() });
    if (ctx.laser.points.length > 60) ctx.laser.points.shift();
    if (!ctx.laser.raf) tickLaser();
  }

  function tickLaser() {
    var draw = function () {
      if (!ctx || !ctx.laserLayer) { if (ctx) ctx.laser.raf = null; return; }
      var cutoff = now() - 700;
      ctx.laser.points = ctx.laser.points.filter(function (p) { return p.t > cutoff; });
      var html = '';
      ctx.laser.points.forEach(function (p) {
        var age = (now() - p.t) / 700;
        var r = 9 * (1 - age) + 2;
        html += '<i style="left:' + p.x.toFixed(1) + 'px;top:' + p.y.toFixed(1) + 'px;width:' + r.toFixed(1) + 'px;height:' + r.toFixed(1) + 'px;opacity:' + (1 - age).toFixed(2) + '"></i>';
      });
      ctx.laserLayer.innerHTML = html;
      ctx.laser.raf = ctx.laser.points.length ? requestAnimationFrame(draw) : null;
    };
    ctx.laser.raf = requestAnimationFrame(draw);
  }

  function stopLaser() {
    ctx.laser.points = [];
    if (ctx.laserLayer) ctx.laserLayer.innerHTML = '';
  }

  // ============ 黑屏 / 白屏 ============

  function screenOn(kind) {
    ctx.screen = kind;
    ctx.screenMask.hidden = false;
    ctx.screenMask.style.background = kind === 'black' ? '#000' : '#fff';
  }

  function screenOff() {
    ctx.screen = null;
    ctx.screenMask.hidden = true;
  }

  // ============ 跳页面板 ============

  function toggleGrid() {
    if (!ctx.grid.hidden) { ctx.grid.hidden = true; return; }
    ctx.grid.innerHTML = '';
    ctx.slides.forEach(function (s, i) {
      var cell = el('button', 'ppt-grid-cell' + (i === ctx.idx ? ' is-current' : '') + (s.hidden ? ' is-hidden' : ''));
      cell.type = 'button';
      var miniStage = el('div', 'ppt-grid-stage');
      var miniCanvas = el('div', 'ppt-canvas');
      miniStage.appendChild(miniCanvas);
      PPTScene.renderSlide(miniCanvas, s);
      requestAnimationFrame(function () { PPTScene.fit(miniStage, miniCanvas, false); });
      cell.appendChild(miniStage);
      var label = el('span', 'ppt-grid-label');
      label.textContent = (originOf(i) + 1) + '. ' + (s.title || (s.elements[0] && String(s.elements[0].content || '')).slice(0, 12) || '幻灯片');
      cell.appendChild(label);
      cell.addEventListener('click', function () { goTo(i); ctx.grid.hidden = true; });
      ctx.grid.appendChild(cell);
    });
    ctx.grid.hidden = false;
  }

  // ============ 右键菜单 ============

  var MENU_ITEMS = [
    { act: 'next', label: '下一页', key: '→ / 空格' },
    { act: 'prev', label: '上一页', key: '←' },
    { act: 'grid', label: '所有幻灯片', key: 'O' },
    { sep: true },
    { act: 'black', label: '黑屏', key: 'B' },
    { act: 'white', label: '白屏', key: 'W' },
    { act: 'pen', label: '画笔标注', key: 'P' },
    { act: 'laser', label: '激光笔', key: 'L' },
    { act: 'undo', label: '撤销标注', key: 'Ctrl+Z' },
    { sep: true },
    { act: 'timer', label: '显示计时', key: 'T' },
    { act: 'rehearse', label: '排练计时', key: 'R' },
    { act: 'presenter', label: '演讲者视图', key: 'S' },
    { act: 'settings', label: '放映设置' },
    { sep: true },
    { act: 'exit', label: '关闭放映', key: 'Esc' }
  ];

  function showMenu(x, y) {
    ctx.menu.innerHTML = '';
    MENU_ITEMS.forEach(function (item) {
      if (item.sep) { ctx.menu.appendChild(el('i', 'ppt-menu-sep')); return; }
      var b = el('button', 'ppt-menu-item');
      b.type = 'button';
      b.innerHTML = '<span></span><em></em>';
      b.firstChild.textContent = item.label;
      b.lastChild.textContent = item.key || '';
      b.addEventListener('click', function () { act(item.act); });
      ctx.menu.appendChild(b);
    });
    ctx.menu.style.left = Math.min(x, window.innerWidth - 240) + 'px';
    ctx.menu.style.top = Math.min(y, window.innerHeight - ctx.menu.offsetHeight - 20) + 'px';
    ctx.menu.hidden = false;
  }

  function hideMenu() { if (ctx.menu) ctx.menu.hidden = true; }

  // ============ 放映设置 ============

  function openSettings() {
    var s = ctx.settings;
    ctx.panel.innerHTML = '';
    ctx.panel.hidden = false;
    var box = el('div', 'ppt-panel-card');
    box.innerHTML = '<h3>放映设置</h3>';
    box.appendChild(row('放映方式', '<select id="pptMode">'
      + opt('manual', '手动（翻页）', s.mode)
      + opt('auto', '自动（按时间）', s.mode)
      + '</select>'));
    box.appendChild(row('每页停留', '<input id="pptPerSlide" type="number" min="1" max="600" step="1" value="' + Math.round(s.perSlideMs / 1000) + '"> 秒'));
    box.appendChild(row('', '<label><input type="checkbox" id="pptUseTimings"' + (s.useTimings ? ' checked' : '') + '> 优先使用本页排练时长</label>'));
    box.appendChild(row('', '<label><input type="checkbox" id="pptLoop"' + (s.loop ? ' checked' : '') + '> 循环放映</label>'));
    box.appendChild(row('放映范围', '<select id="pptRange">'
      + opt('all', '全部幻灯片', s.range === 'all')
      + opt('current', '从当前页到结束', s.range === 'current')
      + '</select>'));
    var actions = el('div', 'ppt-panel-actions');
    var ok = el('button', 'ppt-panel-btn is-primary'); ok.type = 'button'; ok.textContent = '应用';
    var cancel = el('button', 'ppt-panel-btn'); cancel.type = 'button'; cancel.textContent = '取消';
    ok.addEventListener('click', function () {
      s.mode = box.querySelector('#pptMode').value;
      s.perSlideMs = Math.max(1, Number(box.querySelector('#pptPerSlide').value) || 5) * 1000;
      s.useTimings = box.querySelector('#pptUseTimings').checked;
      s.loop = box.querySelector('#pptLoop').checked;
      s.range = box.querySelector('#pptRange').value;
      ctx.panel.hidden = true;
      toast(s.mode === 'auto' ? '已切换为自动放映' : '已切换为手动放映');
      scheduleAuto();
    });
    cancel.addEventListener('click', function () { ctx.panel.hidden = true; });
    actions.appendChild(cancel); actions.appendChild(ok);
    box.appendChild(actions);
    ctx.panel.appendChild(box);
  }

  function opt(value, label, selected) {
    return '<option value="' + value + '"' + (selected === value ? ' selected' : '') + '>' + label + '</option>';
  }

  function row(label, html) {
    var r = el('div', 'ppt-panel-row');
    r.innerHTML = (label ? '<label class="ppt-panel-label">' + label + '</label>' : '<span class="ppt-panel-label"></span>') + '<div class="ppt-panel-field">' + html + '</div>';
    return r;
  }

  // ============ 快捷键面板 ============

  var HELP = [
    ['→ / 空格 / 单击', '下一页'], ['← / Backspace', '上一页'],
    ['Home / End', '第一页 / 最后一页'], ['数字 + Enter', '跳转到指定页'],
    ['B / W', '黑屏 / 白屏'], ['P', '画笔（数字 1-5 换色）'],
    ['L', '激光笔'], ['E / Ctrl+Z', '清除 / 撤销标注'],
    ['T', '放映计时'], ['R', '排练计时（时长写回文档）'],
    ['S', '演讲者视图'], ['O', '所有幻灯片跳页'],
    ['F / F5', '进入 / 退出全屏'], ['Esc', '退出放映'], ['?', '本帮助']
  ];

  function openHelp() {
    ctx.panel.innerHTML = '';
    ctx.panel.hidden = false;
    var box = el('div', 'ppt-panel-card');
    box.innerHTML = '<h3>放映快捷键</h3>';
    var table = el('div', 'ppt-help-list');
    HELP.forEach(function (pair) {
      var line = el('div', 'ppt-help-line');
      line.innerHTML = '<kbd></kbd><span></span>';
      line.firstChild.textContent = pair[0];
      line.lastChild.textContent = pair[1];
      table.appendChild(line);
    });
    box.appendChild(table);
    var close = el('button', 'ppt-panel-btn is-primary'); close.type = 'button'; close.textContent = '知道了';
    close.addEventListener('click', function () { ctx.panel.hidden = true; });
    box.appendChild(close);
    ctx.panel.appendChild(box);
  }

  // ============ 动作分发 ============

  function act(name) {
    hideMenu();
    switch (name) {
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'first': goTo(0); break;
      case 'last': goTo(ctx.slides.length - 1); break;
      case 'grid': toggleGrid(); break;
      case 'pen': setTool(ctx.tool === 'pen' ? 'select' : 'pen'); toast(ctx.tool === 'pen' ? '画笔已开启（1-5 选色，E 清除）' : '画笔已关闭'); break;
      case 'highlighter': setTool('highlighter'); break;
      case 'laser': setTool(ctx.tool === 'laser' ? 'select' : 'laser'); break;
      case 'eraser': case 'erase': eraseInk(); break;
      case 'undo': undoInk(); break;
      case 'black': case 'white':
        if (ctx.screen === name) screenOff(); else screenOn(name);
        break;
      case 'screenoff': screenOff(); break;
      case 'timer': toggleTimer(); break;
      case 'timersReset': resetTimer(); break;
      case 'rehearse': toggleRehearse(); break;
      case 'presenter': openPresenter(); break;
      case 'settings': openSettings(); break;
      case 'help': openHelp(); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'exit': stop(); break;
      default: break;
    }
  }

  function resetTimer() {
    ctx.elapsedBase = 0;
    ctx.timerStart = now();
    toast('计时已归零');
  }

  function toggleTimer() {
    ctx.timerVisible = !ctx.timerVisible;
    var t = ctx.root.querySelector('.ppt-timer');
    if (ctx.timerVisible) {
      if (!ctx.timerStart && !ctx.elapsedBase) { ctx.timerStart = now(); }
      t.hidden = false;
      tickTimer();
    } else {
      t.hidden = true;
    }
  }

  function tickTimer() {
    if (!ctx || ctx.destroyed) return;
    var t = ctx.root && ctx.root.querySelector('.ppt-timer');
    if (t && !t.hidden) t.textContent = fmtClock(elapsedMs()) + (ctx.rehearsing ? ' · 排练中' : '');
    setTimeout(tickTimer, 500);
  }

  function toggleRehearse() {
    ctx.rehearsing = !ctx.rehearsing;
    if (ctx.rehearsing) {
      ctx.timings = {};
      ctx.slideStartAt = now();
      ctx.elapsedBase = 0;
      ctx.timerStart = now();
      ctx.timerVisible = true;
      ctx.root.querySelector('.ppt-timer').hidden = false;
      toast('排练计时开始：每页停留时长将写回文档', 'info');
    } else {
      flushTiming(currentSlide());
      ctx.timerStart = 0;
      ctx.elapsedBase = 0;
      toast('排练计时结束');
      if (ctx.onEvent) ctx.onEvent('timings', { timings: ctx.timings });
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () { /* 忽略 */ });
      return;
    }
    if (ctx.root.requestFullscreen) {
      ctx.root.requestFullscreen().catch(function () {
        ctx.root.classList.add('is-simulated');
        toast('浏览器未允许全屏，已用窗口内全屏放映', 'warn');
      });
    } else {
      ctx.root.classList.add('is-simulated');
    }
  }

  // ============ 演讲者视图 ============

  var PRESENTER_CSS = '/css/ppt-scene.css,/css/ppt-slideshow.css';

  function openPresenter() {
    if (ctx.presenterWin && !ctx.presenterWin.closed) { ctx.presenterWin.focus(); syncPresenter(); return; }
    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>演讲者视图</title>'
      + PRESENTER_CSS.split(',').map(function (href) { return '<link rel="stylesheet" href="' + href + '">'; }).join('')
      + '</head><body class="ppt-presenter-body">'
      + '<div class="ppt-presenter-main"><div class="ppt-presenter-block"><h4>当前幻灯片</h4><div class="ppt-presenter-stage" id="pvCurrent"></div></div>'
      + '<div class="ppt-presenter-block"><h4>下一页</h4><div class="ppt-presenter-stage" id="pvNext"></div></div></div>'
      + '<div class="ppt-presenter-side">'
      + '<div class="ppt-presenter-meta"><span id="pvCounter"></span><span id="pvClock"></span><span id="pvElapsed"></span></div>'
      + '<h4>备注</h4><div class="ppt-presenter-notes" id="pvNotes"></div>'
      + '<h4>幻灯片列表</h4><div class="ppt-presenter-list" id="pvList"></div>'
      + '<div class="ppt-presenter-tools">'
      + '<button type="button" data-act="prev">◀ 上一页</button>'
      + '<button type="button" data-act="next">下一页 ▶</button>'
      + '<button type="button" data-act="black">黑屏</button>'
      + '<button type="button" data-act="timer">计时归零</button>'
      + '<button type="button" data-act="end">结束放映</button>'
      + '</div></div></body></html>';
    var win = window.open('', 'pptPresenter', 'width=1180,height=720,menubar=no,toolbar=no,location=no,status=no');
    if (!win) { toast('浏览器拦截了演讲者视图窗口，请允许弹窗后重试', 'warn'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    ctx.presenterWin = win;
    win.addEventListener('unload', function () { ctx.presenterWin = null; });
    // 绑定弹窗内按钮
    win.document.querySelectorAll('.ppt-presenter-tools button').forEach(function (b) {
      b.addEventListener('click', function () { presenterAction(b.dataset.act); });
    });
    syncPresenter();
  }

  function presenterAction(name) {
    if (name === 'next') { next(); return; }
    if (name === 'prev') { prev(); return; }
    if (name === 'black') { ctx.screen === 'black' ? screenOff() : screenOn('black'); return; }
    if (name === 'timer') { resetTimer(); return; }
    if (name === 'end') { stop(); }
  }

  function miniRender(stageEl, slide) {
    stageEl.innerHTML = '';
    var canvas = el('div', 'ppt-canvas');
    stageEl.appendChild(canvas);
    PPTScene.renderSlide(canvas, slide);
    requestAnimationFrame(function () {
      PPTScene.fit(stageEl, canvas, true);
      setTimeout(function () { PPTScene.fit(stageEl, canvas, true); }, 60);
    });
  }

  function syncPresenter() {
    var win = ctx.presenterWin;
    if (!win || win.closed) return;
    var cur = currentSlide(), nxt = ctx.slides[ctx.idx + 1];
    var curStage = win.document.getElementById('pvCurrent');
    var nextStage = win.document.getElementById('pvNext');
    if (!curStage || !nextStage) return;
    miniRender(curStage, cur);
    miniRender(nextStage, nxt || null);
    win.document.getElementById('pvNotes').textContent = (cur && cur.notes) || '（本页无备注）';
    win.document.getElementById('pvCounter').textContent = '第 ' + (ctx.idx + 1) + ' / ' + ctx.slides.length + ' 页';
    win.document.getElementById('pvElapsed').textContent = fmtClock(elapsedMs());
    var list = win.document.getElementById('pvList');
    list.innerHTML = '';
    ctx.slides.forEach(function (s, i) {
      var b = el('button', 'ppt-presenter-item' + (i === ctx.idx ? ' is-current' : '') + (s.hidden ? ' is-hidden' : ''));
      b.type = 'button';
      b.textContent = (originOf(i) + 1) + '. ' + (String((s.elements[0] && s.elements[0].content) || s.title || '幻灯片').split('\n')[0]).slice(0, 18);
      b.addEventListener('click', function () { goTo(i); });
      list.appendChild(b);
    });
    syncPresenterInk();
  }

  function syncPresenterInk() {
    var win = ctx.presenterWin;
    if (!win || win.closed) return;
    var stage = win.document.getElementById('pvCurrent');
    if (!stage) return;
    var layer = stage.querySelector('svg.ppt-ink-layer');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      layer.setAttribute('class', 'ppt-ink-layer');
      layer.setAttribute('viewBox', '0 0 ' + PPTScene.LOGIC_W + ' ' + PPTScene.LOGIC_H);
      layer.setAttribute('preserveAspectRatio', 'none');
      stage.appendChild(layer);
    }
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    (ctx.inkBySlide[inkKey()] || []).forEach(function (p) { layer.appendChild(buildPath(p)); });
  }

  // ============ 事件绑定 ============

  var pendingNumber = '';

  function onKeyDown(ev) {
    if (ev.ctrlKey && ev.key && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undoInk(); return; }
    if (ev.target && ev.target.tagName === 'INPUT') return;
    var k = ev.key || '';
    var lower = k.toLowerCase();

    // 画笔状态下的 1-5 优先解释为选色，其余数字留给「跳页」
    if (/^[1-5]$/.test(k) && (ctx.tool === 'pen' || ctx.tool === 'highlighter')) {
      ctx.penColor = PEN_COLORS[parseInt(k, 10) - 1];
      toast('画笔颜色 ' + k);
      return;
    }
    if (/^[0-9]$/.test(k)) {
      pendingNumber += k;
      if (pendingNumber.length > 3) pendingNumber = pendingNumber.slice(-3);
      toast('跳转到 ' + pendingNumber + '（按 Enter 确认）', 'info');
      return;
    }
    if (k === 'Enter' && pendingNumber) {
      goTo(parseInt(pendingNumber, 10) - 1);
      pendingNumber = '';
      ev.preventDefault();
      return;
    }
    if (ev.shiftKey && k === ' ') { ev.preventDefault(); prev(); return; }
    if (KEYS_NEXT[k]) { ev.preventDefault(); next(); return; }
    if (KEYS_PREV[k]) { ev.preventDefault(); prev(); return; }
    if (k === 'Home') { ev.preventDefault(); goTo(0); return; }
    if (k === 'End') { ev.preventDefault(); goTo(ctx.slides.length - 1); return; }
    if (k === 'Escape') {
      if (!ctx.grid.hidden) { ctx.grid.hidden = true; return; }
      if (!ctx.panel.hidden) { ctx.panel.hidden = true; return; }
      if (ctx.screen) { screenOff(); return; }
      stop();
      return;
    }
    if (k === 'f' || k === 'F' || k === 'F5') { ev.preventDefault(); toggleFullscreen(); return; }
    if (lower === 'b') { ctx.screen === 'black' ? screenOff() : screenOn('black'); return; }
    if (lower === 'w') { ctx.screen === 'white' ? screenOff() : screenOn('white'); return; }
    if (lower === 'l') { act('laser'); return; }
    if (lower === 'p') { act('pen'); return; }
    if (lower === 'h') { setTool(ctx.tool === 'highlighter' ? 'select' : 'highlighter'); return; }
    if (lower === 'e') { eraseInk(); return; }
    if (lower === 'o') { toggleGrid(); return; }
    if (lower === 's') { openPresenter(); return; }
    if (lower === 't') { toggleTimer(); return; }
    if (lower === 'r') { toggleRehearse(); return; }
    if (k === '?') { openHelp(); return; }
    if (k === '-') {
      ctx.settings.perSlideMs = Math.max(1000, ctx.settings.perSlideMs - 1000);
      scheduleAuto();
      toast('自动放映间隔 ' + (ctx.settings.perSlideMs / 1000) + ' 秒');
      return;
    }
    if (k === '+') {
      ctx.settings.perSlideMs += 1000;
      scheduleAuto();
      toast('自动放映间隔 ' + (ctx.settings.perSlideMs / 1000) + ' 秒');
    }
  }

  var dragging = false;

  function bindEvents() {
    var c = ctx;
    document.addEventListener('keydown', onKeyDown, true);
    c.onMouseUp = function () {
      if (dragging) { dragging = false; endInk(); }
    };
    document.addEventListener('mouseup', c.onMouseUp);
    c.root.addEventListener('mousemove', function (ev) {
      showCursor();
      laserMove(ev);
      if (dragging) moveInk(ev);
    });
    c.root.addEventListener('mousedown', function (ev) {
      if (ev.button === 2) return;
      if (c.screen) { screenOff(); return; }
      hideMenu();
      if (c.tool === 'pen' || c.tool === 'highlighter') {
        dragging = true;
        startInk(ev);
        ev.preventDefault();
      }
    });
    c.stage.addEventListener('click', function (ev) {
      if (c.tool !== 'select') return;
      if (c.screen) { screenOff(); return; }
      if (ev.target.closest && ev.target.closest('.ppt-clickable')) return;
      next();
    });
    c.root.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY);
    });
    c.bar.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (b) act(b.dataset.act);
    });
    window.addEventListener('resize', function () {
      PPTScene.fit(c.stage, c.canvas, true);
      syncPresenter();
    });
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) {
        c.root.classList.remove('is-simulated');
        PPTScene.fit(c.stage, c.canvas, true);
      }
    });
    showCursor();
  }

  function showCursor() {
    ctx.root.classList.remove('is-cursor-hidden');
    clearTimeout(ctx.cursorHideTimer);
    ctx.cursorHideTimer = setTimeout(function () {
      if (ctx.tool === 'select') ctx.root.classList.add('is-cursor-hidden');
    }, 2600);
  }

  // ============ 生命周期 ============

  function collectSlides(doc, opts) {
    var all = PPTScene.ordered(PPTScene.normalizeDoc(doc));
    var list = opts && opts.includeHidden ? all : all.filter(function (s) { return !s.hidden; });
    ctx.originIdx = list.map(function (s) { return all.indexOf(s); });
    return list;
  }

  /**
   * 开始放映
   * @param {object} opts
   *   doc        演示文稿快照（slides 模型，见 PPTScene 顶部注释）
   *   index      起始页（按未过滤的完整顺序，编辑器当前页）
   *   title      顶部标题（可选）
   *   includeHidden  是否包含隐藏页（默认 false）
   *   presenter      是否打开演讲者视图（默认 false）
   *   rehearse       是否立即开始排练计时（默认 false）
   *   settings   {mode:'manual'|'auto', perSlideMs, loop, useTimings}
   *   onEvent    (name, payload) 回调：slidechange / timings
   * @returns {object} 控制器
   */
  function start(opts) {
    if (ctx) stop();
    var o = opts || {};
    ctx = createContext();
    ctx.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
    ctx.settings = Object.assign({ mode: 'manual', perSlideMs: 5000, loop: false, useTimings: false, range: 'all' }, o.settings || {});
    ctx.slides = collectSlides(o.doc, o);
    if (!ctx.slides.length) { ctx = null; return null; }

    // 预载已有排练时长，便于「自动放映 + 使用排练时长」
    ctx.slides.forEach(function (s) {
      if (s.timings && s.timings.ms) ctx.timings[s.id] = s.timings.ms;
    });

    buildDom(o);
    bindEvents();

    var startIndex = 0;
    var wanted = Number(o.index);
    if (isFinite(wanted)) {
      for (var i = 0; i < ctx.slides.length; i++) {
        if ((ctx.originIdx[i] || 0) === wanted) { startIndex = i; break; }
      }
    }
    ctx.idx = startIndex;
    ctx.slideStartAt = now();
    paintSlide(0);
    toggleFullscreen();
    if (o.presenter) openPresenter();
    if (o.rehearse) toggleRehearse();

    return {
      next: next,
      prev: prev,
      goTo: goTo,
      act: act,
      isOpen: function () { return !ctx.destroyed; },
      getCount: function () { return ctx.slides.length; },
      getIndex: function () { return ctx.idx; },
      getTimings: function () { return ctx.timings; }
    };
  }

  function stop() {
    if (!ctx || ctx.destroyed) return;
    var c = ctx;
    c.destroyed = true;
    clearTimeout(c.autoTimer);
    clearTimeout(c.cursorHideTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    if (c.onMouseUp) document.removeEventListener('mouseup', c.onMouseUp);
    if (c.rehearsing) {
      flushTiming(currentSlide());
      if (Object.keys(c.timings).length && c.onEvent) c.onEvent('timings', { timings: c.timings });
    }
    if (c.presenterWin && !c.presenterWin.closed) c.presenterWin.close();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () { /* 忽略 */ });
    }
    if (c.root && c.root.parentNode) c.root.parentNode.removeChild(c.root);
    ctx = null;
  }

  /** 当前是否正在放映（供宿主页面避免重复启动） */
  function isRunning() { return Boolean(ctx && !ctx.destroyed); }

  window.PPTShow = { start: start, stop: stop, isRunning: isRunning };
})();
