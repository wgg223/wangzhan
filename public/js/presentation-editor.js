/* global PPTScene, PPTShow */
/**
 * 演示文稿编辑器
 * 页面：views/frontend/presentation-editor.ejs（layout:false）
 * 渲染层：/js/ppt-scene.js（与放映、分享页共用）；放映：/js/ppt-slideshow.js
 *
 * 能力：元素选中/拖动/缩放/旋转、多选与框选、对齐分布、层级、撤销重做、
 *      插入文本框/形状/图片/表格/线条/超链接/页码、格式面板、页面背景与切页动画、
 *      隐藏页、版式切换、演讲者备注、放映（当前页/从头/演讲者视图/排练计时）、导出。
 */
(function () {
  'use strict';

  var CFG = window.__SHEET__ || {};
  var API = CFG.api || {};
  var W = PPTScene.LOGIC_W, H = PPTScene.LOGIC_H;

  var AUTO_SAVE_MS = 3000;
  var CHANGES_POLL_MS = 4000;
  var PRESENCE_POLL_MS = 4000;
  var PRESENCE_BEAT_MS = 8000;
  var HISTORY_LIMIT = 60;
  var AVATAR_COLORS = ['#6366f1', '#059669', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#4d7c0f'];
  var PERM_NAMES = { view: '查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };
  var GRADIENTS = [
    'linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
    'linear-gradient(135deg,#f093fb 0%,#f5576c 100%)',
    'linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)',
    'linear-gradient(135deg,#43e97b 0%,#38f9d7 100%)',
    'linear-gradient(135deg,#fa709a 0%,#fee140 100%)',
    'linear-gradient(160deg,#0f2027 0%,#203a43 50%,#2c5364 100%)'
  ];

  var state = {
    version: CFG.version || 0,
    locked: Boolean(CFG.isLocked),
    publicRead: Boolean(CFG.isPublicRead),
    dirty: false,
    saving: false,
    lastSeq: 0,
    doc: null,
    idx: 0,
    sel: [],
    zoom: 1,
    tab: 'element',
    notesOpen: true,
    editing: null,
    clipboard: null,
    history: [],
    historyIndex: -1,
    drag: null,
    marquee: null
  };

  var pollTimer = null, presenceTimer = null, beatTimer = null;

  // ============ 通用工具 ============

  function $(id) { return document.getElementById(id); }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(v) {
    if (!v) return '';
    var d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(v);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function hashColor(str) {
    var h = 0, s = String(str || '');
    for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      var args = arguments, self = this;
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }
  function csrfFetch(url, options) {
    var opt = options || {};
    var headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': CFG.csrf || '' };
    if (opt.headers) Object.keys(opt.headers).forEach(function (k) { headers[k] = opt.headers[k]; });
    opt.headers = headers;
    opt.credentials = 'same-origin';
    return fetch(url, opt).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error((json && json.error) || ('请求失败（' + res.status + '）'));
          err.status = res.status; err.data = json || {};
          throw err;
        }
        return json;
      });
    });
  }
  function showToast(msg, type, ms) {
    var root = $('ssToastRoot'); if (!root) return;
    var t = document.createElement('div');
    t.className = 'ss-toast' + (type ? ' ss-toast-' + type : '');
    t.textContent = String(msg || '');
    root.appendChild(t);
    setTimeout(function () {
      t.classList.add('hiding');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, ms || 3200);
  }
  function setLoading(visible, text) {
    var mask = $('ssLoadingMask'); if (!mask) return;
    mask.hidden = !visible;
    if (visible && text) { var p = mask.querySelector('p'); if (p) p.textContent = text; }
  }
  function setSaveStatus(cls, text) {
    var el = $('ssSaveStatus'); if (!el) return;
    el.className = 'ss-save-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }
  function canEdit() { return CFG.canEdit && !state.locked; }

  // ============ 弹窗（沿用表格编辑器的样式类） ============

  function openModal(opts) {
    var backdrop = document.createElement('div');
    backdrop.className = 'ss-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ss-modal' + (opts.large ? ' ss-modal-lg' : '');
    var head = document.createElement('div');
    head.className = 'ss-modal-head';
    head.innerHTML = '<h3></h3>';
    head.firstChild.textContent = opts.title || '';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'ss-modal-close'; closeBtn.innerHTML = '&times;';
    head.appendChild(closeBtn);
    var body = document.createElement('div');
    body.className = 'ss-modal-body';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    modal.appendChild(head); modal.appendChild(body);
    var actions = document.createElement('div');
    actions.className = 'ss-modal-actions';
    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ss-btn' + (a.className ? ' ' + a.className : '');
      b.textContent = a.label;
      b.addEventListener('click', function () {
        var keep = a.onClick && a.onClick(ctx) === false;
        if (!keep && !a.keep) ctx.close();
      });
      actions.appendChild(b);
    });
    if ((opts.actions || []).length) modal.appendChild(actions);
    backdrop.appendChild(modal);
    $('ssModalRoot').appendChild(backdrop);
    var closed = false;
    var ctx = {
      root: modal, body: body,
      close: function () {
        if (closed) return; closed = true;
        if (opts.onClose) opts.onClose();
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }
    };
    closeBtn.addEventListener('click', ctx.close);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) ctx.close(); });
    return ctx;
  }

  /** 下拉菜单（功能区用） */
  function openMenu(anchor, items) {
    closeMenu();
    var pop = document.createElement('div');
    pop.className = 'ppt-menu-pop';
    pop.id = 'pptActiveMenu';
    items.forEach(function (it) {
      if (it.sep) { pop.appendChild(document.createElement('hr')); return; }
      var b = document.createElement('button');
      b.type = 'button';
      var span = document.createElement('span'); span.textContent = it.label;
      b.appendChild(span);
      if (it.key) { var em = document.createElement('em'); em.textContent = it.key; b.appendChild(em); }
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', function () { closeMenu(); if (it.onClick) it.onClick(); });
      pop.appendChild(b);
    });
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', closeMenuOnOutside);
    }, 0);
  }
  function closeMenuOnOutside(e) {
    var pop = $('pptActiveMenu');
    if (pop && !pop.contains(e.target)) closeMenu();
  }
  function closeMenu() {
    var pop = $('pptActiveMenu');
    if (pop) pop.parentNode.removeChild(pop);
    document.removeEventListener('mousedown', closeMenuOnOutside);
  }

  // ============ 文档访问 ============

  function slides() { return state.doc ? PPTScene.ordered(state.doc) : []; }
  function current() { return slides()[state.idx] || null; }

  function ensureNormalized() {
    PPTScene.normalizeDoc(state.doc);
  }

  // ============ 撤销 / 重做 ============

  function pushHistory(actionLabel) {
    if (!canEdit()) return;
    var snap = JSON.stringify(state.doc);
    if (state.history[state.historyIndex] === snap) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snap);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyIndex = state.history.length - 1;
    state._lastAction = actionLabel || '';
    updateRibbonState();
  }

  /** 变更提交：改完数据后调用（渲染 + 历史 + 脏标记） */
  function commit(label) {
    renderAll();
    pushHistory(label);
    markDirty();
  }

  function restoreSnapshot(json) {
    state.doc = JSON.parse(json);
    ensureNormalized();
    state.sel = state.sel.filter(function (id) { return findElement(id); });
    if (state.idx >= slides().length) state.idx = Math.max(0, slides().length - 1);
    renderAll();
    markDirty();
  }

  function undo() {
    if (state.historyIndex <= 0) { showToast('没有可撤销的操作'); return; }
    state.historyIndex--;
    restoreSnapshot(state.history[state.historyIndex]);
    showToast('已撤销：' + (state._lastAction || '操作'));
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) { showToast('没有可重做的操作'); return; }
    state.historyIndex++;
    restoreSnapshot(state.history[state.historyIndex]);
    showToast('已重做');
  }

  // ============ 元素查找 ============

  function findElement(id) {
    var s = current();
    if (!s || !id) return null;
    return (s.elements || []).filter(function (e) { return e.id === id; })[0] || null;
  }

  function selected() {
    var s = current();
    if (!s) return [];
    return (s.elements || []).filter(function (e) { return state.sel.indexOf(e.id) >= 0; });
  }

  /** 选中元素包围盒 */
  function selectionBox() {
    var list = selected();
    if (!list.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(function (el) {
      minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width); maxY = Math.max(maxY, el.y + el.height);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ============ 画布渲染 ============

  function renderCanvas() {
    var canvas = $('pptCanvas'); if (!canvas) return;
    var slide = current();
    canvas.classList.toggle('is-editing', canEdit());
    PPTScene.renderSlide(canvas, slide);
    if (canEdit()) applyElementCursors(canvas);
    layoutCanvas();
    paintSelection();
    $('pptSelInfo').textContent = state.sel.length
      ? ('已选中 ' + state.sel.length + ' 个元素' + (state.sel.length === 1 ? '（' + typeName(findElement(state.sel[0])) + '）' : ''))
      : (slide ? '第 ' + (state.idx + 1) + ' 页 · 点击选择元素，双击编辑文字' : '无幻灯片');
  }

  function typeName(el) {
    if (!el) return '';
    return ({ text: '文本', shape: '形状', image: '图片', table: '表格', line: '线条' })[el.type] || el.type;
  }

  function applyElementCursors(canvas) {
    canvas.querySelectorAll('.ppt-el').forEach(function (node) {
      node.style.cursor = 'move';
    });
  }

  function layoutCanvas() {
    var wrap = $('pptCanvasWrap'), canvas = $('pptCanvas');
    if (!wrap || !canvas) return;
    canvas.style.transform = 'scale(' + state.zoom + ')';
    wrap.style.width = Math.round(W * state.zoom) + 'px';
    wrap.style.height = Math.round(H * state.zoom) + 'px';
  }

  /** 选中框 + 八向缩放手柄 + 旋转手柄（手柄是选中框的子节点，因此随元素一起旋转） */
  function paintSelection() {
    var canvas = $('pptCanvas'); if (!canvas) return;
    canvas.querySelectorAll('.ppt-sel-box, .ppt-guide').forEach(function (n) { n.parentNode.removeChild(n); });
    if (!canEdit() || !state.sel.length) return;
    var inv = 1 / state.zoom;
    var hs = 9 * inv;
    selected().forEach(function (el) {
      var box = document.createElement('div');
      box.className = 'ppt-sel-box';
      box.style.cssText = 'position:absolute;left:' + el.x + 'px;top:' + el.y + 'px;width:' + el.width + 'px;height:' + el.height + 'px;'
        + 'border:' + (1.5 * inv) + 'px solid #6366f1;pointer-events:none;z-index:29;box-sizing:border-box';
      if (el.rotation) box.style.transform = 'rotate(' + el.rotation + 'deg)';
      if (state.sel.length === 1) {
        box.style.pointerEvents = '';
        [['nw', 0, 0], ['n', 50, 0], ['ne', 100, 0], ['e', 100, 50], ['se', 100, 100], ['s', 50, 100], ['sw', 0, 100], ['w', 0, 50]].forEach(function (h) {
          var node = document.createElement('div');
          node.className = 'ppt-handle ppt-handle-' + h[0];
          node.dataset.dir = h[0];
          node.style.cssText = 'left:' + h[1] + '%;top:' + h[2] + '%;width:' + hs + 'px;height:' + hs + 'px;margin:' + (-hs / 2) + 'px 0 0 ' + (-hs / 2) + 'px';
          box.appendChild(node);
        });
        var rot = document.createElement('div');
        rot.className = 'ppt-handle ppt-handle-rot';
        rot.dataset.dir = 'rot';
        rot.style.cssText = 'left:50%;top:-22px;width:' + hs + 'px;height:' + hs + 'px;margin:' + (-hs / 2) + 'px 0 0 ' + (-hs / 2) + 'px';
        box.appendChild(rot);
      }
      canvas.appendChild(box);
    });
  }

  function showGuide(kind, pos) {
    var canvas = $('pptCanvas'); if (!canvas) return;
    var g = document.createElement('div');
    g.className = 'ppt-guide ppt-guide-' + kind;
    if (kind === 'v') g.style.left = pos + 'px'; else g.style.top = pos + 'px';
    canvas.appendChild(g);
    setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 320);
  }

  // ============ 幻灯片列表 ============

  function renderPanel() {
    var list = $('pptThumbList'); if (!list) return;
    list.innerHTML = '';
    slides().forEach(function (s, i) {
      var item = document.createElement('div');
      item.className = 'ppt-thumb' + (i === state.idx ? ' is-current' : '') + (s.hidden ? ' is-hidden' : '');
      item.draggable = canEdit();
      item.dataset.idx = String(i);

      var stage = document.createElement('div');
      stage.className = 'ppt-thumb-stage';
      var mini = document.createElement('div');
      mini.className = 'ppt-canvas';
      stage.appendChild(mini);
      item.appendChild(stage);

      var no = document.createElement('span');
      no.className = 'ppt-thumb-no';
      no.textContent = String(i + 1);
      item.appendChild(no);

      var title = document.createElement('span');
      title.className = 'ppt-thumb-title';
      title.textContent = slideTitle(s);
      item.appendChild(title);

      if (canEdit()) {
        var tools = document.createElement('div');
        tools.className = 'ppt-thumb-tools';
        [['⧉', '复制本页', duplicateSlide], [s.hidden ? '◉' : '◎', s.hidden ? '取消隐藏' : '隐藏本页', toggleHideSlide], ['✕', '删除本页', deleteSlide]].forEach(function (t) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = t[0]; b.title = t[1];
          b.addEventListener('click', function (ev) { ev.stopPropagation(); t[2](i); });
          tools.appendChild(b);
        });
        item.appendChild(tools);
      }

      item.addEventListener('click', function () { selectSlide(i); });
      item.addEventListener('dblclick', function () { startShowFrom(i); });
      item.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.setData('text/plain', String(i));
        ev.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragover', function (ev) {
        ev.preventDefault(); item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', function () { item.classList.remove('drag-over'); });
      item.addEventListener('drop', function (ev) {
        ev.preventDefault(); item.classList.remove('drag-over');
        var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
        if (isFinite(from)) moveSlide(from, i);
      });
      list.appendChild(item);

      PPTScene.renderSlide(mini, s);
      requestAnimationFrame(function () { PPTScene.fit(stage, mini, false); });
    });
    var count = $('pptSlideCount');
    if (count) count.textContent = slides().length + ' 页';
  }

  function slideTitle(s) {
    if (s.title && s.title !== '新幻灯片' && s.title !== '幻灯片') return s.title;
    var first = (s.elements || []).filter(function (e) { return e.role === 'title' || e.type === 'text'; })[0];
    var text = first ? String(first.content || '').split('\n')[0] : '';
    return (text || '未命名页').slice(0, 20);
  }

  function selectSlide(i, keepSelection) {
    if (finishTextEdit() === false) return;
    state.idx = Math.max(0, Math.min(slides().length - 1, i));
    if (!keepSelection) state.sel = [];
    renderAll();
    var item = $('pptThumbList') && $('pptThumbList').children[state.idx];
    if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  }

  // ============ 页面操作 ============

  function addSlide(afterIdx, layout) {
    if (!canEdit()) return;
    var s = current();
    var slide = PPTScene.makeSlide(layout || (s ? s.layout : 'blank'), {
      background: s ? s.background : '#ffffff',
      transition: s ? JSON.parse(JSON.stringify(s.transition || {})) : { type: 'fade', duration: 400 }
    });
    var at = (afterIdx == null ? slides().length - 1 : afterIdx) + 1;
    state.doc.slides.splice(at, 0, slide);
    ensureNormalized();
    state.idx = at;
    state.sel = [];
    commit('新增幻灯片');
  }

  function duplicateSlide(i) {
    if (!canEdit()) return;
    var src = slides()[i == null ? state.idx : i];
    if (!src) return;
    var copy = JSON.parse(JSON.stringify(src));
    copy.id = PPTScene.newId('slide');
    copy.elements.forEach(function (el) { el.id = PPTScene.newId(el.type); });
    var at = (i == null ? state.idx : i) + 1;
    state.doc.slides.splice(at, 0, copy);
    ensureNormalized();
    state.idx = at;
    commit('复制幻灯片');
  }

  function deleteSlide(i) {
    if (!canEdit()) return;
    var at = i == null ? state.idx : i;
    if (slides().length <= 1) { showToast('至少保留一页幻灯片', 'warn'); return; }
    if (!confirm('删除第 ' + (at + 1) + ' 页？')) return;
    var slide = slides()[at];
    state.doc.slides = state.doc.slides.filter(function (s) { return s !== slide; });
    ensureNormalized();
    state.idx = Math.max(0, Math.min(state.idx, slides().length - 1));
    state.sel = [];
    commit('删除幻灯片');
  }

  function moveSlide(from, to) {
    if (!canEdit() || from === to) return;
    var list = slides().slice();
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    state.doc.slideOrder = list.map(function (s) { return s.id; });
    ensureNormalized();
    state.idx = to;
    commit('调整页序');
  }

  function toggleHideSlide(i) {
    if (!canEdit()) return;
    var s = slides()[i == null ? state.idx : i];
    if (!s) return;
    s.hidden = !s.hidden;
    commit(s.hidden ? '隐藏本页' : '取消隐藏');
  }

  function applyLayout(layout) {
    if (!canEdit()) return;
    var s = current(); if (!s) return;
    var fresh = PPTScene.makeSlide(layout, { background: s.background, transition: s.transition });
    var kept = (s.elements || []).filter(function (el) { return !el.role; });
    s.layout = layout;
    s.elements = fresh.elements.concat(kept);
    state.sel = [];
    commit('切换版式');
  }

  // ============ 元素操作 ============

  function insertElement(partial) {
    if (!canEdit()) return null;
    var s = current(); if (!s) return null;
    var el = Object.assign({
      id: PPTScene.newId(partial.type || 'text'),
      type: 'text', x: 180, y: 200, width: 600, height: 80, rotation: 0, opacity: 1, style: {}
    }, partial);
    if (!s.elements) s.elements = [];
    s.elements.push(el);
    state.sel = [el.id];
    commit('插入' + typeName(el));
    return el;
  }

  function insertTextBox() {
    insertElement({
      type: 'text', x: 240, y: 220, width: 480, height: 70,
      content: '点击输入文字',
      style: { fontSize: 24, textAlign: 'left', valign: 'middle', color: '#1f2937' }
    });
  }

  function insertShape(shape) {
    var fill = shape === 'line' ? 'transparent' : '#6366f1';
    insertElement({
      type: 'shape', shape: shape, x: 330, y: 190,
      width: shape === 'line' ? 300 : 300, height: shape === 'line' ? 20 : 160,
      content: shape === 'line' ? '' : '文字',
      style: { fill: fill, stroke: shape === 'line' ? '#6366f1' : '#4338ca', strokeWidth: shape === 'line' ? 3 : 2, fontSize: 18, color: '#ffffff', textAlign: 'center', valign: 'middle' }
    });
  }

  function insertTable(rows, cols) {
    var r = [], colWidths = [];
    for (var i = 0; i < rows; i++) {
      var row = [];
      for (var j = 0; j < cols; j++) row.push(i === 0 ? '标题' + (j + 1) : '');
      r.push(row);
    }
    for (var k = 0; k < cols; k++) colWidths.push(Math.round(100 / cols));
    insertElement({
      type: 'table', x: 180, y: 170, width: 600, height: rows * 40,
      rows: r, colWidths: colWidths,
      style: { fontSize: 16, headerFill: '#eef2ff', headerColor: '#1f2937', borderColor: '#cbd5e1', color: '#374151' }
    });
  }

  function insertImage(src, naturalSize) {
    var maxW = 620, maxH = 380, w = 400, h = 240;
    if (naturalSize && naturalSize.width && naturalSize.height) {
      var ratio = Math.min(maxW / naturalSize.width, maxH / naturalSize.height, 1);
      w = Math.round(naturalSize.width * ratio) || 400;
      h = Math.round(naturalSize.height * ratio) || 240;
    }
    insertElement({
      type: 'image', src: src,
      x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h,
      style: { radius: 0, border: '', borderWidth: 2, objectFit: 'contain' }
    });
  }

  function insertPageNumber() {
    var s = current(); if (!s) return;
    var pageNo = slides().indexOf(s) + 1;
    insertElement({
      type: 'text', x: 880, y: 500, width: 60, height: 26,
      content: String(pageNo),
      style: { fontSize: 14, textAlign: 'center', valign: 'middle', color: '#94a3b8' }
    });
  }

  function deleteSelected() {
    if (!canEdit() || !state.sel.length) return;
    var s = current();
    s.elements = s.elements.filter(function (el) { return state.sel.indexOf(el.id) < 0; });
    state.sel = [];
    commit('删除元素');
  }

  function duplicateSelected() {
    if (!canEdit() || !state.sel.length) return;
    var s = current();
    var copies = [];
    selected().forEach(function (el) {
      var c = JSON.parse(JSON.stringify(el));
      c.id = PPTScene.newId(el.type);
      c.x += 16; c.y += 16;
      copies.push(c);
    });
    s.elements = (s.elements || []).concat(copies);
    state.sel = copies.map(function (c) { return c.id; });
    commit('复制元素');
  }

  function copySelected() {
    if (!state.sel.length) return;
    state.clipboard = JSON.parse(JSON.stringify(selected()));
    showToast('已复制 ' + state.clipboard.length + ' 个元素');
  }

  function pasteClipboard() {
    if (!canEdit() || !(state.clipboard || []).length) return;
    var s = current();
    var copies = state.clipboard.map(function (el) {
      var c = JSON.parse(JSON.stringify(el));
      c.id = PPTScene.newId(el.type);
      c.x += 24; c.y += 24;
      return c;
    });
    s.elements = (s.elements || []).concat(copies);
    state.sel = copies.map(function (c) { return c.id; });
    commit('粘贴元素');
  }

  function zOrder(mode) {
    if (!canEdit() || state.sel.length !== 1) return;
    var s = current();
    var list = s.elements.slice();
    var idx = list.map(function (e) { return e.id; }).indexOf(state.sel[0]);
    var el = list.splice(idx, 1)[0];
    if (mode === 'front') list.push(el);
    else if (mode === 'back') list.unshift(el);
    else if (mode === 'forward') list.splice(Math.min(list.length, idx + 1), 0, el);
    else list.splice(Math.max(0, idx - 1), 0, el);
    s.elements = list;
    commit('调整层级');
  }

  function alignSelected(dir) {
    if (!canEdit() || !state.sel.length) return;
    var list = selected();
    var ref = list.length > 1 ? selectionBox() : { x: 0, y: 0, w: W, h: H };
    list.forEach(function (el) {
      if (dir === 'left') el.x = ref.x;
      else if (dir === 'hcenter') el.x = Math.round(ref.x + (ref.w - el.width) / 2);
      else if (dir === 'right') el.x = Math.round(ref.x + ref.w - el.width);
      else if (dir === 'top') el.y = ref.y;
      else if (dir === 'vcenter') el.y = Math.round(ref.y + (ref.h - el.height) / 2);
      else if (dir === 'bottom') el.y = Math.round(ref.y + ref.h - el.height);
    });
    commit('对齐');
  }

  function distributeSelected(axis) {
    if (!canEdit() || state.sel.length < 3) { showToast('至少选择 3 个元素才能等距分布', 'warn'); return; }
    var list = selected().slice().sort(function (a, b) { return (axis === 'x' ? a.x - b.x : a.y - b.y); });
    var box = selectionBox();
    var span = axis === 'x' ? box.w : box.h;
    var total = list.reduce(function (n, el) { return n + (axis === 'x' ? el.width : el.height); }, 0);
    var gap = (span - total) / (list.length - 1);
    var cursor = axis === 'x' ? box.x : box.y;
    list.forEach(function (el) {
      if (axis === 'x') {
        el.x = Math.round(cursor); cursor += el.width + gap;
      } else {
        el.y = Math.round(cursor); cursor += el.height + gap;
      }
    });
    commit('等距分布');
  }

  function nudge(dx, dy) {
    if (!canEdit() || !state.sel.length) return;
    selected().forEach(function (el) { el.x += dx; el.y += dy; });
    renderCanvas();
    scheduleCommit();
  }

  var scheduleCommit = debounce(function () { pushHistory('移动元素'); markDirty(); }, 600);

  /** 批量写入当前选区属性 */
  function applyToSelected(mutator, label) {
    if (!canEdit() || !state.sel.length) return;
    selected().forEach(mutator);
    renderCanvas();
    paintSelection();
    pushHistory(label || '修改格式');
    markDirty();
    renderProps();
  }

  function setStyle(key, value) {
    applyToSelected(function (el) {
      if (!el.style) el.style = {};
      el.style[key] = value;
    }, key);
  }

  function setProp(key, value) {
    applyToSelected(function (el) { el[key] = value; }, key);
  }

  // ============ 格式面板 ============

  function fieldRow(label, bodyNode) {
    var row = document.createElement('div');
    row.className = 'ppt-field';
    if (label) {
      var l = document.createElement('label');
      l.textContent = label;
      row.appendChild(l);
    } else {
      row.appendChild(document.createElement('span'));
    }
    var body = document.createElement('div');
    body.className = 'ppt-field-body';
    if (Array.isArray(bodyNode)) bodyNode.forEach(function (n) { body.appendChild(n); });
    else body.appendChild(bodyNode);
    row.appendChild(body);
    return row;
  }

  function section(title, rows) {
    var s = document.createElement('div');
    s.className = 'ppt-sec';
    var h = document.createElement('h4');
    h.textContent = title;
    s.appendChild(h);
    rows.forEach(function (r) { s.appendChild(r); });
    return s;
  }

  function numInput(value, onChange, min, max, step) {
    var i = document.createElement('input');
    i.type = 'number';
    i.value = String(value == null ? '' : value);
    if (min != null) i.min = String(min);
    if (max != null) i.max = String(max);
    i.step = String(step || 1);
    i.addEventListener('change', function () {
      var v = Number(i.value);
      if (!isFinite(v)) return;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      onChange(Math.round(v * 100) / 100);
    });
    return i;
  }

  function textInput(value, onChange, placeholder) {
    var i = document.createElement('input');
    i.type = 'text';
    i.value = value == null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('change', function () { onChange(i.value); });
    return i;
  }

  function colorInput(value, onChange) {
    var i = document.createElement('input');
    i.type = 'color';
    i.value = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#000000';
    i.addEventListener('input', function () { onChange(i.value); });
    return i;
  }

  function selectInput(value, options, onChange) {
    var s = document.createElement('select');
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      s.appendChild(op);
    });
    s.value = String(value == null ? (options[0] && options[0][0]) : value);
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function smallBtn(label, onClick, on) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ppt-mini' + (on ? ' is-on' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderProps() {
    var body = $('pptPropsBody'); if (!body) return;
    body.innerHTML = '';
    if (state.tab === 'slide') { renderSlideProps(body); return; }
    var list = selected();
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'ppt-prop-empty';
      empty.textContent = canEdit()
        ? '未选中元素。\n单击选择，双击改文字，拖动调整位置，右下角手柄缩放。'
        : '当前为只读模式，可在右上角申请编辑权限。';
      body.appendChild(empty);
      return;
    }
    if (list.length > 1) {
      body.appendChild(section('多选（' + list.length + ' 个元素）', [
        fieldRow('对齐', ['左', '水平居中', '右'].map(function (t, i) {
          return smallBtn(t, function () { alignSelected(['left', 'hcenter', 'right'][i]); });
        }).concat(['上', '垂直居中', '下'].map(function (t, i) {
          return smallBtn(t, function () { alignSelected(['top', 'vcenter', 'bottom'][i]); });
        }))),
        fieldRow('分布', [smallBtn('横向等距', function () { distributeSelected('x'); }), smallBtn('纵向等距', function () { distributeSelected('y'); })]),
        fieldRow('层级', [smallBtn('置顶', function () { zOrderMulti('front'); }), smallBtn('置底', function () { zOrderMulti('back'); })]),
        fieldRow('不透明度', [numInput(Math.round((list[0].opacity == null ? 1 : list[0].opacity) * 100), function (v) {
          applyToSelected(function (el) { el.opacity = v / 100; }, '不透明度');
        }, 0, 100)]),
        fieldRow('', [smallBtn('删除所选', deleteSelected)])
      ]));
      return;
    }
    var el = list[0];
    var geo = [
      fieldRow('位置', [numInput(el.x, function (v) { setProp('x', v); }, -2000), numInput(el.y, function (v) { setProp('y', v); }, -2000)]),
      fieldRow('尺寸', [numInput(el.width, function (v) { setProp('width', Math.max(8, v)); }, 8), numInput(el.height, function (v) { setProp('height', Math.max(8, v)); }, 8)]),
      fieldRow('旋转', [numInput(Math.round(el.rotation || 0), function (v) { setProp('rotation', ((v % 360) + 360) % 360); }, -360, 360)]),
      fieldRow('透明度', [numInput(Math.round((el.opacity == null ? 1 : el.opacity) * 100), function (v) { setProp('opacity', v / 100); }, 0, 100)])
    ];
    body.appendChild(section('位置与尺寸', geo));

    if (el.type === 'text' || el.type === 'shape' || el.type === 'table') {
      var textStyleRows = [
        fieldRow('字号', [numInput(el.style.fontSize, function (v) { setStyle('fontSize', Math.max(6, Math.min(200, v))); }, 6, 200)]),
        fieldRow('字体', [selectInput(el.style.fontFamily || '', [['', '默认'], ['Microsoft YaHei', '微软雅黑'], ['SimSun', '宋体'], ['SimHei', '黑体'], ['KaiTi', '楷体'], ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Consolas', '等宽 Consolas']], function (v) { setStyle('fontFamily', v || ''); })]),
        fieldRow('样式', [
          smallBtn('B', function () { setStyle('fontWeight', (el.style.fontWeight === 'bold' ? 'normal' : 'bold')); }, el.style.fontWeight === 'bold'),
          smallBtn('I', function () { setStyle('fontStyle', (el.style.fontStyle === 'italic' ? 'normal' : 'italic')); }, el.style.fontStyle === 'italic'),
          smallBtn('U', function () { setStyle('underline', !el.style.underline); }, Boolean(el.style.underline)),
          smallBtn('S', function () { setStyle('strike', !el.style.strike); }, Boolean(el.style.strike))
        ]),
        fieldRow('颜色', [colorInput(el.style.color, function (v) { setStyle('color', v); })]),
        fieldRow('对齐', ['左', '中', '右'].map(function (t, i) {
          var v = ['left', 'center', 'right'][i];
          return smallBtn(t, function () { setStyle('textAlign', v); }, (el.style.textAlign || 'left') === v);
        })),
        fieldRow('垂直', ['上', '中', '下'].map(function (t, i) {
          var v = ['top', 'middle', 'bottom'][i];
          return smallBtn(t, function () { setStyle('valign', v); }, (el.style.valign || 'top') === v);
        })),
        fieldRow('行高', [numInput(el.style.lineHeight || 1.4, function (v) { setStyle('lineHeight', v); }, 0.8, 4, 0.1)])
      ];
      body.appendChild(section('文字', textStyleRows));
    }

    if (el.type === 'shape') {
      body.appendChild(section('形状', [
        fieldRow('类型', [selectInput(el.shape, Object.keys(PPTScene.SHAPE_NAMES).map(function (k) { return [k, PPTScene.SHAPE_NAMES[k]]; }), function (v) { setProp('shape', v); })]),
        fieldRow('填充', [colorInput(el.style.fill, function (v) { setStyle('fill', v); }), smallBtn('无填充', function () { setStyle('fill', 'transparent'); })]),
        fieldRow('描边', [colorInput(el.style.stroke, function (v) { setStyle('stroke', v); }), numInput(el.style.strokeWidth, function (v) { setStyle('strokeWidth', Math.max(0, v)); }, 0, 40)]),
        el.shape === 'roundRect' ? fieldRow('圆角', [numInput(el.style.radius, function (v) { setStyle('radius', v); }, 0, 200)]) : fieldRow('', [])
      ]));
    }

    if (el.type === 'image') {
      body.appendChild(section('图片', [
        fieldRow('圆角', [numInput(el.style.radius, function (v) { setStyle('radius', v); }, 0, 200)]),
        fieldRow('填充', [smallBtn(el.style.objectFit === 'cover' ? '裁剪铺满' : '完整显示', function () {
          setStyle('objectFit', el.style.objectFit === 'cover' ? 'contain' : 'cover');
        })]),
        fieldRow('边框', [colorInput(el.style.border || '#000000', function (v) { setStyle('border', v); }), numInput(el.style.borderWidth, function (v) { setStyle('borderWidth', v); }, 0, 20)]),
        fieldRow('', [smallBtn('替换图片', function () { pickImage(function (src, size) { applyToSelected(function (t) { t.src = src; if (size) { t.width = size.w; t.height = size.h; } }, '替换图片'); }); })])
      ]));
    }

    if (el.type === 'table') {
      body.appendChild(section('表格', [
        fieldRow('行/列', [
          smallBtn('＋行', function () { mutateTable(function (t) { t.rows.push(t.rows[0].map(function () { return ''; })); }); }),
          smallBtn('－行', function () { mutateTable(function (t) { if (t.rows.length > 1) t.rows.pop(); }); }),
          smallBtn('＋列', function () { mutateTable(function (t) { t.rows.forEach(function (r) { r.push(''); }); t.colWidths.push(100 / t.rows[0].length); }); }),
          smallBtn('－列', function () { mutateTable(function (t) { if (t.rows[0].length > 1) { t.rows.forEach(function (r) { r.pop(); }); t.colWidths.pop(); } }); })
        ]),
        fieldRow('表头底色', [colorInput(el.style.headerFill, function (v) { setStyle('headerFill', v); })]),
        fieldRow('边框色', [colorInput(el.style.borderColor, function (v) { setStyle('borderColor', v); })]),
        fieldRow('', [smallBtn('编辑单元格内容', openTableEditor)])
      ]));
    }

    body.appendChild(section('交互', [
      fieldRow('超链接', [textInput(el.link || '', function (v) { setProp('link', v.trim()); }, 'https://…')]),
      fieldRow('', [smallBtn('清除链接', function () { setProp('link', ''); })]),
      fieldRow('层级', [
        smallBtn('上移', function () { zOrder('forward'); }),
        smallBtn('下移', function () { zOrder('backward'); }),
        smallBtn('置顶', function () { zOrder('front'); }),
        smallBtn('置底', function () { zOrder('back'); })
      ]),
      fieldRow('', [smallBtn('复制', duplicateSelected), smallBtn('删除', deleteSelected)])
    ]));
  }

  function zOrderMulti(mode) {
    if (!canEdit()) return;
    var s = current();
    var picked = (s.elements || []).filter(function (e) { return state.sel.indexOf(e.id) >= 0; });
    var rest = (s.elements || []).filter(function (e) { return state.sel.indexOf(e.id) < 0; });
    s.elements = mode === 'front' ? rest.concat(picked) : picked.concat(rest);
    commit('调整层级');
  }

  function mutateTable(fn) {
    var el = findElement(state.sel[0]);
    if (!el || el.type !== 'table') return;
    fn(el);
    el.height = Math.max(40, el.rows.length * 40);
    el.colWidths = el.colWidths.map(function () { return Math.round(100 / el.rows[0].length); });
    commit('修改表格');
  }

  function openTableEditor() {
    var el = findElement(state.sel[0]);
    if (!el || el.type !== 'table') return;
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;gap:4px;grid-template-columns:repeat(' + el.rows[0].length + ',1fr)';
    el.rows.forEach(function (row) {
      row.forEach(function (cell, ci) {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.value = cell == null ? '' : String(cell);
        inp.style.cssText = 'padding:5px 7px;border:1px solid #dbe2ea;border-radius:6px;font-size:12.5px';
        inp.addEventListener('change', function () {
          var copy = JSON.parse(JSON.stringify(el.rows));
          copy[el.rows.indexOf(row)][ci] = inp.value;
          applyToSelected(function (t) { t.rows = copy; }, '编辑表格');
        });
        grid.appendChild(inp);
      });
    });
    openModal({ title: '编辑表格内容', large: true, body: grid });
  }

  function renderSlideProps(body) {
    var s = current();
    if (!s) { body.appendChild(emptyTip('没有幻灯片')); return; }
    var rows = [
      fieldRow('版式', [selectInput(s.layout, Object.keys(PPTScene.LAYOUTS).map(function (k) { return [k, PPTScene.LAYOUTS[k].name]; }), function (v) { applyLayout(v); })]),
      fieldRow('背景色', [colorInput(s.background, function (v) { s.background = v; commit('页面背景'); })]),
      fieldRow('渐变', GRADIENTS.map(function (g, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'ppt-swatch'; b.title = '渐变 ' + (i + 1);
        b.style.background = g;
        b.addEventListener('click', function () { s.background = g; s.backgroundImage = ''; commit('渐变背景'); });
        return b;
      }).concat([smallBtn('清除渐变', function () { s.background = '#ffffff'; s.backgroundImage = ''; commit('清除背景'); })])),
      fieldRow('背景图', [smallBtn('选择图片', function () {
        pickImage(function (src) { s.backgroundImage = src; commit('背景图'); });
      }), smallBtn('清除', function () { s.backgroundImage = ''; commit('清除背景图'); })]),
      fieldRow('切页动画', [selectInput((s.transition && s.transition.type) || 'none', Object.keys(PPTScene.TRANSITIONS).map(function (k) { return [k, PPTScene.TRANSITIONS[k]]; }), function (v) {
        s.transition = s.transition || {};
        s.transition.type = v;
        commit('切页动画');
      })]),
      fieldRow('动画时长', [numInput((s.transition && s.transition.duration) || 400, function (v) {
        s.transition = s.transition || {};
        s.transition.duration = Math.max(0, Math.min(3000, v));
        commit('动画时长');
      }, 0, 3000, 100)]),
      fieldRow('', [smallBtn('应用到全部页', function () {
        var t = { type: (s.transition && s.transition.type) || 'none', duration: (s.transition && s.transition.duration) || 400 };
        slides().forEach(function (x) { x.transition = JSON.parse(JSON.stringify(t)); });
        commit('统一切页动画');
        showToast('已应用到 ' + slides().length + ' 页', 'success');
      })]),
      fieldRow('隐藏本页', [smallBtn(s.hidden ? '已隐藏（放映跳过）' : '本页参与放映', function () { toggleHideSlide(); }, Boolean(s.hidden))]),
      fieldRow('排练时长', [s.timings && s.timings.ms ? document.createTextNode((Math.round(s.timings.ms / 100) / 10) + ' 秒') : emptyText('尚未排练'),
        s.timings && s.timings.ms ? smallBtn('清除', function () { s.timings = null; commit('清除排练时长'); }) : null].filter(Boolean)),
      fieldRow('页码标题', [textInput(slideTitle(s), function (v) { s.title = v.slice(0, 40); commit('页标题'); }, '用于列表显示')])
    ];
    body.appendChild(section('本页（第 ' + (state.idx + 1) + ' 页 / 共 ' + slides().length + ' 页）', rows));
    body.appendChild(section('新建幻灯片', [
      fieldRow('', Object.keys(PPTScene.LAYOUTS).slice(1).map(function (k) {
        return smallBtn(PPTScene.LAYOUTS[k].name, function () {
          var s2 = PPTScene.makeSlide(k, { background: current().background });
          state.doc.slides.splice(state.idx + 1, 0, s2);
          ensureNormalized();
          state.idx = state.idx + 1;
          commit('新增' + PPTScene.LAYOUTS[k].name + '页');
        });
      }))
    ]));
  }

  function emptyText(t) {
    var s = document.createElement('span');
    s.textContent = t;
    s.style.color = '#94a3b8';
    return s;
  }

  function emptyTip(t) {
    var d = document.createElement('div');
    d.className = 'ppt-prop-empty';
    d.textContent = t;
    return d;
  }

  /** 选择本地图片并上传，成功后回调 (url, size) */
  function pickImage(cb) {
    var input = $('pptImageInput');
    if (!input) { showToast('图片上传控件缺失', 'error'); return; }
    input.onchange = function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      uploadImage(file, function (data) { cb(data.url, { w: data.width, h: data.height }); });
    };
    input.click();
  }

  /** 上传图片（幻灯片配图/背景图共用），成功后回调 data.url */
  function uploadImage(file, onDone) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { showToast('请选择图片文件', 'warn'); return; }
    if (file.size > 8 * 1024 * 1024) { showToast('图片超过 8MB，请先压缩', 'warn'); return; }
    var fd = new FormData();
    fd.append('file', file);
    var btn = $('btnPptInsertImage');
    if (btn) btn.disabled = true;
    fetch(API.media, {
      method: 'POST',
      headers: { 'X-CSRF-Token': CFG.csrf || '' },
      credentials: 'same-origin',
      body: fd
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok || !json.success) throw new Error(json.error || ('上传失败（' + res.status + '）'));
        return json.data;
      });
    }).then(function (data) {
      onDone(data);
    }).catch(function (err) {
      showToast(err.message || '图片上传失败', 'error');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  // ============ 功能区 ============

  var RIBBON = [
    { group: '历史', items: [
      { label: '↶ 撤销', key: 'Ctrl+Z', onClick: undo, id: 'btnUndo' },
      { label: '↷ 重做', key: 'Ctrl+Y', onClick: redo, id: 'btnRedo' }
    ] },
    { group: '插入', items: [
      { label: 'T 文本框', onClick: insertTextBox },
      { label: '▢ 形状', menu: function (anchor) {
        openMenu(anchor, Object.keys(PPTScene.SHAPE_NAMES).map(function (k) {
          return { label: PPTScene.SHAPE_NAMES[k], onClick: function () { insertShape(k); } };
        }));
      } },
      { label: '▦ 表格', menu: function (anchor) {
        var items = [];
        [3, 4, 5, 6].forEach(function (r) {
          [3, 4, 5, 6].forEach(function (c) {
            if (c > 5 && r > 4) return;
            items.push({ label: r + ' 行 × ' + c + ' 列', onClick: function () { insertTable(r, c); } });
          });
        });
        openMenu(anchor, items);
      } },
      { label: '🖼 图片', onClick: function () { pickImage(function (src, size) { insertImage(src, { width: size && size.w, height: size && size.h }); }); }, id: 'btnPptInsertImage' },
      { label: '— 线条', onClick: function () { insertShape('line'); } },
      { label: '# 页码', onClick: insertPageNumber }
    ] },
    { group: '页面', items: [
      { label: '＋ 新建页', onClick: function () { addSlide(); } },
      { label: '⧉ 复制页', onClick: function () { duplicateSlide(); } },
      { label: '✕ 删除页', onClick: function () { deleteSlide(); } },
      { label: '◧ 版式', menu: function (anchor) {
        openMenu(anchor, Object.keys(PPTScene.LAYOUTS).map(function (k) {
          return { label: PPTScene.LAYOUTS[k].name, onClick: function () { applyLayout(k); } };
        }));
      } },
      { label: '◎ 隐藏页', onClick: function () { toggleHideSlide(); } }
    ] },
    { group: '排列', items: [
      { label: '⬅ 左', onClick: function () { alignSelected('left'); } },
      { label: '⬌ 居中', onClick: function () { alignSelected('hcenter'); } },
      { label: '➡ 右', onClick: function () { alignSelected('right'); } },
      { label: '⬆ 上', onClick: function () { alignSelected('top'); } },
      { label: '⬍ 垂直', onClick: function () { alignSelected('vcenter'); } },
      { label: '⬇ 下', onClick: function () { alignSelected('bottom'); } }
    ] },
    { group: '剪贴', items: [
      { label: '⧉ 复制', key: 'Ctrl+D', onClick: duplicateSelected },
      { label: '🗑 删除', key: 'Del', onClick: deleteSelected }
    ] },
    { group: '放映', items: [
      { label: '▶ 从当前页', key: 'F5', onClick: function () { startShowFrom(state.idx); } },
      { label: '▶ 从头放映', onClick: function () { startShowFrom(0); } },
      { label: '🗣 演讲者视图', key: 'Shift+F5', onClick: function () { startShowFrom(state.idx, { presenter: true }); } },
      { label: '🎗 排练计时', onClick: function () { startShowFrom(0, { rehearse: true }); } }
    ] }
  ];

  function buildRibbon() {
    var ribbon = $('pptRibbon'); if (!ribbon) return;
    ribbon.innerHTML = '';
    RIBBON.forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'ppt-group';
      g.items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ppt-rbtn';
        b.textContent = it.label;
        if (it.id) b.id = it.id;
        if (it.title) b.title = it.title;
        b.addEventListener('click', function () {
          if (it.menu) it.menu(b);
          else if (it.onClick) it.onClick();
        });
        box.appendChild(b);
      });
      ribbon.appendChild(box);
    });
    var tail = document.createElement('div');
    tail.className = 'ppt-group';
    var zoomHint = document.createElement('span');
    zoomHint.style.cssText = 'font-size:12px;color:#94a3b8';
    zoomHint.textContent = '提示：双击文字直接改，拖动手柄改尺寸，Del 删除';
    tail.appendChild(zoomHint);
    ribbon.appendChild(tail);
    if (!canEdit()) {
      ribbon.querySelectorAll('button').forEach(function (b) {
        if (!/放映|演讲者|排练/.test(b.textContent)) b.disabled = true;
      });
    }
    if (state.locked) {
      ribbon.querySelectorAll('button').forEach(function (b) {
        if (!/放映|演讲者|排练/.test(b.textContent)) b.disabled = true;
      });
    }
  }

  function updateRibbonState() {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !canEdit() || state.historyIndex <= 0;
    if (r) r.disabled = !canEdit() || state.historyIndex >= state.history.length - 1;
  }

  // ============ 画布交互 ============

  function elementAt(ev) {
    var node = ev.target.closest ? ev.target.closest('.ppt-el') : null;
    if (!node) return null;
    return findElement(node.dataset.elId);
  }

  function bindCanvasEvents() {
    var canvas = $('pptCanvas'), scroll = $('pptCanvasScroll');
    if (!canvas) return;

    canvas.addEventListener('mousedown', function (ev) {
      if (!canEdit() || ev.button !== 0) return;
      if (state.editing) return; // contenteditable 内部操作
      var handle = ev.target.closest ? ev.target.closest('.ppt-handle') : null;
      if (handle) { startTransform(ev, handle.dataset.dir); return; }
      var el = elementAt(ev);
      if (el) {
        if (ev.shiftKey) {
          var at = state.sel.indexOf(el.id);
          if (at >= 0) state.sel.splice(at, 1); else state.sel.push(el.id);
        } else if (state.sel.indexOf(el.id) < 0) {
          state.sel = [el.id];
        }
        renderCanvas(); renderProps();
        startDrag(ev);
        ev.preventDefault();
        return;
      }
      if (state.sel.length) { state.sel = []; renderCanvas(); renderProps(); }
      startMarquee(ev);
    });

    canvas.addEventListener('dblclick', function (ev) {
      if (!canEdit()) return;
      var el = elementAt(ev);
      if (!el) {
        // 双击空白 → 在该处新建文本框
        var p = PPTScene.toCanvasPoint(canvas, ev.clientX, ev.clientY);
        insertElement({
          type: 'text', x: Math.round(p.x), y: Math.round(p.y), width: 320, height: 56,
          content: '', style: { fontSize: 20, color: '#1f2937', valign: 'top' }
        });
        setTimeout(function () { startTextEdit(findElement(state.sel[0])); }, 30);
        return;
      }
      if (el.type === 'text' || el.type === 'shape') startTextEdit(el);
      if (el.type === 'table') openTableEditor();
    });

    if (scroll) {
      scroll.addEventListener('wheel', function (ev) {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        setZoom(state.zoom + (ev.deltaY < 0 ? 0.1 : -0.1));
      }, { passive: false });
    }
  }

  function startDrag(ev) {
    var canvas = $('pptCanvas');
    var start = PPTScene.toCanvasPoint(canvas, ev.clientX, ev.clientY);
    var origins = selected().map(function (e) { return { id: e.id, x: e.x, y: e.y }; });
    var moved = false;
    function move(mv) {
      var p = PPTScene.toCanvasPoint(canvas, mv.clientX, mv.clientY);
      var dx = p.x - start.x, dy = p.y - start.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
      if (mv.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      origins.forEach(function (o) {
        var target = findElement(o.id);
        if (!target) return;
        target.x = Math.round(o.x + dx);
        target.y = Math.round(o.y + dy);
        if (origins.length === 1) snapToGuides(target);
      });
      renderCanvas();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (moved) { pushHistory('移动元素'); markDirty(); }
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    ev.preventDefault();
  }

  /** 吸附到画布中线（Office 的对齐参考线） */
  function snapToGuides(el) {
    var thr = 6 / state.zoom;
    var cx = el.x + el.width / 2, cy = el.y + el.height / 2;
    if (Math.abs(cx - W / 2) < thr) { el.x = Math.round(W / 2 - el.width / 2); showGuide('v', W / 2); }
    if (Math.abs(cy - H / 2) < thr) { el.y = Math.round(H / 2 - el.height / 2); showGuide('h', H / 2); }
  }

  function startTransform(ev, dir) {
    var canvas = $('pptCanvas');
    var el = findElement(state.sel[0]);
    if (!el) return;
    if (dir === 'rot') { startRotate(ev, el); return; }
    var start = PPTScene.toCanvasPoint(canvas, ev.clientX, ev.clientY);
    var o = { x: el.x, y: el.y, w: el.width, h: el.height };
    var rad = -(el.rotation || 0) * Math.PI / 180;
    function move(mv) {
      var p = PPTScene.toCanvasPoint(canvas, mv.clientX, mv.clientY);
      var gx = p.x - start.x, gy = p.y - start.y;
      // 旋转过的元素按自身坐标轴缩放：把屏幕位移反旋转到元素局部坐标系
      var dx = gx * Math.cos(rad) - gy * Math.sin(rad);
      var dy = gx * Math.sin(rad) + gy * Math.cos(rad);
      var next = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (dir.indexOf('w') >= 0) { next.x = o.x + dx; next.w = o.w - dx; }
      if (dir.indexOf('e') >= 0) { next.w = o.w + dx; }
      if (dir.indexOf('n') >= 0) { next.y = o.y + dy; next.h = o.h - dy; }
      if (dir.indexOf('s') >= 0) { next.h = o.h + dy; }
      if (mv.shiftKey && o.w > 0 && o.h > 0 && dir.length === 2) {
        var ratio = o.w / o.h;
        if (Math.abs(dx) > Math.abs(dy)) next.h = next.w / ratio; else next.w = next.h * ratio;
      }
      el.x = Math.round(next.x);
      el.y = Math.round(next.y);
      el.width = Math.max(8, Math.round(next.w));
      el.height = Math.max(8, Math.round(next.h));
      renderCanvas();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      pushHistory('调整尺寸'); markDirty(); renderProps();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    ev.preventDefault();
  }

  function startRotate(ev, el) {
    var canvas = $('pptCanvas');
    var rect = canvas.getBoundingClientRect();
    var scale = rect.width / W;
    var cx = rect.left + (el.x + el.width / 2) * scale;
    var cy = rect.top + (el.y + el.height / 2) * scale;
    var base = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI - (el.rotation || 0);
    function move(mv) {
      var a = Math.atan2(mv.clientY - cy, mv.clientX - cx) * 180 / Math.PI - base;
      if (mv.shiftKey) a = Math.round(a / 15) * 15;
      el.rotation = Math.round(((a % 360) + 360) % 360);
      renderCanvas();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      pushHistory('旋转'); markDirty(); renderProps();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    ev.preventDefault();
  }

  function startMarquee(ev) {
    var wrap = $('pptCanvasWrap'), box = $('pptMarquee');
    if (!wrap || !box) return;
    var start = { x: ev.clientX, y: ev.clientY };
    var lastKey = '';
    box.hidden = false;
    function move(mv) {
      var wr = wrap.getBoundingClientRect();
      var p1x = start.x - wr.left, p1y = start.y - wr.top;
      var p2x = mv.clientX - wr.left, p2y = mv.clientY - wr.top;
      box.style.left = Math.min(p1x, p2x) + 'px';
      box.style.top = Math.min(p1y, p2y) + 'px';
      box.style.width = Math.abs(p2x - p1x) + 'px';
      box.style.height = Math.abs(p2y - p1y) + 'px';
      // 框选矩形是屏幕像素，元素坐标是画布逻辑坐标，需要除以缩放比换算
      var z = state.zoom || 1;
      var l = Math.min(p1x, p2x) / z, t = Math.min(p1y, p2y) / z;
      var r = Math.max(p1x, p2x) / z, b = Math.max(p1y, p2y) / z;
      var picked = ((current() || {}).elements || []).filter(function (el) {
        return el.x < r && (el.x + el.width) > l && el.y < b && (el.y + el.height) > t;
      }).map(function (el) { return el.id; });
      var key = picked.join(',');
      if (key === lastKey) return;
      lastKey = key;
      state.sel = picked;
      renderCanvas();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      box.hidden = true;
      renderProps();
      if (state.sel.length > 1) showToast('选中 ' + state.sel.length + ' 个元素');
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    ev.preventDefault();
  }

  // ============ 文字就地编辑 ============

  function startTextEdit(el) {
    if (!canEdit() || !el || (el.type !== 'text' && el.type !== 'shape')) return;
    var canvas = $('pptCanvas');
    var node = canvas.querySelector('[data-el-id="' + el.id + '"] .ppt-text-inner')
      || canvas.querySelector('[data-el-id="' + el.id + '"] .ppt-shape-text');
    if (!node) return;
    state.editing = { id: el.id };
    node.setAttribute('contenteditable', 'true');
    node.style.outline = '1.5px solid #ec4899';
    node.focus();
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.addEventListener('blur', function () { finishTextEdit(); }, { once: true });
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); node.blur(); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); node.blur(); }
      ev.stopPropagation();
    });
  }

  /** @returns {boolean} false 表示用户取消了编辑（调用方应中断后续动作） */
  function finishTextEdit() {
    if (!state.editing) return true;
    var canvas = $('pptCanvas');
    var id = state.editing.id;
    state.editing = null;
    var node = canvas.querySelector('[data-el-id="' + id + '"] [contenteditable="true"]');
    if (!node) return true;
    var text = node.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '');
    node.setAttribute('contenteditable', 'false');
    node.style.outline = '';
    var el = findElement(id);
    if (!el) return true;
    if (el.type === 'text' && !String(text).trim()) text = el.content || '';
    if (String(el.content || '') !== text) {
      el.content = text;
      if (el.role === 'title') { var s = current(); if (s) s.title = String(text).split('\n')[0].slice(0, 40); }
      renderCanvas();
      pushHistory('编辑文字');
      markDirty();
    }
    renderPanel();
    return true;
  }

  // ============ 缩放 ============

  function setZoom(z) {
    state.zoom = Math.max(0.3, Math.min(2.4, Math.round(z * 100) / 100));
    layoutCanvas();
    paintSelection();
    var range = $('pptZoomRange'), label = $('pptZoomLabel');
    if (range) range.value = String(Math.round(state.zoom * 100));
    if (label) label.textContent = Math.round(state.zoom * 100) + '%';
  }

  function fitZoom() {
    var scroll = $('pptCanvasScroll');
    if (!scroll) return;
    var availW = scroll.clientWidth - 60, availH = scroll.clientHeight - 60;
    setZoom(Math.min(availW / W, availH / H, 2));
  }

  // ============ 放映 ============

  function startShowFrom(i, opts) {
    if (typeof PPTShow === 'undefined') { showToast('放映模块未加载', 'error'); return; }
    finishTextEdit();
    if (state.dirty) saveNow(false);
    var o = opts || {};
    PPTShow.start({
      doc: state.doc,
      index: i == null ? state.idx : i,
      title: CFG.name,
      presenter: Boolean(o.presenter),
      rehearse: Boolean(o.rehearse),
      settings: { mode: 'manual' },
      onEvent: function (name, payload) {
        if (name === 'slidechange' && payload && payload.slide) {
          var at = slides().indexOf(payload.slide);
          if (at >= 0 && at !== state.idx) {
            state.idx = at;
            renderPanel(); renderCanvas(); renderNotes(); renderProps();
          }
        }
        if (name === 'timings' && payload && payload.timings) applyTimings(payload.timings);
      }
    });
  }

  /** 排练时长写回文档（随自动保存落库，下次放映可直接自动播放） */
  function applyTimings(timings) {
    var changed = 0;
    Object.keys(timings).forEach(function (id) {
      var s = slides().filter(function (x) { return x.id === id; })[0];
      if (!s) return;
      s.timings = { ms: timings[id], rehearsedAt: Date.now() };
      changed++;
    });
    if (changed) {
      commit('排练计时');
      showToast('已记录 ' + changed + ' 页的排练时长', 'success');
    }
  }

  // ============ 加载与保存 ============

  function loadDoc() {
    return csrfFetch(API.doc).then(function (json) {
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      state.doc = data.doc || { slides: [], slideOrder: [] };
      ensureNormalized();
      state.history = [JSON.stringify(state.doc)];
      state.historyIndex = 0;
      setLoading(false);
      setSaveStatus('is-saved', '已加载 v' + state.version);
      buildRibbon();
      renderAll();
      fitZoom();
      startPolling();
      if (!canEdit()) document.body.classList.add('is-readonly');
    }).catch(function (err) {
      setLoading(false);
      setSaveStatus('is-error', '加载失败');
      showToast(err.message || '文档加载失败', 'error');
    });
  }

  function renderAll() {
    renderPanel();
    renderCanvas();
    renderProps();
    renderNotes();
    updateRibbonState();
  }

  function renderNotes() {
    var box = $('pptNotes'), s = current();
    if (!box) return;
    if (document.activeElement === box) return; // 正在输入时不覆盖
    box.value = s ? (s.notes || '') : '';
    box.disabled = !canEdit();
    var noteBox = $('pptNotesBox');
    if (noteBox) noteBox.hidden = !state.notesOpen;
  }

  function markDirty() {
    if (!canEdit()) return;
    state.dirty = true;
    setSaveStatus('is-dirty', '有未保存更改');
    scheduleSave();
  }

  var scheduleSave = debounce(function () { saveNow(false); }, AUTO_SAVE_MS);

  function saveNow(manual) {
    if (state.saving || !state.dirty || !canEdit() || state.locked || !state.doc) return;
    state.saving = true;
    setSaveStatus('is-saving', '保存中…');
    csrfFetch(API.doc, {
      method: 'PUT',
      body: JSON.stringify({
        doc: state.doc,
        baseVersion: state.version,
        structural: true,
        changeDesc: manual ? '手动保存' : '自动保存'
      })
    }).then(function (json) {
      state.saving = false; state.dirty = false;
      var data = json.data || {};
      if (data.version) state.version = data.version;
      setSaveStatus('is-saved', '已保存 v' + state.version);
      if (manual) showToast('保存成功', 'success');
    }).catch(function (err) {
      state.saving = false;
      setSaveStatus('is-error', '保存失败');
      showToast(err.message || '保存失败（可能存在他人并发编辑，请刷新页面）', 'error');
    });
  }

  // ============ 协同轮询 ============

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollChanges, CHANGES_POLL_MS);
    presenceTimer = setInterval(pollPresence, PRESENCE_POLL_MS);
    beatTimer = setInterval(beatPresence, PRESENCE_BEAT_MS);
    pollChanges(); pollPresence(); beatPresence();
  }

  /** 页签切到后台时停止轮询（2核小服务器减少无效请求），回到前台再恢复 */
  function stopPolling() {
    clearInterval(pollTimer);
    clearInterval(presenceTimer);
    clearInterval(beatTimer);
    pollTimer = null;
    presenceTimer = null;
    beatTimer = null;
  }

  function pollChanges() {
    csrfFetch(API.changes + '?since=' + (state.lastSeq || 0))
      .then(function (json) {
        var changes = (json.data && json.data.changes) || [];
        changes.forEach(function (ch) {
          if (ch.seq <= state.lastSeq) return;
          state.lastSeq = ch.seq;
          if (ch.kind === 'doc-reload' && !state.dirty && !state.editing) {
            csrfFetch(API.doc).then(function (j) {
              var d = j.data || {};
              state.version = d.version || 0;
              state.doc = d.doc || state.doc;
              ensureNormalized();
              renderAll();
              setSaveStatus('is-saved', '已同步 v' + state.version);
            }).catch(function () {});
          }
        });
      }).catch(function () {});
  }

  function pollPresence() {
    csrfFetch(API.presence).then(function (json) {
      renderPresenceBar((json.data && json.data.users) || []);
    }).catch(function () {});
  }

  function beatPresence() {
    csrfFetch(API.presence, { method: 'POST', body: JSON.stringify({ mode: canEdit() ? 'edit' : 'view' }) }).catch(function () {});
  }

  function renderPresenceBar(users) {
    var bar = $('ssPresenceBar'); if (!bar) return;
    bar.innerHTML = '';
    if (!Array.isArray(users) || users.length === 0) return;
    users.slice(0, 8).forEach(function (u) {
      var node = document.createElement('span');
      node.className = 'ss-presence-avatar';
      node.style.background = hashColor(u.username);
      node.textContent = (u.username || '?').charAt(0).toUpperCase();
      node.title = u.username + ' · ' + (u.mode === 'edit' ? '编辑中' : '在线');
      bar.appendChild(node);
    });
    if (users.length > 8) {
      var more = document.createElement('span');
      more.className = 'ss-presence-avatar';
      more.style.background = '#94a3b8';
      more.textContent = '+' + (users.length - 8);
      bar.appendChild(more);
    }
  }

  // ============ 版本 / 分享 / 权限（与文档编辑器同一套接口） ============

  function openVersionModal() {
    csrfFetch(API.versions).then(function (json) {
      var versions = (json.data && json.data.versions) || [];
      var bodyHtml = canEdit() ? '<div style="margin-bottom:12px"><button class="ss-btn ss-btn-primary" id="btnCreateVersion">📸 创建当前版本快照</button></div>' : '';
      if (!versions.length) {
        bodyHtml += '<div class="ss-comment-empty">暂无历史版本</div>';
      } else {
        bodyHtml += versions.map(function (v) {
          var isCurrent = v.version === state.version;
          return '<div class="ss-version-item' + (isCurrent ? ' is-current' : '') + '">'
            + '<div class="ss-version-info"><div class="ver">v' + v.version + (isCurrent ? ' （当前）' : '') + '</div>'
            + '<div class="desc">' + escapeHtml(v.change_desc || '') + '</div>'
            + '<div class="meta">' + escapeHtml(v.username || '') + ' · ' + fmtTime(v.created_at) + ' · ' + Math.round((v.size_bytes || 0) / 1024) + ' KB</div></div>'
            + '<div>' + (!isCurrent ? '<button class="ss-btn" data-preview-ver="' + v.version + '">预览</button>' : '')
            + (canEdit() && !isCurrent ? '<button class="ss-btn" data-restore-ver="' + v.version + '">恢复</button>' : '') + '</div></div>';
        }).join('');
      }
      var modal = openModal({ title: '🕘 历史版本', large: true, body: bodyHtml });
      var createBtn = modal.body.querySelector('#btnCreateVersion');
      if (createBtn) createBtn.addEventListener('click', function () {
        csrfFetch(API.versions, { method: 'POST', body: JSON.stringify({ changeDesc: '手动创建版本快照' }) })
          .then(function () { showToast('版本快照已创建', 'success'); modal.close(); })
          .catch(function (err) { showToast(err.message || '创建失败', 'error'); });
      });
      modal.body.querySelectorAll('[data-preview-ver]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          csrfFetch(API.versions + '/' + btn.dataset.previewVer).then(function (j) {
            if (!j.data || !j.data.doc) { showToast('版本内容为空', 'error'); return; }
            PPTShow.start({
              doc: j.data.doc, index: 0, title: CFG.name + '（v' + j.data.version + ' 预览）',
              onEvent: function () {}
            });
          }).catch(function (err) { showToast(err.message || '预览失败', 'error'); });
        });
      });
      modal.body.querySelectorAll('[data-restore-ver]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('确定恢复到版本 v' + btn.dataset.restoreVer + '？当前未保存内容会被覆盖。')) return;
          csrfFetch(API.versions + '/' + btn.dataset.restoreVer + '/restore', { method: 'POST' })
            .then(function () { showToast('已恢复', 'success'); modal.close(); loadDoc(); })
            .catch(function (err) { showToast(err.message || '恢复失败', 'error'); });
        });
      });
    }).catch(function (err) { showToast(err.message || '加载版本失败', 'error'); });
  }

  function openShareModal() {
    var modal = openModal({ title: '🔗 分享演示文稿', body: '<div class="ss-inline-loading">加载分享状态…</div>' });
    csrfFetch(API.share).then(function (json) {
      renderShareModal(modal, json.data || {});
    }).catch(function (err) {
      modal.body.innerHTML = '<p class="ss-inline-error">' + escapeHtml(err.message || '加载分享状态失败') + '</p>';
    });
  }

  function renderShareModal(modal, d) {
    var bodyHtml;
    if (d.shared && d.token) {
      var link = location.origin + (d.url || '/share/' + d.token);
      var embedUrl = location.origin + (d.embedUrl || ('/share/' + d.token + '/embed'));
      var embedCode = '<iframe src="' + embedUrl + '" width="100%" height="600" frameborder="0" style="border:1px solid #e0e4ea;border-radius:12px;" loading="lazy" allowfullscreen></iframe>';
      bodyHtml = (d.status !== 1 ? '<p class="ss-inline-error">分享当前处于停用状态。</p>' : '')
        + '<div class="ss-share-stats"><b>浏览 ' + (d.viewCount || 0) + '</b>'
        + (d.createdAt ? '<span>创建于 ' + escapeHtml(fmtTime(d.createdAt)) + '</span>' : '') + '</div>'
        + '<div class="ss-field"><label>分享链接</label><div class="ss-share-link-row">'
        + '<input type="text" class="ss-input" readonly value="' + escapeHtml(link) + '" id="shareLinkInput">'
        + '<button type="button" class="ss-btn" id="btnCopyShare">复制</button>'
        + '<button type="button" class="ss-btn" id="btnOpenShare">打开</button></div></div>'
        + '<div class="ss-field"><label>嵌入代码（iframe）</label>'
        + '<textarea class="ss-input" rows="2" readonly id="shareEmbedCode">' + escapeHtml(embedCode) + '</textarea></div>'
        + '<p class="ss-hint">获得链接的人无需登录即可在线放映（含键盘翻页与全屏），分享页不提供下载。</p>'
        + '<button type="button" class="ss-btn ss-btn-danger" id="btnCancelShare">停止分享</button>';
    } else {
      bodyHtml = '<p class="ss-hint">尚未开启分享，开启后所有获得链接的人可在线放映此演示文稿。</p>'
        + '<button type="button" class="ss-btn ss-btn-primary" id="btnEnableShare">开启分享</button>';
    }
    modal.body.innerHTML = bodyHtml;

    if (d.shared && d.token) {
      var link2 = modal.body.querySelector('#shareLinkInput').value;
      modal.body.querySelector('#btnCopyShare').addEventListener('click', function () {
        copyText(link2).then(function (ok) { showToast(ok ? '链接已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error'); });
      });
      modal.body.querySelector('#btnOpenShare').addEventListener('click', function () {
        window.open(link2, '_blank', 'noopener');
      });
      modal.body.querySelector('#btnCancelShare').addEventListener('click', function () {
        csrfFetch(API.share, { method: 'DELETE' }).then(function () {
          showToast('分享已停止', 'success');
          renderShareModal(modal, { shared: false });
        }).catch(function (err) { showToast(err.message || '操作失败', 'error'); });
      });
    } else {
      var enableBtn = modal.body.querySelector('#btnEnableShare');
      enableBtn.addEventListener('click', function () {
        enableBtn.disabled = true;
        csrfFetch(API.share, { method: 'POST', body: JSON.stringify({}) }).then(function (json) {
          showToast('分享已开启', 'success');
          renderShareModal(modal, json.data || { shared: false });
        }).catch(function (err) { enableBtn.disabled = false; showToast(err.message || '操作失败', 'error'); });
      });
    }
  }

  function openPermModal() {
    csrfFetch(API.permissions).then(function (json) {
      var perms = (json.data && json.data.permissions) || [];
      var bodyHtml = '<div class="ss-field"><label><input type="checkbox" id="permPublicRead"' + (state.publicRead ? ' checked' : '') + '> 公开只读</label></div><hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0">';
      if (perms.length > 0) {
        bodyHtml += '<table class="ss-table"><thead><tr><th>用户</th><th>权限</th><th>操作</th></tr></thead><tbody>';
        perms.forEach(function (p) {
          bodyHtml += '<tr><td>' + escapeHtml(p.username || p.user_id) + '</td><td>' + escapeHtml(PERM_NAMES[p.perm_type] || p.perm_type) + '</td><td><button class="ss-mini-btn danger" data-revoke="' + p.user_id + '">撤销</button></td></tr>';
        });
        bodyHtml += '</tbody></table>';
      } else { bodyHtml += '<p class="ss-hint">暂无授权用户</p>'; }
      var modal = openModal({ title: '🔐 权限管理', large: true, body: bodyHtml });
      modal.body.querySelector('#permPublicRead').addEventListener('change', function (e) {
        csrfFetch(API.publicRead, { method: 'POST', body: JSON.stringify({ publicRead: e.target.checked }) })
          .then(function () { state.publicRead = e.target.checked; showToast('已更新', 'success'); })
          .catch(function () { e.target.checked = !e.target.checked; });
      });
      modal.body.querySelectorAll('[data-revoke]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          csrfFetch(API.revokePerm + '/' + btn.dataset.revoke, { method: 'DELETE' })
            .then(function () { modal.close(); showToast('已撤销', 'success'); });
        });
      });
    });
  }

  function openApplyPermModal() {
    var bodyHtml = '<p class="ss-hint">您目前没有编辑权限</p><div class="ss-field"><label>申请类型</label><select id="applyPermType">';
    Object.keys(PERM_NAMES).forEach(function (k) { bodyHtml += '<option value="' + k + '">' + PERM_NAMES[k] + '</option>'; });
    bodyHtml += '</select></div><div class="ss-field"><label>理由</label><textarea id="applyReason" rows="3" maxlength="500"></textarea></div>';
    openModal({
      title: '🔓 申请权限', body: bodyHtml,
      actions: [{ label: '取消' }, {
        label: '提交', className: 'ss-btn-primary',
        onClick: function (ctx) {
          var permType = ctx.body.querySelector('#applyPermType').value;
          var reason = ctx.body.querySelector('#applyReason').value.trim();
          csrfFetch(API.apply, { method: 'POST', body: JSON.stringify({ perm_type: permType, reason: reason }) })
            .then(function () { ctx.close(); showToast('申请已提交', 'success'); });
          return false;
        }
      }]
    });
  }

  // ============ 导出 ============

  function openExportModal() {
    if (state.dirty) saveNow(true);
    var body = document.createElement('div');
    body.innerHTML = '<p class="ss-hint">选择导出方式。下载需要「下载」权限。</p>';
    var list = [
      ['pptx', '导出 PowerPoint（.pptx）', '文本/形状/图片/表格/备注/背景，可在 PowerPoint 与 WPS 直接打开'],
      ['html', '导出放映版网页（.html）', '单文件网页，含翻页动画与键盘操作，可直接放映'],
      ['pdf', '打印 / 存为 PDF', '浏览器打印每页一图版式，可另存为 PDF']
    ];
    list.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-btn';
      b.style.cssText = 'display:block;width:100%;margin:8px 0;text-align:left;padding:10px 12px;line-height:1.5';
      var strong = document.createElement('b');
      strong.textContent = item[1];
      var small = document.createElement('small');
      small.style.cssText = 'display:block;color:#64748b;font-weight:normal';
      small.textContent = item[2];
      b.appendChild(strong); b.appendChild(small);
      b.addEventListener('click', function () {
        if (item[0] === 'pdf') { printSlides(); modal.close(); return; }
        location.href = API.export + '?format=' + item[0];
        modal.close();
      });
      body.appendChild(b);
    });
    var modal = openModal({ title: '⬇️ 导出演示文稿', body: body });
  }

  /** 打印：临时渲染每页 960x540 的静态页，交给浏览器打印（每页一图，可存 PDF） */
  function printSlides() {
    finishTextEdit();
    var frame = document.createElement('iframe');
    frame.name = 'pptPrintFrame';
    frame.style.cssText = 'position:fixed;left:-1200px;top:0;width:1000px;height:700px;border:none';
    document.body.appendChild(frame);
    var doc = frame.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(CFG.name || '演示文稿') + '</title>'
      + '<link rel="stylesheet" href="/css/ppt-scene.css">'
      + '<style>@page{size:A4 landscape;margin:8mm}html,body{margin:0;background:#fff}'
      + '.p{page-break-after:always;position:relative;width:960px;height:540px;margin:0 auto 12px;overflow:hidden;transform-origin:top left}'
      + '.notes{width:720px;margin:0 auto 24px;font-size:11px;color:#666;white-space:pre-wrap}</style></head><body></body></html>');
    doc.close();
    slides().forEach(function (s) {
      var page = doc.createElement('div');
      page.className = 'p';
      var host = doc.createElement('div');
      host.style.cssText = 'position:relative;width:960px;height:540px;overflow:hidden';
      page.appendChild(host);
      var canvas = doc.createElement('div');
      canvas.className = 'ppt-canvas';
      canvas.style.position = 'absolute';
      host.appendChild(canvas);
      // renderSlide 已负责背景与全部元素，跨文档直接渲染进 iframe 的 DOM
      PPTScene.renderSlide(canvas, s);
      doc.body.appendChild(page);
      if (s.notes) {
        var n = doc.createElement('div');
        n.className = 'notes';
        n.textContent = '备注：' + s.notes;
        doc.body.appendChild(n);
      }
    });
    setTimeout(function () {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(function () { document.body.removeChild(frame); }, 1500);
    }, 350);
    showToast('已生成打印版式（每页一张，可在打印对话框选择另存为 PDF）', 'success');
  }

  // ============ 全局快捷键 ============

  function bindKeys() {
    document.addEventListener('keydown', function (ev) {
      var tag = (ev.target && ev.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable);
      var k = String(ev.key || '').toLowerCase();
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod && k === 's') { ev.preventDefault(); if (canEdit()) saveNow(true); return; }
      if (k === 'f5') { ev.preventDefault(); startShowFrom(ev.shiftKey ? state.idx : 0, { presenter: ev.shiftKey }); return; }
      if (typing || PPTShow.isRunning()) return;
      if (mod && k === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
      if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
      if (mod && k === 'c') { if (state.sel.length) { copySelected(); ev.preventDefault(); } return; }
      if (mod && k === 'v') { if (state.clipboard) { pasteClipboard(); ev.preventDefault(); } return; }
      if (mod && k === 'd') { ev.preventDefault(); duplicateSelected(); return; }
      if (mod && k === 'a') {
        ev.preventDefault();
        var s = current();
        state.sel = s ? (s.elements || []).map(function (e) { return e.id; }) : [];
        renderCanvas(); renderProps();
        return;
      }
      if (k === 'delete' || k === 'backspace') { if (state.sel.length) { ev.preventDefault(); deleteSelected(); } return; }
      if (k === 'escape') { state.sel = []; renderCanvas(); renderProps(); return; }
      if (k === 'enter' && state.sel.length === 1) { ev.preventDefault(); startTextEdit(findElement(state.sel[0])); return; }
      var step = ev.shiftKey ? 10 : 1;
      if (k === 'arrowleft') { ev.preventDefault(); nudge(-step, 0); return; }
      if (k === 'arrowright') { ev.preventDefault(); nudge(step, 0); return; }
      if (k === 'arrowup') { ev.preventDefault(); nudge(0, -step); return; }
      if (k === 'arrowdown') { ev.preventDefault(); nudge(0, step); return; }
      if (k === 'pagedown') { ev.preventDefault(); selectSlide(state.idx + 1); return; }
      if (k === 'pageup') { ev.preventDefault(); selectSlide(state.idx - 1); }
    });
  }

  // ============ UI 绑定 ============

  function bindUi() {
    var saveBtn = $('btnSsSave');
    if (saveBtn) { saveBtn.hidden = !canEdit(); saveBtn.addEventListener('click', function () { saveNow(true); }); }
    on('btnSsVersions', openVersionModal);
    on('btnSsShare', openShareModal);
    on('btnSsPerms', openPermModal);
    on('btnSsApplyPerm', openApplyPermModal);
    on('btnSsExport', openExportModal);
    on('btnPptShow', function () { startShowFrom(state.idx); });
    on('btnPptShowPresenter', function () { startShowFrom(state.idx, { presenter: true }); });
    on('btnPptRehearse', function () { startShowFrom(0, { rehearse: true }); });
    on('pptAddSlide', function () { addSlide(state.idx); });
    on('pptZoomIn', function () { setZoom(state.zoom + 0.1); });
    on('pptZoomOut', function () { setZoom(state.zoom - 0.1); });
    on('pptZoomFit', fitZoom);
    on('pptNotesToggle', function () { state.notesOpen = !state.notesOpen; renderNotes(); });

    var zr = $('pptZoomRange');
    if (zr) zr.addEventListener('input', function () { setZoom(Number(zr.value) / 100); });

    var notes = $('pptNotes');
    if (notes) {
      notes.addEventListener('input', function () {
        var s = current();
        if (!s || !canEdit()) return;
        s.notes = notes.value;
        markDirty();
      });
      notes.addEventListener('change', function () { pushHistory('修改备注'); });
    }

    document.querySelectorAll('.ppt-props-tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.ppt-props-tabs button').forEach(function (x) { x.classList.remove('is-active'); });
        b.classList.add('is-active');
        state.tab = b.dataset.tab;
        renderProps();
      });
    });

    window.addEventListener('resize', debounce(function () { paintSelection(); }, 150));
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { saveNow(false); stopPolling(); } else { startPolling(); }
    });
    window.addEventListener('pagehide', function () {
      if (state.dirty && canEdit() && !state.locked && state.doc) {
        // sendBeacon 无法自定义请求头，Content-Type 必须是 application/json 才会被服务端解析，
        // CSRF 令牌改由 body._csrf 携带（双提交中间件支持）
        var payload = JSON.stringify({
          doc: state.doc, baseVersion: state.version, structural: true,
          changeDesc: '页面关闭自动保存', _csrf: CFG.csrf || ''
        });
        navigator.sendBeacon(API.doc, new Blob([payload], { type: 'application/json' }));
      }
    });
  }

  function on(id, fn) {
    var b = $(id);
    if (b) b.addEventListener('click', fn);
  }

  // ============ 启动 ============

  function boot() {
    if (typeof PPTScene === 'undefined' || typeof PPTShow === 'undefined') {
      setLoading(false);
      setSaveStatus('is-error', '脚本加载失败');
      showToast('幻灯片脚本未加载，请刷新页面重试', 'error', 6000);
      return;
    }
    bindUi();
    bindCanvasEvents();
    bindKeys();
    buildRibbon();
    loadDoc();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
