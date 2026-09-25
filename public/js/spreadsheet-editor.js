/* global UniverBundle */
/**
 * Univer 在线表格编辑器前端逻辑
 * 页面：views/frontend/spreadsheet-editor.ejs（layout:false，无 utils.js，自带全部基础组件）
 * 依赖：/vendor/univer/univer.min.js（全局 UniverBundle，含 echarts）
 */
(function () {
  'use strict';

  // ============ 配置与常量 ============

  var CFG = window.__SHEET__ || {};
  var API = CFG.api || {};
  var BUNDLE = UniverBundle;

  // 权限相关路由未在 EJS 注入，统一由 myPerm 派生：
  // /api/spreadsheet/:id/permission/{apply|applications|approve|:userId}
  var PERM_API = (API.myPerm || '').replace(/\/my$/, '');
  API.apply = PERM_API + '/apply';
  API.applications = PERM_API + '/applications';
  API.approve = PERM_API + '/approve';
  API.revokePerm = PERM_API;

  var AUTO_SAVE_MS = 3000; // 自动保存防抖
  var CELLS_FLUSH_MS = 900; // 单元格变更上报防抖
  var CHANGES_POLL_MS = 4000; // 增量变更轮询
  var PRESENCE_POLL_MS = 4000; // 在线用户轮询
  var PRESENCE_BEAT_MS = 8000; // presence 心跳
  var MAX_BATCH_CELLS = 400; // 单批上报上限（后端 500）
  var AVATAR_COLORS = ['#6366f1', '#059669', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#4d7c0f'];
  var PERM_NAMES = { view: '查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };

  // ============ 运行状态 ============

  var univerAPI = null;
  var wb = null; // 当前 FWorkbook
  var sheetNames = {}; // univerSheetId -> sheet 名
  var state = {
    version: CFG.version || 0,
    locked: Boolean(CFG.isLocked),
    publicRead: Boolean(CFG.isPublicRead),
    dirty: false, // 有未保存修改
    structural: false, // 本轮修改含结构性变更
    saving: false,
    applyingRemote: false, // 正在应用远端变更（不标脏）
    lastSeq: 0,
    comments: [],
    usersCache: [],
    commentOpen: false,
    commentFilter: 'all', // all | open | task
    chartsOpen: false,
    reloadPending: false
  };
  var lastSel = null; // 最近选区 {startRow,startColumn,endRow,endColumn}
  var pendingCellBatches = []; // [{sheetId, cells:[{r,c,cell}]}]
  var cellsTimer = null;
  var chartModal = null; // 图表模态框上下文 {close, ec: [echarts实例]}

  // ============ 基础工具 ============

  function $(id) { return document.getElementById(id); }

  function escapeHtml(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(v) {
    if (!v) return '';
    var d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(v);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function colName(c) {
    var s = '';
    var n = c + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function a1(row, col) { return colName(col) + (row + 1); }

  function hashColor(str) {
    var h = 0;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      var args = arguments;
      var self = this;
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
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

  // ============ 网络请求（CSRF + 统一错误） ============

  function csrfFetch(url, options) {
    var opt = options || {};
    var headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': CFG.csrf || '' };
    if (opt.headers) {
      Object.keys(opt.headers).forEach(function (k) { headers[k] = opt.headers[k]; });
    }
    opt.headers = headers;
    opt.credentials = 'same-origin';
    return fetch(url, opt).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error((json && json.error) || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          err.data = json || {};
          throw err;
        }
        return json;
      });
    });
  }

  // ============ Toast ============

  function showToast(msg, type, ms) {
    var root = $('ssToastRoot');
    if (!root) return;
    var t = document.createElement('div');
    t.className = 'ss-toast' + (type ? ' ss-toast-' + type : '');
    t.textContent = String(msg || '');
    root.appendChild(t);
    setTimeout(function () {
      t.classList.add('hiding');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, ms || 3200);
  }

  // ============ 模态框 ============

  /**
   * openModal({title, large, body(HTML 字符串或节点), actions:[{label, className, keep, onClick}],
   *            onClose})
   * 返回 {root, body, close}
   */
  function openModal(opts) {
    var backdrop = document.createElement('div');
    backdrop.className = 'ss-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ss-modal' + (opts.large ? ' ss-modal-lg' : '');

    var head = document.createElement('div');
    head.className = 'ss-modal-head';
    head.innerHTML = '<h3>' + escapeHtml(opts.title || '') + '</h3>';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ss-modal-close';
    closeBtn.innerHTML = '&times;';
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'ss-modal-body';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    modal.appendChild(head);
    modal.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'ss-modal-actions';
    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-btn' + (a.className ? ' ' + a.className : '');
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
      root: modal,
      body: body,
      close: function () {
        if (closed) return;
        closed = true;
        if (opts.onClose) opts.onClose();
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }
    };
    closeBtn.addEventListener('click', ctx.close);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) ctx.close(); });
    return ctx;
  }

  // ============ 加载遮罩 / 保存状态 ============

  function setLoading(visible, text) {
    var mask = $('ssLoadingMask');
    if (!mask) return;
    mask.hidden = !visible;
    if (visible && text) {
      var p = mask.querySelector('p');
      if (p) p.textContent = text;
    }
  }

  function setSaveStatus(cls, text) {
    var el = $('ssSaveStatus');
    if (!el) return;
    el.className = 'ss-save-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }

  // ============ Univer 初始化与文档渲染 ============

  function initUniver() {
    if (!BUNDLE || typeof BUNDLE.createUniver !== 'function') {
      setLoading(false);
      showToast('Univer 组件加载失败，请刷新页面', 'error');
      return false;
    }
    var locale = BUNDLE.LocaleType ? BUNDLE.LocaleType.ZH_CN : undefined;
    var locales = {};
    if (locale !== undefined && BUNDLE.zhCN) locales[locale] = BUNDLE.zhCN;
    var presets = [];
    if (typeof BUNDLE.UniverSheetsCorePreset === 'function') presets.push(BUNDLE.UniverSheetsCorePreset({ container: 'univer-container' }));
    if (typeof BUNDLE.UniverSheetsFilterPreset === 'function') presets.push(BUNDLE.UniverSheetsFilterPreset());
    if (typeof BUNDLE.UniverSheetsDataValidationPreset === 'function') presets.push(BUNDLE.UniverSheetsDataValidationPreset());
    if (typeof BUNDLE.UniverSheetsFindReplacePreset === 'function') presets.push(BUNDLE.UniverSheetsFindReplacePreset());
    if (typeof BUNDLE.UniverSheetsConditionalFormattingPreset === 'function') presets.push(BUNDLE.UniverSheetsConditionalFormattingPreset());
    if (typeof BUNDLE.UniverSheetsHyperLinkPreset === 'function') {
      // 链接安全跳转：接管 Univer 外链导航（http/https/mailto），站内直开、站外弹安全确认
      presets.push(BUNDLE.UniverSheetsHyperLinkPreset({
        urlHandler: { navigateToOtherWebsite: function (url) { handleSheetLinkNavigate(url); } }
      }));
    }

    var opts = { presets: presets };
    if (locale !== undefined) opts.locale = locale;
    if (Object.keys(locales).length) opts.locales = locales;
    if (BUNDLE.defaultTheme) opts.theme = BUNDLE.defaultTheme;

    var inst = BUNDLE.createUniver(opts);
    univerAPI = inst.univerAPI;
    return Boolean(univerAPI && typeof univerAPI.createWorkbook === 'function');
  }

  function loadDoc() {
    return csrfFetch(API.doc).then(function (json) {
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      renderWorkbook(data.doc);
      setSaveStatus('is-saved', '已加载 v' + state.version);
      setLoading(false);
      startPolling();
    }).catch(function (err) {
      setLoading(false);
      setSaveStatus('is-error', '加载失败');
      showToast(err.message || '文档加载失败', 'error');
    });
  }

  function renderWorkbook(doc) {
    if (!doc) return;
    // 销毁旧实例（避免 unitId 冲突）
    if (wb) {
      var oldId = typeof wb.getId === 'function' ? wb.getId() : null;
      if (oldId && univerAPI && typeof univerAPI.disposeUnit === 'function') {
        try { univerAPI.disposeUnit(oldId); } catch (e) { /* 忽略 */ }
      } else if (typeof wb.dispose === 'function') {
        try { wb.dispose(); } catch (e) { /* 忽略 */ }
      }
      wb = null;
    }
    wb = univerAPI.createWorkbook(doc);
    if (univerAPI.getActiveWorkbook && typeof univerAPI.getActiveWorkbook === 'function') {
      var active = univerAPI.getActiveWorkbook();
      if (active) wb = active;
    }
    cacheSheetNames();
    wireWorkbook();
    applyEditable();
    // 自动链接识别：初始全量扫描 + 包装链接解析服务（覆盖 ftp:// 等协议）
    scanWorkbookLinks(doc);
    wrapHyperLinkResolver();
    if (!hyperLinkResolverWrapped) setTimeout(wrapHyperLinkResolver, 2000);
  }

  function cacheSheetNames() {
    sheetNames = {};
    try {
      var sheets = wb.getSheets();
      sheets.forEach(function (s) {
        var sid = typeof s.getSheetId === 'function' ? s.getSheetId() : '';
        sheetNames[sid] = typeof s.getName === 'function' ? s.getName() : sid;
      });
    } catch (e) { /* 忽略 */ }
  }

  function wireWorkbook() {
    if (!wb) return;
    if (typeof wb.onCommandExecuted === 'function') {
      wb.onCommandExecuted(function (cmd) {
        if (state.applyingRemote) return;
        var id = (cmd && cmd.id) || '';
        // 只关心数据层变更（mutation）；undo/redo 会重新执行 mutation 也会命中
        if (id.indexOf('.mutation.') === -1) return;
        var structural = id !== 'sheet.mutation.set-range-values';
        markDirty(structural);
        if (id === 'sheet.mutation.set-range-values' && cmd.params && cmd.params.cellValue && !state.locked && CFG.canEdit) {
          queueCells(cmd.params.subUnitId, cmd.params.cellValue);
        }
        // 链接自动识别：数据动态更新（AI 写入 / 程序化赋值 / 撤销重做）后对新值重新识别
        if (id === 'sheet.mutation.set-range-values' && cmd.params && cmd.params.cellValue) {
          scanCellValuesForLinks(cmd.params.subUnitId, cmd.params.cellValue);
        }
      });
    }
    if (typeof wb.onSelectionChange === 'function') {
      wb.onSelectionChange(function (ranges) {
        var r = ranges && ranges[0];
        if (r) lastSel = r;
        reportPresenceSoon();
      });
    }
  }

  function applyEditable() {
    if (!wb || typeof wb.setEditable !== 'function') return;
    var editable = Boolean(CFG.canEdit && !state.locked);
    try { wb.setEditable(editable); } catch (e) { /* 忽略 */ }
    var saveBtn = $('btnSsSave');
    if (saveBtn) saveBtn.hidden = !editable;
  }

  /** 提取当前文档快照（防御双链） */
  function extractDoc() {
    if (!wb) return null;
    var snap = null;
    if (typeof wb.getSnapshot === 'function') {
      try { snap = wb.getSnapshot(); } catch (e) { snap = null; }
    }
    if (!snap && wb._workbook && typeof wb._workbook.getSnapshot === 'function') {
      try { snap = wb._workbook.getSnapshot(); } catch (e) { snap = null; }
    }
    return snap;
  }

  function activeSheetId() {
    try {
      var s = wb.getActiveSheet();
      if (s && typeof s.getSheetId === 'function') return s.getSheetId();
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /** 当前选区锚点（批注挂载位置） */
  function getAnchorCell() {
    var sid = activeSheetId();
    if (lastSel) {
      return { sheetId: sid, row: lastSel.startRow || 0, col: lastSel.startColumn || 0 };
    }
    return { sheetId: sid, row: 0, col: 0 };
  }

  function getActiveRangeRect() {
    if (!lastSel) return null;
    return {
      startRow: lastSel.startRow || 0, startColumn: lastSel.startColumn || 0,
      endRow: lastSel.endRow || 0, endColumn: lastSel.endColumn || 0
    };
  }

  /** 跳转定位到批注所在单元格 */
  function focusCell(sheetId, row, col) {
    if (!wb) return;
    try {
      var sheets = wb.getSheets();
      for (var i = 0; i < sheets.length; i++) {
        var s = sheets[i];
        var sid = typeof s.getSheetId === 'function' ? s.getSheetId() : '';
        if (sid === sheetId) {
          if (typeof s.activate === 'function') s.activate();
          break;
        }
      }
      // 注意：FWorkbook 门面没有 syncExecuteCommand；此版本选区命令为 operation.set-selections
      univerAPI.syncExecuteCommand('sheet.operation.set-selections', {
        unitId: typeof wb.getId === 'function' ? wb.getId() : wb.id,
        subUnitId: sheetId,
        selections: [{ range: { startRow: row, startColumn: col, endRow: row, endColumn: col } }]
      });
    } catch (e) { /* 定位失败不提示 */ }
  }

  // ============ 保存（乐观锁） ============

  function markDirty(structural) {
    if (!CFG.canEdit || state.locked) return;
    state.dirty = true;
    if (structural) state.structural = true;
    setSaveStatus('is-dirty', '有未保存更改');
    scheduleSave();
  }

  var scheduleSave = debounce(function () { saveNow(false); }, AUTO_SAVE_MS);

  /** 保存前预检：服务端 express.json 上限 50MB，超限直接提示，避免白白上传后 413 */
  function checkDocBodySize(body) {
    var size = body.length;
    try { size = new Blob([body]).size; } catch (e) { /* 旧浏览器回退字符数 */ }
    if (size <= 50 * 1024 * 1024) return true;
    setSaveStatus('is-error', '文档过大');
    showToast('文档数据超过服务器 50MB 保存上限，无法保存。请减少表格行列或拆分内容后重试', 'error', 6000);
    return false;
  }

  function saveNow(manual) {
    if (!CFG.canEdit || state.locked) {
      if (manual) showToast('当前为只读模式，无法保存', 'warning');
      return;
    }
    if (state.saving) return;
    if (!state.dirty) {
      if (manual) showToast('没有需要保存的更改', 'warning');
      return;
    }
    var doc = extractDoc();
    if (!doc) { showToast('无法提取文档数据', 'error'); return; }
    var body = JSON.stringify({
      doc: doc,
      baseVersion: state.version,
      structural: state.structural,
      snapshot: Boolean(manual),
      changeDesc: manual ? '手动保存' : '自动保存'
    });
    if (!checkDocBodySize(body)) return;
    state.saving = true;
    setSaveStatus('is-saving', '保存中…');
    csrfFetch(API.doc, {
      method: 'PUT',
      body: body
    }).then(function (json) {
      state.saving = false;
      state.dirty = false;
      state.structural = false;
      state.version = (json.data && json.data.version) || state.version;
      setSaveStatus('is-saved', '已保存 v' + state.version);
      if (manual) showToast('保存成功（v' + state.version + '）', 'success');
    }).catch(function (err) {
      state.saving = false;
      if (err.status === 409) {
        handleConflict(err.data);
      } else {
        setSaveStatus('is-error', '保存失败');
        showToast(err.message || '保存失败', 'error');
      }
    });
  }

  function handleConflict(data) {
    setSaveStatus('is-error', '版本冲突');
    var serverVersion = data && data.serverVersion;
    openModal({
      title: '保存冲突',
      body: '<p>他人已保存了新版本' + (serverVersion ? '（服务器当前 v' + serverVersion + '，您基于 v' + state.version + '）' : '') +
        '。您可以选择放弃本地修改并拉取最新版本；或取消后重试保存。</p>' +
        '<p style="font-size:12px;color:#94a3b8;">提示：远端单元格改动会实时同步，冲突通常只发生在结构或样式变更上。</p>',
      actions: [
        { label: '拉取最新版本（放弃本地未保存修改）', className: 'ss-btn-primary', onClick: function () { reloadDoc(); state.dirty = false; } },
        { label: '取消' }
      ]
    });
  }

  // ============ 本地单元格变更上报（cells 实时通道） ============

  function queueCells(sheetId, cellValue) {
    var cells = [];
    Object.keys(cellValue || {}).forEach(function (r) {
      var row = cellValue[r];
      Object.keys(row || {}).forEach(function (c) {
        var v = row[c];
        cells.push({ r: Number(r), c: Number(c), cell: v === undefined ? null : v });
      });
    });
    if (!cells.length) return;
    var batch = null;
    for (var i = 0; i < pendingCellBatches.length; i++) {
      if (pendingCellBatches[i].sheetId === sheetId) { batch = pendingCellBatches[i]; break; }
    }
    if (!batch) { batch = { sheetId: sheetId, cells: [] }; pendingCellBatches.push(batch); }
    batch.cells = batch.cells.concat(cells);
    if (cellsTimer) clearTimeout(cellsTimer);
    cellsTimer = setTimeout(flushCells, CELLS_FLUSH_MS);
  }

  function flushCells() {
    cellsTimer = null;
    if (!pendingCellBatches.length) return;
    var batches = pendingCellBatches.splice(0);
    batches.forEach(function (b) {
      if (!b.cells.length) return;
      csrfFetch(API.changes, {
        method: 'POST',
        body: JSON.stringify({ sheetId: b.sheetId, cells: b.cells.slice(0, MAX_BATCH_CELLS) })
      }).catch(function () { /* 上报失败由全量保存兜底 */ });
    });
  }

  // ============ 自动链接识别与安全跳转 ============

  var CELL_URL_RE = /^(https?|ftp):\/\/[^\s]+$/i;
  // Univer 单元格富文本内部文档 ID（与其原生「输入 URL 自动转链接」结构保持一致）
  var LINK_DOC_ID = '__INTERNAL_EDITOR__DOCS_NORMAL';
  var linkIdSeq = 0;
  var hyperLinkResolverWrapped = false;
  var hyperLinkResolverSvc = null; // 被包装的 Univer 链接解析服务实例（#debug 测试钩子用）

  /**
   * 严格识别整格 URL 文本（http://、https://、ftp:// 前缀）：
   * 全格匹配、不允许空白，防止把普通文本误识别为链接
   */
  function matchCellUrl(text) {
    if (typeof text !== 'string') return null;
    var t = text;
    if (t.length < 8 || t.length > 2048) return null;
    if (t.charAt(t.length - 1) === ' ') return null; // Univer 原生同款规则：结尾空格不转
    if (!CELL_URL_RE.test(t)) return null;
    try {
      var u = new URL(t);
      if (!/^(https?|ftp):$/i.test(u.protocol) || !u.hostname) return null;
      return t;
    } catch (e) { return null; }
  }

  function genLinkId(prefix) {
    linkIdSeq += 1;
    return prefix + Date.now().toString(36) + '-' + linkIdSeq.toString(36) +
      Math.floor(Math.random() * 46656).toString(36);
  }

  /** 构造富文本超链接单元格（结构与 Univer 原生输入转换一致：customRanges HYPERLINK） */
  function buildLinkCell(cell, url) {
    var text = String(cell.v);
    var linkCell = {};
    Object.keys(cell).forEach(function (k) { if (k !== 'p') linkCell[k] = cell[k]; });
    linkCell.p = {
      id: LINK_DOC_ID,
      body: {
        dataStream: text + '\r\n',
        paragraphs: [{ startIndex: text.length, paragraphId: genLinkId('lp') }],
        customRanges: [{
          startIndex: 0,
          endIndex: text.length - 1,
          rangeId: genLinkId('lr'),
          rangeType: 0, // CustomRangeType.HYPERLINK
          properties: { url: url, tooltip: url }
        }]
      },
      documentStyle: { pageSize: { width: Infinity, height: Infinity } }
    };
    return linkCell;
  }

  /**
   * 扫描 cellValue 中的纯文本 URL 单元格并转换为可点击超链接。
   * 幂等：已有富文本(p)/公式(f)/非 URL 文本一律跳过；自身触发的 mutation 再入时自动空转。
   * persist=true（可编辑用户初始/本地变更）：正常标脏并入实时同步通道，随保存持久化；
   * persist=false（只读用户、远端派生）：包在 applyingRemote 中仅本地生效。
   */
  function scanCellValuesForLinks(subUnitId, cellValue, persist) {
    if (!wb || !univerAPI || !subUnitId || !cellValue) return;
    if (persist === undefined) persist = Boolean(CFG.canEdit && !state.locked);
    var patch = null;
    Object.keys(cellValue).forEach(function (r) {
      var row = cellValue[r] || {};
      Object.keys(row).forEach(function (c) {
        var cell = row[c];
        if (!cell || typeof cell !== 'object' || cell.p || cell.f) return;
        var url = matchCellUrl(cell.v);
        if (!url) return;
        if (!patch) patch = {};
        if (!patch[r]) patch[r] = {};
        patch[r][c] = buildLinkCell(cell, url);
      });
    });
    if (!patch) return;
    if (!persist) state.applyingRemote = true;
    try {
      // 注意：必须走 mutation 而非 command —— 此版本 SetRangeValues 命令
      // 依赖当前选区（{value, range}），cellValue 参数会被静默忽略
      univerAPI.syncExecuteCommand('sheet.mutation.set-range-values', {
        unitId: wb.id,
        subUnitId: subUnitId,
        cellValue: patch
      });
    } catch (e) { /* 异常结构变化等：静默放弃本次转换 */ }
    if (!persist) state.applyingRemote = false;
  }

  /** 初始扫描：整份文档所有工作表的存量纯文本 URL 一次性升级为超链接 */
  function scanWorkbookLinks(doc) {
    if (!wb || !doc || !doc.sheets) return;
    // Univer 快照的 sheets 为以 sheetId 为键的对象（兼容数组形态）
    if (Array.isArray(doc.sheets)) {
      doc.sheets.forEach(function (sh) {
        if (sh && sh.id && sh.cellData) scanCellValuesForLinks(sh.id, sh.cellData);
      });
    } else {
      Object.keys(doc.sheets).forEach(function (sid) {
        var sh = doc.sheets[sid];
        if (sh && sh.cellData) scanCellValuesForLinks(sid, sh.cellData);
      });
    }
  }

  /**
   * 包装 Univer 链接解析服务实例的 navigateToOtherWebsite，
   * 让包括 ftp://（被其内置协议白名单 http/https/mailto 拦截）在内的所有链接点击
   * 统一走 handleSheetLinkNavigate；找不到实例时退回 preset urlHandler 钩子。
   */
  function wrapHyperLinkResolver() {
    if (hyperLinkResolverWrapped || !univerAPI) return;
    try {
      var inj = univerAPI._injector;
      if (!inj || !inj.resolvedDependencyCollection || !inj.resolvedDependencyCollection.resolvedDependencies) return;
      var found = null;
      inj.resolvedDependencyCollection.resolvedDependencies.forEach(function (arr) {
        (arr || []).forEach(function (o) {
          if (o && !o.__ssLinkWrapped && typeof o.navigate === 'function' &&
              typeof o.navigateToOtherWebsite === 'function' && typeof o.navigateToDefineName === 'function') {
            found = o;
          }
        });
      });
      if (found) {
        found.navigateToOtherWebsite = function (url) { return handleSheetLinkNavigate(url); };
        found.__ssLinkWrapped = true;
        hyperLinkResolverSvc = found;
        hyperLinkResolverWrapped = true;
      }
    } catch (e) { /* 注入器内部结构变化：忽略，退回 urlHandler 配置钩子 */ }
  }

  /**
   * 链接点击跳转：站内链接（域名一致）直接新窗口打开；
   * 站外链接弹出安全提示对话框，用户确认后才跳转
   */
  function handleSheetLinkNavigate(url) {
    var target = String(url || '');
    if (!target) return;
    var host = '';
    try { host = new URL(target).hostname; } catch (e) { host = ''; }
    if (host && host === location.hostname) {
      window.open(target, '_blank', 'noopener');
      return;
    }
    confirmOpenExternalLink(target, host);
  }

  /** 站外链接安全确认弹窗：醒目图标 + 风险提示 + 目标地址 + 确定/取消 */
  function confirmOpenExternalLink(url, host) {
    var box = document.createElement('div');
    box.className = 'ss-link-warn';
    box.innerHTML =
      '<div class="ss-link-warn-icon" aria-hidden="true">⚠</div>' +
      '<p class="ss-link-warn-text">这是外部链接，可能存在安全风险，是否继续访问？</p>' +
      (host ? '<p class="ss-link-warn-host">目标域名：<b>' + escapeHtml(host) + '</b></p>' : '') +
      '<p class="ss-link-warn-url">' + escapeHtml(url) + '</p>';
    openModal({
      title: '安全提示',
      body: box,
      actions: [
        { label: '取消' },
        { label: '确定', className: 'ss-btn-danger', onClick: function () { window.open(url, '_blank', 'noopener,noreferrer'); } }
      ]
    });
  }

  // ============ 远端变更接收与文档重载 ============

  function applyRemoteCells(payload) {
    if (!wb || !payload || !Array.isArray(payload.cells) || !payload.cells.length) return;
    var cellValue = {};
    payload.cells.forEach(function (op) {
      if (!cellValue[op.r]) cellValue[op.r] = {};
      cellValue[op.r][op.c] = (op.cell === undefined || op.cell === null) ? null : op.cell;
    });
    state.applyingRemote = true;
    try {
      // 注意：FWorkbook 门面没有 syncExecuteCommand，须用 univerAPI；
      // 且 SetRangeValues 命令依赖选区会忽略 cellValue，须走 mutation
      univerAPI.syncExecuteCommand('sheet.mutation.set-range-values', {
        unitId: typeof wb.getId === 'function' ? wb.getId() : wb.id,
        subUnitId: payload.sheetId,
        cellValue: cellValue
      });
    } catch (e) {
      state.applyingRemote = false;
      reloadDoc('同步远端单元格失败，已重新加载');
      return;
    }
    state.applyingRemote = false;
    cacheSheetNames();
    // 远端写入的纯文本 URL 本地即时转链接（仅本地展示不标脏，随后续保存自然持久化）
    scanCellValuesForLinks(payload.sheetId, cellValue, false);
  }

  function reloadDoc(reason) {
    if (state.reloadPending) return Promise.resolve();
    state.reloadPending = true;
    return csrfFetch(API.doc).then(function (json) {
      state.reloadPending = false;
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      renderWorkbook(data.doc);
      setSaveStatus(state.dirty ? 'is-dirty' : 'is-saved', state.dirty ? '有未保存更改' : '已同步 v' + state.version);
      if (reason) showToast(reason, 'success');
    }).catch(function (err) {
      state.reloadPending = false;
      showToast(err.message || '重载失败', 'error');
    });
  }

  // ============ 轮询（增量变更 + 在线用户） ============

  function startPolling() {
    setInterval(pollChanges, CHANGES_POLL_MS);
    setInterval(pollPresence, PRESENCE_POLL_MS);
    setInterval(beatPresence, PRESENCE_BEAT_MS);
    beatPresence();
  }

  function pollChanges() {
    if (!wb) return;
    csrfFetch(API.changes + '?since=' + state.lastSeq).then(function (json) {
      var data = json.data || {};
      if (data.since) state.lastSeq = Math.max(state.lastSeq, data.since);
      var changes = data.changes || [];
      changes.forEach(function (ch) { handleRemoteChange(ch); });
    }).catch(function () { /* 静默 */ });
  }

  function handleRemoteChange(ch) {
    var payload = ch.payload || {};
    if (ch.kind === 'cells') {
      applyRemoteCells(payload);
    } else if (ch.kind === 'docReload') {
      handleDocReload(payload, ch.username);
    } else if (ch.kind === 'comments') {
      if (state.commentOpen) loadComments();
    } else if (ch.kind === 'charts') {
      if (state.chartsOpen && chartModal) loadCharts();
    }
  }

  function handleDocReload(payload, username) {
    if (payload.publicRead !== undefined) {
      state.publicRead = Boolean(payload.publicRead);
      showToast(payload.publicRead
        ? '文档已开启公开只读（所有登录用户可查看）'
        : '文档已关闭公开只读，访问权限将在刷新后重新校验', 'warning');
      return;
    }
    if (payload.locked !== undefined) {
      state.locked = Boolean(payload.locked);
      applyEditable();
      showToast(payload.locked ? '表格已被锁定' : '表格已解锁', 'warning');
      if (payload.locked) { state.dirty = false; setSaveStatus('', '已锁定'); }
      return;
    }
    var remoteVersion = payload.version;
    if (typeof remoteVersion === 'number' && remoteVersion > state.version) {
      if (state.dirty) {
        showToast((username || '他人') + ' 保存了新版本（v' + remoteVersion + '），请在编辑后尽快保存', 'warning');
        setSaveStatus('is-error', '版本落后');
      } else {
        reloadDoc('已同步 ' + (username || '他人') + ' 的修改');
      }
    }
  }

  function pollPresence() {
    if (!wb) return;
    csrfFetch(API.presence).then(function (json) {
      renderPresenceBar((json.data && json.data.users) || []);
    }).catch(function () { /* 静默 */ });
  }

  var reportPresenceSoon = debounce(beatPresence, 600);

  function beatPresence() {
    if (!wb) return;
    var rect = lastSel ? {
      row: lastSel.startRow || 0, col: lastSel.startColumn || 0,
      endRow: lastSel.endRow || 0, endCol: lastSel.endColumn || 0
    } : { row: 0, col: 0, endRow: 0, endCol: 0 };
    var mode = state.dirty ? 'edit' : (lastSel ? 'select' : 'cursor');
    csrfFetch(API.presence, {
      method: 'POST',
      body: JSON.stringify({ sheetId: activeSheetId(), range: rect, mode: mode })
    }).catch(function () { /* 静默 */ });
  }

  function renderPresenceBar(users) {
    var bar = $('ssPresenceBar');
    if (!bar) return;
    bar.innerHTML = '';
    users.slice(0, 8).forEach(function (u) {
      var av = document.createElement('span');
      av.className = 'ss-presence-avatar';
      var name = u.username || '用户';
      av.textContent = name.charAt(0).toUpperCase();
      av.style.background = hashColor(name);
      var modeText = u.mode === 'edit' ? '编辑中' : (u.mode === 'select' ? '查看中' : '在线');
      av.title = name + ' · ' + (sheetNames[u.sheetId] || '工作表') + ' · ' + modeText +
        (u.range ? '（' + a1(u.range.row, u.range.col) + '）' : '');
      bar.appendChild(av);
    });
  }

  // ============ 批注侧栏 ============

  function ensureUsers() {
    if (state.usersCache.length || CFG.permLevel < 2) return Promise.resolve(state.usersCache);
    return csrfFetch(API.users).then(function (json) {
      state.usersCache = (json.data && json.data.users) || [];
      return state.usersCache;
    }).catch(function () { return []; });
  }

  // ============ @ 提及用户选择 ============
  // 在批注输入区（主输入框 / 回复框）输入 "@" 激活：↑↓ 键盘选择、Enter / 点击插入用户名，
  // ESC / 点击空白处关闭；用户列表每次激活按需刷新（5 秒内复用缓存），新注册用户可及时出现。

  var MENTION_TTL = 5000;
  var mention = { active: false, users: [], highlight: 0, inputEl: null, atPos: -1, panel: null, lastFetch: 0 };

  function fetchMentionUsers() {
    if (state.usersCache.length && Date.now() - mention.lastFetch < MENTION_TTL) {
      return Promise.resolve(state.usersCache);
    }
    return csrfFetch(API.users).then(function (json) {
      state.usersCache = (json.data && json.data.users) || [];
      mention.lastFetch = Date.now();
      return state.usersCache;
    }).catch(function () { return state.usersCache || []; });
  }

  function closeMention() {
    if (mention.panel && mention.panel.parentNode) mention.panel.parentNode.removeChild(mention.panel);
    mention.panel = null;
    mention.active = false;
    mention.inputEl = null;
  }

  function mentionAvatarHtml(u) {
    var name = u.nickname || u.username || '?';
    if (u.avatar) {
      return '<img class="ss-mention-avatar" src="' + escapeHtml(u.avatar) + '" alt="">';
    }
    return '<span class="ss-mention-avatar ss-mention-avatar-letter" style="background:' + hashColor(name) + '">' +
      escapeHtml(name.charAt(0).toUpperCase()) + '</span>';
  }

  function renderMentionList(keyword) {
    var panel = mention.panel;
    if (!panel) return;
    var kw = String(keyword || '').toLowerCase();
    var users = (state.usersCache || []).filter(function (u) {
      if (!kw) return true;
      return (u.username || '').toLowerCase().indexOf(kw) !== -1 ||
        (u.nickname || '').toLowerCase().indexOf(kw) !== -1;
    });
    mention.users = users;
    mention.highlight = 0;
    if (!users.length) {
      panel.innerHTML = '<div class="ss-mention-empty">' + (kw ? '未找到匹配的用户' : '暂无可选用户') + '</div>';
      return;
    }
    var html = '<div class="ss-mention-head">选择要提醒的用户（↑↓ 选择 · Enter 确认 · Esc 关闭）</div>';
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      html += '<div class="ss-mention-item' + (i === 0 ? ' is-active' : '') + '" data-mi="' + i + '">' +
        mentionAvatarHtml(u) +
        '<span class="ss-mention-name">' + escapeHtml(u.username) + '</span>' +
        (u.nickname && u.nickname !== u.username
          ? '<span class="ss-mention-nick">' + escapeHtml(u.nickname) + '</span>' : '') +
        '</div>';
    }
    panel.innerHTML = html;
  }

  function positionMention() {
    var el = mention.inputEl;
    var panel = mention.panel;
    if (!el || !panel) return;
    var rect = el.getBoundingClientRect();
    var w = Math.min(320, window.innerWidth - 16);
    panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
    var ph = panel.offsetHeight;
    if (rect.top - ph - 6 >= 8) {
      panel.style.top = (rect.top - ph - 6) + 'px';
    } else {
      panel.style.top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - ph - 8)) + 'px';
    }
  }

  function moveMentionHighlight(delta) {
    var n = mention.users.length;
    if (!n) return;
    mention.highlight = (mention.highlight + delta + n) % n;
    var items = mention.panel.querySelectorAll('.ss-mention-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('is-active', i === mention.highlight);
    var cur = items[mention.highlight];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function selectMentionUser(u) {
    var el = mention.inputEl;
    if (!el || !u) { closeMention(); return; }
    var pos = el.selectionStart == null ? el.value.length : el.selectionStart;
    var insert = '@' + u.username + ' ';
    el.value = el.value.slice(0, mention.atPos) + insert + el.value.slice(pos);
    var newPos = mention.atPos + insert.length;
    closeMention();
    el.focus();
    try { el.setSelectionRange(newPos, newPos); } catch (e) { /* ignore */ }
  }

  function handleMentionInput(e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (!el.closest('.ss-comment-form') && !el.closest('.ss-reply-form')) { closeMention(); return; }
    var pos = el.selectionStart == null ? -1 : el.selectionStart;
    if (pos < 0) { closeMention(); return; }
    var before = el.value.slice(0, pos);
    // 光标前存在未完结的「@关键词」才激活（@ 前不能紧跟普通字符，避免误触邮箱等场景）
    var m = before.match(/(?:^|[^A-Za-z0-9_\u4e00-\u9fa5@])@([A-Za-z0-9_\u4e00-\u9fa5.-]*)$/);
    if (!m) { closeMention(); return; }
    var el2 = el; // 异步刷新后仍需比对的触发元素
    mention.inputEl = el;
    mention.atPos = pos - m[1].length - 1;
    if (!mention.panel) {
      mention.panel = document.createElement('div');
      mention.panel.className = 'ss-mention-panel';
      mention.panel.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // 阻止输入框失焦
      mention.panel.addEventListener('click', function (ev) {
        var item = ev.target && ev.target.closest ? ev.target.closest('.ss-mention-item') : null;
        if (item) selectMentionUser(mention.users[parseInt(item.getAttribute('data-mi'), 10)]);
      });
      document.body.appendChild(mention.panel);
    }
    mention.active = true;
    renderMentionList(m[1]);
    positionMention();
    // 激活时按需刷新用户列表，保证服务器用户动态变化可及时呈现
    fetchMentionUsers().then(function () {
      if (mention.active && mention.inputEl === el2) renderMentionList(m[1]);
    });
  }

  function handleMentionKeydown(e) {
    if (!mention.active) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      moveMentionHighlight(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (mention.users.length) {
        e.preventDefault(); e.stopPropagation();
        selectMentionUser(mention.users[mention.highlight]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closeMention();
    }
  }

  function initMention() {
    var panel = $('ssCommentPanel');
    if (!panel) return;
    panel.addEventListener('input', handleMentionInput);
    // 捕获阶段拦截：优先于「Enter 发送评论」等按键逻辑
    panel.addEventListener('keydown', handleMentionKeydown, true);
    document.addEventListener('mousedown', function (e) {
      if (!mention.active) return;
      var t = e.target;
      if (t && t.closest && (t.closest('.ss-mention-panel') || t === mention.inputEl)) return;
      closeMention();
    }, true);
    window.addEventListener('resize', function () { if (mention.active) positionMention(); });
    $('ssCommentClose').addEventListener('click', closeMention);
  }

  function loadComments() {
    return csrfFetch(API.comments).then(function (json) {
      state.comments = (json.data && json.data.comments) || [];
      renderComments();
    }).catch(function (err) { showToast(err.message || '批注加载失败', 'error'); });
  }

  function renderComments() {
    var list = $('ssCommentList');
    if (!list) return;
    var comments = state.comments;
    // 过滤
    if (state.commentFilter === 'open') comments = comments.filter(function (c) { return !c.resolved; });
    else if (state.commentFilter === 'task') comments = comments.filter(function (c) { return c.assignedTo && c.taskStatus !== 'none'; });
    // 分组：根 + 回复
    var roots = comments.filter(function (c) { return !c.parentId; });
    var replyMap = {};
    comments.forEach(function (c) {
      if (c.parentId) (replyMap[c.parentId] = replyMap[c.parentId] || []).push(c);
    });
    Object.keys(replyMap).forEach(function (k) {
      replyMap[k].sort(function (a, b) { return a.id - b.id; });
    });

    if (!roots.length) {
      list.innerHTML = '<div class="ss-comment-empty">暂无批注' + (state.commentFilter === 'all' ? '，选中单元格后在下方输入框发表' : '') + '</div>';
    } else {
      var html = '';
      roots.forEach(function (c) {
        html += commentItemHtml(c, false);
        (replyMap[c.id] || []).forEach(function (r) { html += commentItemHtml(r, true); });
      });
      list.innerHTML = html;
    }

    // 未解决数角标
    var badge = $('ssCommentCount');
    if (badge) {
      var open = state.comments.filter(function (c) { return !c.resolved; }).length;
      badge.textContent = open > 99 ? '99+' : String(open);
      badge.hidden = open === 0;
    }
  }

  function commentItemHtml(c, isReply) {
    var locText = c.sheetId !== undefined && c.row !== undefined ? a1(c.row, c.col) : '';
    var sheetText = sheetNames[c.sheetId] || '';
    var taskBadge = '';
    if (c.assignedTo && c.taskStatus && c.taskStatus !== 'none') {
      var done = c.taskStatus === 'done';
      taskBadge = '<span class="ss-task-badge ' + (done ? 'task-done' : 'task-open') + '">' +
        (done ? '✓ 任务已完成' : '任务 · ' + escapeHtml(c.assigneeName || '待处理')) + '</span>';
    }
    var body = escapeHtml(c.content).replace(/@([\w\u4e00-\u9fa5.-]+)/g, '<span class="mention">@$1</span>');
    var mine = c.userId === CFG.user.id;
    var canManage = CFG.permLevel >= 4;
    var actions = [];
    actions.push('<button type="button" class="ss-mini-btn" data-act="reply" data-id="' + c.id + '">回复</button>');
    if (c.resolved) {
      if (mine || canManage || CFG.permLevel >= 2) actions.push('<button type="button" class="ss-mini-btn" data-act="unresolve" data-id="' + c.id + '">重新打开</button>');
    } else {
      actions.push('<button type="button" class="ss-mini-btn" data-act="resolve" data-id="' + c.id + '">标记解决</button>');
    }
    if (c.assignedTo && c.taskStatus !== 'none') {
      var isAssignee = c.assignedTo === CFG.user.id;
      if (isAssignee || mine || canManage) {
        actions.push('<button type="button" class="ss-mini-btn" data-act="task" data-id="' + c.id + '">' +
          (c.taskStatus === 'done' ? '重开任务' : '完成任务') + '</button>');
      }
    }
    if (mine || canManage) {
      actions.push('<button type="button" class="ss-mini-btn danger" data-act="delete" data-id="' + c.id + '">删除</button>');
    }
    return '' +
      '<div class="ss-comment-item' + (isReply ? ' is-reply' : '') + (c.resolved ? ' is-resolved' : '') + '" data-cid="' + c.id + '">' +
      '<div class="ss-comment-head">' +
      '<span class="ss-comment-author">' + escapeHtml(c.username || '用户') + '</span>' +
      (locText ? '<span class="ss-comment-loc" data-loc="' + escapeHtml(c.sheetId) + '" data-row="' + c.row + '" data-col="' + c.col + '" title="点击定位">' +
        escapeHtml(sheetText ? sheetText + '!' : '') + locText + '</span>' + taskBadge : taskBadge) +
      '<span>' + fmtTime(c.createdAt) + '</span>' +
      '</div>' +
      '<div class="ss-comment-body">' + body + '</div>' +
      (actions.length ? '<div class="ss-comment-actions">' + actions.join('') + '</div>' : '') +
      '<div class="ss-reply-form" hidden><input type="text" class="ss-input" maxlength="1000" placeholder="回复…"><button type="button" class="ss-mini-btn">发送</button></div>' +
      '</div>';
  }

  function bindCommentPanel() {
    var panel = $('ssCommentPanel');
    var list = $('ssCommentList');
    if (!panel || !list) return;

    $('btnSsComments').addEventListener('click', function () {
      // 切换开合：以 state.commentOpen 为准做翻转（此前误写成读取 panel.hidden 再写回，
      // 导致点击永远是无操作、面板无法打开）
      state.commentOpen = !state.commentOpen;
      panel.hidden = !state.commentOpen;
      if (state.commentOpen) {
        ensureUsers().then(loadComments);
      }
    });
    $('ssCommentClose').addEventListener('click', function () {
      panel.hidden = true;
      state.commentOpen = false;
    });

    // 过滤 tabs（简易文本切换）
    var filterBar = document.createElement('div');
    filterBar.className = 'ss-tabs';
    filterBar.style.padding = '8px 12px 0';
    ['all', 'open', 'task'].forEach(function (key) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-tab' + (state.commentFilter === key ? ' is-active' : '');
      b.textContent = key === 'all' ? '全部' : (key === 'open' ? '未解决' : '我的相关');
      b.setAttribute('data-filter', key);
      b.addEventListener('click', function () {
        state.commentFilter = key;
        filterBar.querySelectorAll('.ss-tab').forEach(function (t) {
          t.classList.toggle('is-active', t.getAttribute('data-filter') === key);
        });
        renderComments();
      });
      filterBar.appendChild(b);
    });
    list.parentNode.insertBefore(filterBar, list);

    // 发表（根批注，挂当前选区）
    if (CFG.permLevel < 2) {
      var form = $('ssCommentForm');
      if (form) form.hidden = true;
    } else {
      $('ssCommentSend').addEventListener('click', function () { sendComment(null); });
      $('ssCommentInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendComment(null); }
      });
    }

    // @ 提及用户选择（批注输入区通用）
    initMention();

    // 列表事件委托
    list.addEventListener('click', function (e) {
      var target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.classList.contains('ss-comment-loc')) {
        focusCell(target.getAttribute('data-loc'), parseInt(target.getAttribute('data-row'), 10) || 0, parseInt(target.getAttribute('data-col'), 10) || 0);
        return;
      }
      var btn = target.closest ? target.closest('.ss-mini-btn') : null;
      if (!btn) return;
      var id = parseInt(btn.getAttribute('data-id'), 10);
      var act = btn.getAttribute('data-act');
      if (act === 'reply') {
        var item = btn.closest('.ss-comment-item');
        if (item) {
          var rf = item.querySelector('.ss-reply-form');
          if (rf) {
            rf.hidden = !rf.hidden;
            if (!rf.hidden) {
              var input = rf.querySelector('input');
              if (input) input.focus();
            }
          }
        }
        return;
      }
      if (act === 'resolve' || act === 'unresolve') {
        csrfFetch(API.comments + '/' + id, { method: 'PUT', body: JSON.stringify({ resolved: act === 'resolve' }) })
          .then(loadComments).catch(function (err) { showToast(err.message, 'error'); });
        return;
      }
      if (act === 'task') {
        var c = findComment(id);
        var next = c && c.taskStatus === 'done' ? 'open' : 'done';
        csrfFetch(API.comments + '/' + id, { method: 'PUT', body: JSON.stringify({ taskStatus: next }) })
          .then(loadComments).catch(function (err) { showToast(err.message, 'error'); });
        return;
      }
      if (act === 'delete') {
        openModal({
          title: '删除批注',
          body: '<p>确定删除该批注吗？其下回复将一并删除。</p>',
          actions: [
            { label: '删除', className: 'ss-btn-danger', onClick: function () {
              csrfFetch(API.comments + '/' + id, { method: 'DELETE' })
                .then(loadComments).catch(function (err) { showToast(err.message, 'error'); });
            } },
            { label: '取消' }
          ]
        });
        return;
      }
      // 回复表单内的发送按钮（无 data-act，data-id 由外层解析）
      var replyForm = btn.closest('.ss-reply-form');
      if (replyForm) {
        var pid = parseInt(btn.closest('.ss-comment-item').getAttribute('data-cid'), 10);
        var replyInput = replyForm.querySelector('input');
        sendComment(pid, replyInput, replyForm);
      }
    });
    // 回复输入 Enter 发送
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var target = e.target;
      if (!(target instanceof HTMLElement) || !target.closest) return;
      var rf = target.closest('.ss-reply-form');
      if (rf && target.tagName === 'INPUT') {
        e.preventDefault();
        sendComment(parseInt(rf.closest('.ss-comment-item').getAttribute('data-cid'), 10), target, rf);
      }
    });
  }

  function findComment(id) {
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === id) return state.comments[i];
    }
    return null;
  }

  function sendComment(parentId, inputEl, formEl) {
    var input = inputEl || $('ssCommentInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) { showToast('评论内容不能为空', 'warning'); return; }

    // 解析 /task 指派与 @提及
    var isTask = text.indexOf('/task') === 0;
    var content = isTask ? text.replace(/^\/task\s*/, '').trim() : text;
    var mentions = [];
    state.usersCache.forEach(function (u) {
      if (content.indexOf('@' + u.username) !== -1) mentions.push(u.id);
    });
    var assignedTo = isTask && mentions.length ? mentions[0] : null;

    var anchor = parentId ? (function () {
      var parent = findComment(parentId);
      return parent ? { sheetId: parent.sheetId, row: parent.row, col: parent.col } : getAnchorCell();
    })() : getAnchorCell();

    csrfFetch(API.comments, {
      method: 'POST',
      body: JSON.stringify({
        sheetId: anchor.sheetId, row: anchor.row, col: anchor.col,
        parentId: parentId || null, content: content,
        mentions: mentions, assignedTo: assignedTo
      })
    }).then(function () {
      input.value = '';
      if (formEl) formEl.hidden = true;
      loadComments();
      if (isTask && !mentions.length) showToast('已发送。提示：使用「/task @用户名」可直接指派任务', 'warning');
    }).catch(function (err) { showToast(err.message || '发送失败', 'error'); });
  }

  // ============ 版本历史 ============

  function openVersions() {
    var body = document.createElement('div');
    body.innerHTML = '<div class="ss-inline-loading">加载版本列表…</div>';
    var modal = openModal({ title: '🕘 历史版本', large: true, body: body });
    csrfFetch(API.versions).then(function (json) {
      renderVersionList(body, (json.data && json.data.versions) || [],
        (json.data && json.data.currentVersion) || 0, modal);
    }).catch(function (err) { body.innerHTML = '<p>' + escapeHtml(err.message) + '</p>'; });
  }

  function renderVersionList(body, versions, current, modal) {
    body.innerHTML = '';
    var bar = document.createElement('div');
    bar.className = 'ss-row';
    bar.style.marginBottom = '12px';
    if (CFG.permLevel >= 3) {
      var snapshotBtn = document.createElement('button');
      snapshotBtn.type = 'button';
      snapshotBtn.className = 'ss-btn ss-btn-primary';
      snapshotBtn.textContent = '📌 保存当前版本';
      snapshotBtn.addEventListener('click', function () {
        openModal({
          title: '保存版本快照',
          body: '<div class="ss-field"><label>版本说明</label><input type="text" id="ssSnapDesc" class="ss-input" placeholder="例如：完成销售数据录入"></div>',
          actions: [
            { label: '保存', className: 'ss-btn-primary', onClick: function () {
              var desc = document.getElementById('ssSnapDesc');
              csrfFetch(API.versions, { method: 'POST', body: JSON.stringify({ changeDesc: desc ? desc.value : '' }) })
                .then(function () { showToast('版本快照已保存', 'success'); modal.close(); openVersions(); })
                .catch(function (err) { showToast(err.message, 'error'); });
            } },
            { label: '取消' }
          ]
        });
      });
      bar.appendChild(snapshotBtn);
    }
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ss-btn';
    refresh.textContent = '↻ 刷新';
    refresh.addEventListener('click', function () {
      body.innerHTML = '<div class="ss-inline-loading">加载中…</div>';
      csrfFetch(API.versions).then(function (json) {
        renderVersionList(body, (json.data && json.data.versions) || [],
          (json.data && json.data.currentVersion) || 0, modal);
      }).catch(function (err) { body.innerHTML = '<p>' + escapeHtml(err.message) + '</p>'; });
    });
    bar.appendChild(refresh);
    body.appendChild(bar);

    if (!versions.length) {
      body.insertAdjacentHTML('beforeend', '<div class="ss-inline-loading">暂无历史版本（保存时自动快照）</div>');
      return;
    }
    versions.forEach(function (v) {
      var isCurrent = v.version === current;
      var item = document.createElement('div');
      item.className = 'ss-version-item' + (isCurrent ? ' is-current' : '');
      item.innerHTML =
        '<div class="ss-version-info">' +
        '<div class="ver">v' + v.version + (isCurrent ? '（当前）' : '') + '</div>' +
        '<div class="desc">' + escapeHtml(v.change_desc || '') + '</div>' +
        '<div class="meta">' + escapeHtml(v.username || '') + ' · ' + fmtTime(v.created_at) +
        ' · ' + (v.sheet_count || 0) + ' 表 · ' + formatBytes(v.size_bytes) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button type="button" class="ss-btn" data-view="' + v.version + '">预览</button>' +
        (CFG.permLevel >= 3 && !isCurrent && !state.locked ? '<button type="button" class="ss-btn ss-btn-danger" data-restore="' + v.version + '">恢复</button>' : '') +
        '</div>';
      body.appendChild(item);
    });

    body.addEventListener('click', function (e) {
      var target = e.target;
      if (!(target instanceof HTMLElement) || target.tagName !== 'BUTTON') return;
      var viewV = target.getAttribute('data-view');
      var restoreV = target.getAttribute('data-restore');
      if (viewV) previewVersion(parseInt(viewV, 10));
      if (restoreV) confirmRestore(parseInt(restoreV, 10), modal);
    });
  }

  function previewVersion(version) {
    var body = document.createElement('div');
    body.innerHTML = '<div class="ss-inline-loading">加载版本文档…</div>';
    openModal({ title: '版本 v' + version + ' 预览（只读）', large: true, body: body });
    csrfFetch(API.versions + '/' + version).then(function (json) {
      var data = json.data || {};
      var head = '<p style="font-size:12px;color:#64748b;">' + escapeHtml(data.changeDesc || '') + ' · ' +
        escapeHtml(data.username || '') + ' · ' + fmtTime(data.createdAt) + '</p>';
      body.innerHTML = head + docPreviewHtml(data.doc);
    }).catch(function (err) { body.innerHTML = '<p>' + escapeHtml(err.message) + '</p>'; });
  }

  function docPreviewHtml(doc) {
    if (!doc || !doc.sheetOrder || !doc.sheetOrder.length) return '<p>无数据</p>';
    var html = '';
    doc.sheetOrder.slice(0, 5).forEach(function (sid) {
      var sheet = doc.sheets[sid];
      if (!sheet) return;
      html += '<h4 style="margin:10px 0 6px;font-size:13px;">' + escapeHtml(sheet.name || sid) + '</h4>';
      var cd = sheet.cellData || {};
      var rowKeys = Object.keys(cd).map(Number).sort(function (a, b) { return a - b; }).slice(0, 12);
      if (!rowKeys.length) { html += '<p style="font-size:12px;color:#94a3b8;">（空表）</p>'; return; }
      var maxCol = 0;
      rowKeys.forEach(function (r) {
        Object.keys(cd[r]).forEach(function (ck) {
          var c = Number(ck);
          if (c > maxCol) maxCol = c;
        });
      });
      var width = Math.min(maxCol + 1, 10);
      html += '<table class="ss-preview-table"><tr><th></th>';
      for (var c = 0; c < width; c++) html += '<th>' + colName(c) + '</th>';
      html += '</tr>';
      rowKeys.forEach(function (r) {
        html += '<tr><th>' + (r + 1) + '</th>';
        for (var cc = 0; cc < width; cc++) {
          var cell = cd[r] ? cd[r][cc] : null;
          var v = cell && cell.v !== undefined && cell.v !== null ? cell.v : '';
          var disp = cell && cell.f ? cell.f : v;
          html += '<td>' + escapeHtml(disp) + '</td>';
        }
        html += '</tr>';
      });
      html += '</table>';
    });
    return html;
  }

  function confirmRestore(version, modal) {
    openModal({
      title: '恢复到 v' + version,
      body: '<p>将使用版本 v' + version + ' 的内容覆盖当前文档（当前未保存的修改会丢失），并生成新的版本记录。确定继续吗？</p>',
      actions: [
        { label: '恢复', className: 'ss-btn-primary', onClick: function () {
          csrfFetch(API.versions + '/' + version + '/restore', { method: 'POST' })
            .then(function (json) {
              state.version = (json.data && json.data.version) || state.version;
              state.dirty = false;
              showToast('已恢复到 v' + version, 'success');
              modal.close();
              reloadDoc();
            }).catch(function (err) { showToast(err.message, 'error'); });
        } },
        { label: '取消' }
      ]
    });
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ============ 图表看板 ============

  function openCharts() {
    state.chartsOpen = true;
    var body = document.createElement('div');
    body.innerHTML = '<div class="ss-inline-loading">加载图表…</div>';
    chartModal = openModal({
      title: '📈 图表看板',
      large: true,
      body: body,
      onClose: function () {
        state.chartsOpen = false;
        var ctx = chartModal;
        chartModal = null;
        disposeModalCharts(ctx);
      }
    });
    loadCharts();
  }

  function loadCharts() {
    if (!chartModal) return;
    var body = chartModal.body;
    csrfFetch(API.charts).then(function (json) {
      renderCharts((json.data && json.data.charts) || []);
    }).catch(function (err) { body.innerHTML = '<p>' + escapeHtml(err.message) + '</p>'; });
  }

  function renderCharts(charts) {
    if (!chartModal) return;
    var body = chartModal.body;
    body.innerHTML = '';

    // 工具栏
    var bar = document.createElement('div');
    bar.className = 'ss-row';
    bar.style.marginBottom = '14px';
    if (CFG.permLevel >= 3) {
      var fromSel = document.createElement('button');
      fromSel.type = 'button';
      fromSel.className = 'ss-btn ss-btn-primary';
      fromSel.textContent = '📊 从当前选区创建图表';
      fromSel.addEventListener('click', buildChartFromSelection);
      bar.appendChild(fromSel);
      var aiBtn = document.createElement('button');
      aiBtn.type = 'button';
      aiBtn.className = 'ss-btn';
      aiBtn.textContent = '✨ AI 智能推荐图表';
      aiBtn.addEventListener('click', aiChart);
      bar.appendChild(aiBtn);
    }
    body.appendChild(bar);

    if (!charts.length) {
      body.insertAdjacentHTML('beforeend', '<div class="ss-inline-loading">暂无图表。选中数据区域后点击「从当前选区创建图表」，或让 AI 推荐一个。</div>');
      return;
    }
    var grid = document.createElement('div');
    grid.className = 'ss-chart-grid';
    body.appendChild(grid);
    charts.forEach(function (ch) {
      var card = document.createElement('div');
      card.className = 'ss-chart-card';
      card.innerHTML =
        '<div class="ss-chart-card-head"><span class="name">' + escapeHtml(ch.name) +
        ' <span style="font-weight:400;color:#94a3b8;font-size:11px;">' + escapeHtml(ch.chart_type) + '</span></span>' +
        '<div class="ss-chart-actions">' +
        (CFG.permLevel >= 3 ? '<button type="button" class="ss-mini-btn" data-rename="' + ch.id + '">重命名</button>' +
          '<button type="button" class="ss-mini-btn danger" data-del="' + ch.id + '">删除</button>' : '') +
        '</div></div>';
      var canvas = document.createElement('div');
      canvas.className = 'ss-chart-canvas';
      card.appendChild(canvas);
      grid.appendChild(card);
      drawChart(canvas, ch.chart_type, ch.config, ch.name);
    });

    body.addEventListener('click', function (e) {
      var target = e.target;
      if (!(target instanceof HTMLElement) || target.tagName !== 'BUTTON') return;
      var delId = target.getAttribute('data-del');
      var renameId = target.getAttribute('data-rename');
      if (delId) deleteChart(parseInt(delId, 10));
      if (renameId) renameChart(parseInt(renameId, 10));
    });
  }

  function drawChart(canvasEl, type, config, name, ctx) {
    if (!BUNDLE || !BUNDLE.echarts) return null;
    try {
      var ec = BUNDLE.echarts.init(canvasEl, null, { renderer: 'canvas' });
      ec.setOption(chartOption(type, config, name));
      var target = ctx || chartModal;
      if (target) (target.ec = target.ec || []).push(ec);
      return ec;
    } catch (e) { return null; }
  }

  function disposeModalCharts(ctx) {
    if (ctx && ctx.ec) {
      ctx.ec.forEach(function (inst) { try { inst.dispose(); } catch (e) { /* 忽略 */ } });
      ctx.ec = [];
    }
  }

  function normalizeSeriesType(chartType, seriesType) {
    var t = String(seriesType || chartType || 'bar');
    if (t === 'area') return 'line';
    if (t === 'combo') return 'bar';
    return t;
  }

  function chartOption(chartType, config, name) {
    var cfg = config || {};
    var categories = Array.isArray(cfg.categories) ? cfg.categories : [];
    var seriesIn = Array.isArray(cfg.series) ? cfg.series : [];
    var type = String(chartType || 'bar');
    var option = {
      title: { text: name || '', left: 'center', top: 4, textStyle: { fontSize: 12, color: '#334155' } },
      tooltip: { trigger: type === 'pie' || type === 'scatter' ? 'item' : 'axis' },
      series: []
    };
    if (type === 'pie') {
      option.series = seriesIn.slice(0, 1).map(function (s) {
        var data = (s.data || []).map(function (v, i) {
          return { name: String(categories[i] !== undefined ? categories[i] : ('项' + (i + 1))), value: Number(v) || 0 };
        });
        return { name: s.name || '', type: 'pie', radius: ['32%', '62%'], center: ['50%', '56%'], data: data };
      });
      return option;
    }
    if (type === 'radar') {
      var values = [];
      seriesIn.forEach(function (s) { (s.data || []).forEach(function (v) { values.push(Number(v) || 0); }); });
      var max = Math.max.apply(null, values.concat([1])) * 1.2;
      option.radar = {
        indicator: categories.map(function (c) { return { name: String(c), max: max }; }),
        radius: '62%', center: ['50%', '58%']
      };
      option.series = seriesIn.map(function (s) {
        return { name: s.name || '', type: 'radar', data: [{ value: (s.data || []).map(function (v) { return Number(v) || 0; }), name: s.name || '' }] };
      });
      return option;
    }
    option.legend = { top: 26, textStyle: { fontSize: 11 } };
    option.grid = { left: 44, right: 20, top: 50, bottom: 30 };
    option.xAxis = { type: 'category', data: categories.map(String) };
    option.yAxis = { type: 'value' };
    option.series = seriesIn.map(function (s) {
      var st = normalizeSeriesType(type, s.type);
      var base = { name: s.name || '', type: st, data: (s.data || []).map(function (v) { return Number(v) || 0; }) };
      if (type === 'area') base.areaStyle = { opacity: 0.25 };
      return base;
    });
    return option;
  }

  function deleteChart(id) {
    openModal({
      title: '删除图表',
      body: '<p>确定删除该图表吗？</p>',
      actions: [
        { label: '删除', className: 'ss-btn-danger', onClick: function () {
          csrfFetch(API.charts + '/' + id, { method: 'DELETE' })
            .then(function () { showToast('图表已删除', 'success'); loadCharts(); })
            .catch(function (err) { showToast(err.message, 'error'); });
        } },
        { label: '取消' }
      ]
    });
  }

  function renameChart(id) {
    openModal({
      title: '重命名图表',
      body: '<div class="ss-field"><label>图表名称</label><input type="text" id="ssChartName" class="ss-input" maxlength="100"></div>',
      actions: [
        { label: '保存', className: 'ss-btn-primary', onClick: function () {
          var input = document.getElementById('ssChartName');
          var name = input ? input.value.trim() : '';
          if (!name) { showToast('名称不能为空', 'warning'); return false; }
          csrfFetch(API.charts + '/' + id, { method: 'PUT', body: JSON.stringify({ name: name }) })
            .then(function () { showToast('已重命名', 'success'); loadCharts(); })
            .catch(function (err) { showToast(err.message, 'error'); });
        } },
        { label: '取消' }
      ]
    });
  }

  /** 从当前选区构建图表数据：首行表头 → 系列名；首列标签 → categories */
  function buildChartFromSelection() {
    var rect = getActiveRangeRect();
    if (!rect) { showToast('请先选中数据区域', 'warning'); return; }
    var rows = rect.endRow - rect.startRow + 1;
    var cols = rect.endColumn - rect.startColumn + 1;
    if (rows < 2 || cols < 2) { showToast('选区太小：需要至少 2 行 2 列（首行表头 + 首列标签）', 'warning'); return; }
    var doc = extractDoc();
    if (!doc) return;
    var sid = activeSheetId();
    var sheet = doc.sheets[sid] || doc.sheets[doc.sheetOrder[0]];
    if (!sheet) { showToast('工作表不存在', 'error'); return; }
    var cd = sheet.cellData || {};
    function val(r, c) {
      var cell = cd[r] ? cd[r][c] : null;
      if (!cell) return '';
      return cell.v !== undefined && cell.v !== null ? cell.v : (cell.f || '');
    }
    var header = [];
    for (var c = rect.startColumn + 1; c < rect.startColumn + cols; c++) header.push(String(val(rect.startRow, c) || ('系列' + (c - rect.startColumn))));
    var categories = [];
    for (var r = rect.startRow + 1; r < rect.startRow + rows; r++) categories.push(String(val(r, rect.startColumn)));
    var series = [];
    for (var si = 0; si < header.length; si++) {
      var col = rect.startColumn + 1 + si;
      var data = [];
      for (var rr = rect.startRow + 1; rr < rect.startRow + rows; rr++) {
        var v = Number(val(rr, col));
        data.push(isFinite(v) ? v : 0);
      }
      series.push({ name: header[si], type: '', data: data });
    }
    var config = { categories: categories, series: series };

    var body = document.createElement('div');
    var canvas = document.createElement('div');
    canvas.style.height = '260px';
    body.innerHTML = '<div class="ss-field"><label>图表名称</label><input type="text" id="ssNewChartName" class="ss-input" value="' + escapeHtml(sheet.name + ' 图表') + '" maxlength="100"></div>' +
      '<div class="ss-field"><label>图表类型</label><select id="ssNewChartType" class="ss-input">' +
      ['bar', 'line', 'pie', 'scatter', 'area', 'radar', 'combo'].map(function (t) {
        return '<option value="' + t + '">' + t + '</option>';
      }).join('') + '</select></div>';
    body.appendChild(canvas);
    var modalCtx = { ec: [] };
    drawChart(canvas, 'bar', config, '', modalCtx);
    var typeSel = body.querySelector('#ssNewChartType');
    typeSel.addEventListener('change', function () {
      disposeModalCharts(modalCtx);
      canvas.innerHTML = '';
      drawChart(canvas, typeSel.value, config, '', modalCtx);
    });
    openModal({
      title: '从选区创建图表',
      large: true,
      body: body,
      onClose: function () { disposeModalCharts(modalCtx); },
      actions: [
        { label: '保存到看板', className: 'ss-btn-primary', onClick: function () {
          var nameInput = document.getElementById('ssNewChartName');
          var typeVal = typeSel.value;
          csrfFetch(API.charts, {
            method: 'POST',
            body: JSON.stringify({ sheetId: sid, name: nameInput ? nameInput.value.trim() : '图表', chartType: typeVal, config: config, anchor: {} })
          }).then(function () {
            showToast('图表已保存', 'success');
            if (chartModal) loadCharts();
          }).catch(function (err) { showToast(err.message, 'error'); return false; });
        } },
        { label: '取消' }
      ]
    });
  }

  function aiChart() {
    if (!chartModal) {
      state.chartsOpen = true;
      chartModal = openModal({
        title: '✨ AI 智能图表',
        large: true,
        body: document.createElement('div'),
        onClose: function () {
          state.chartsOpen = false;
          var ctx = chartModal;
          chartModal = null;
          disposeModalCharts(ctx);
        }
      });
    }
    var body = chartModal.body;
    body.innerHTML = '<div class="ss-inline-loading">AI 正在分析数据并推荐图表…</div>';
    csrfFetch(API.ai.chart, { method: 'POST', body: JSON.stringify({ sheetId: activeSheetId() }) })
      .then(function (json) {
        var data = json.data || {};
        var config = data.config || {};
        body.innerHTML =
          '<p style="margin:0 0 10px;">✨ <b>' + escapeHtml(data.name || 'AI 推荐图表') + '</b>（' + escapeHtml(data.chartType || '') + '）</p>' +
          '<p style="margin:0 0 12px;color:#64748b;font-size:13px;">' + escapeHtml(data.reason || '') + '</p>';
        var canvas = document.createElement('div');
        canvas.style.height = '300px';
        body.appendChild(canvas);
        drawChart(canvas, data.chartType, config, data.name);
        var bar = document.createElement('div');
        bar.style.marginTop = '14px';
        if (CFG.permLevel >= 3) {
          var saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.className = 'ss-btn ss-btn-primary';
          saveBtn.textContent = '保存到图表看板';
          saveBtn.addEventListener('click', function () {
            csrfFetch(API.charts, {
              method: 'POST',
              body: JSON.stringify({
                sheetId: data.sheetId || activeSheetId(), name: data.name || 'AI 推荐图表',
                chartType: data.chartType, config: config, anchor: {}
              })
            }).then(function () {
              showToast('AI 图表已保存', 'success');
              loadCharts();
            }).catch(function (err) { showToast(err.message, 'error'); });
          });
          bar.appendChild(saveBtn);
        }
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ss-btn';
        retry.textContent = '重新生成';
        retry.addEventListener('click', function () { aiChart(); });
        bar.appendChild(retry);
        body.appendChild(bar);
      })
      .catch(function (err) {
        body.innerHTML = '<p class="ss-inline-error">AI 图表生成失败：' + escapeHtml(err.message || '未知错误') + '</p>';
        var retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'ss-btn';
        retryBtn.style.marginTop = '10px';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', function () { aiChart(); });
        body.appendChild(retryBtn);
      });
  }

  // ============ AI 助手面板 ============

  var AI_TABS = [
    { key: 'formula', label: '🧮 公式', minPerm: 2 },
    { key: 'generate', label: '📋 生成表格', minPerm: 3 },
    { key: 'clean', label: '🧹 数据清洗', minPerm: 2 },
    { key: 'report', label: '📄 分析报告', minPerm: 2 },
    { key: 'chart', label: '✨ 智能图表', minPerm: 2 }
  ];

  function openAi() {
    var body = document.createElement('div');
    if (CFG.permLevel < 2) {
      body.innerHTML = '<p style="margin:0;">AI 助手至少需要「评论」权限。您当前为只读用户，可通过工具栏「🔓 申请权限」提交申请。</p>';
      openModal({ title: '🤖 AI 助手', body: body });
      return;
    }
    var tabs = AI_TABS.filter(function (t) { return CFG.permLevel >= t.minPerm; });
    var tabsHtml = tabs.map(function (t, i) {
      return '<button type="button" class="ss-tab' + (i === 0 ? ' is-active' : '') + '" data-tab="' + t.key + '">' + t.label + '</button>';
    }).join('');
    body.innerHTML = '<div class="ss-tabs">' + tabsHtml + '</div><div class="ss-tab-body"></div>';
    var content = body.querySelector('.ss-tab-body');
    openModal({ title: '🤖 AI 助手', large: true, body: body });
    body.querySelectorAll('.ss-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        body.querySelectorAll('.ss-tab').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        renderAiTab(btn.getAttribute('data-tab'), content);
      });
    });
    if (tabs.length) renderAiTab(tabs[0].key, content);
  }

  function renderAiTab(key, content) {
    content.innerHTML = '';
    if (key === 'formula') renderFormulaTab(content);
    else if (key === 'generate') renderGenerateTab(content);
    else if (key === 'clean') renderCleanTab(content);
    else if (key === 'report') renderReportTab(content);
    else if (key === 'chart') renderChartTab(content);
  }

  function renderFormulaTab(content) {
    var anchor = getAnchorCell();
    var loc = a1(anchor.row, anchor.col);
    content.innerHTML =
      '<div class="ss-field"><label>描述您想要的计算</label>' +
      '<textarea class="ss-input" rows="3" id="ssAiPrompt" maxlength="2000" placeholder="例如：计算每一行 B 到 E 列的平均值"></textarea></div>' +
      '<p class="ss-hint" id="ssAiLoc">AI 结果将写入当前选中单元格：' + loc + '</p>' +
      '<div><button type="button" id="ssAiGo" class="ss-btn ss-btn-primary">生成公式</button></div>' +
      '<div id="ssAiResult"></div>';
    var result = content.querySelector('#ssAiResult');
    content.querySelector('#ssAiGo').addEventListener('click', function () {
      var prompt = content.querySelector('#ssAiPrompt').value.trim();
      if (!prompt) { showToast('请先描述您的需求', 'warning'); return; }
      result.innerHTML = '<div class="ss-inline-loading">AI 生成中…</div>';
      csrfFetch(API.ai.formula, {
        method: 'POST',
        body: JSON.stringify({ prompt: prompt, sheetId: anchor.sheetId, currentCell: loc })
      }).then(function (json) {
        var formula = (json.data && json.data.formula) || '';
        result.innerHTML =
          '<div class="ss-field"><label>AI 结果</label><code class="ss-ai-formula" id="ssAiFormula">' + escapeHtml(formula) + '</code></div>' +
          '<div><button type="button" class="ss-btn" id="ssAiCopy">复制</button>' +
          (CFG.canEdit && !state.locked ? ' <button type="button" class="ss-btn ss-btn-primary" id="ssAiInsert">写入 ' + loc + '</button>' : '') +
          '</div>';
        result.querySelector('#ssAiCopy').addEventListener('click', function () {
          copyText(formula).then(function (ok) {
            showToast(ok ? '公式已复制' : '复制失败', ok ? 'success' : 'error');
          });
        });
        var insertBtn = result.querySelector('#ssAiInsert');
        if (insertBtn) {
          insertBtn.addEventListener('click', function () {
            insertFormulaToCell(anchor.sheetId, anchor.row, anchor.col, formula, loc);
          });
        }
      }).catch(function (err) {
        result.innerHTML = '<p class="ss-inline-error">生成失败：' + escapeHtml(err.message || '未知错误') + '</p>';
      });
    });
  }

  function renderGenerateTab(content) {
    content.innerHTML =
      '<div class="ss-field"><label>描述要生成的表格（主题、列、行数）</label>' +
      '<textarea class="ss-input" rows="3" id="ssGenPrompt" maxlength="2000" placeholder="例如：生成 2024 年 1-6 月销售计划表，列为月份、目标、实际、达成率"></textarea></div>' +
      '<div><button type="button" id="ssGenGo" class="ss-btn ss-btn-primary">生成</button></div>' +
      '<div id="ssGenResult"></div>';
    var result = content.querySelector('#ssGenResult');
    content.querySelector('#ssGenGo').addEventListener('click', function () {
      var prompt = content.querySelector('#ssGenPrompt').value.trim();
      if (!prompt) { showToast('请先描述要生成的表格', 'warning'); return; }
      result.innerHTML = '<div class="ss-inline-loading">AI 生成中…</div>';
      csrfFetch(API.ai.generate, { method: 'POST', body: JSON.stringify({ prompt: prompt }) })
        .then(function (json) {
          var sheets = (json.data && json.data.sheets) || [];
          if (!sheets.length) {
            result.innerHTML = '<p class="ss-inline-error">AI 未返回有效数据，请换一种描述再试</p>';
            return;
          }
          result.innerHTML = '<p class="ss-hint">AI 返回 ' + sheets.length + ' 个工作表，确认后插入：</p>';
          sheets.forEach(function (s, idx) {
            var label = s.name || ('工作表 ' + (idx + 1));
            var block = document.createElement('div');
            block.className = 'ss-preview-block';
            var head = document.createElement('div');
            head.className = 'ss-preview-head';
            head.innerHTML = '<b>' + escapeHtml(label) + '</b><span class="ss-hint">' +
              ((s.data && s.data.length) || 0) + ' 行</span>';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ss-btn ss-btn-primary';
            btn.textContent = '插入为新工作表';
            btn.addEventListener('click', function () {
              insertSheetFromMatrix(label, s.data || []);
            });
            head.appendChild(btn);
            block.appendChild(head);
            block.appendChild(previewMatrix(s.data || []));
            result.appendChild(block);
          });
        })
        .catch(function (err) {
          result.innerHTML = '<p class="ss-inline-error">生成失败：' + escapeHtml(err.message || '未知错误') + '</p>';
        });
    });
  }

  function renderCleanTab(content) {
    content.innerHTML =
      '<p class="ss-hint" style="margin:0 0 10px;">AI 将分析当前工作表数据，标准化格式、清理空行与异常值。清洗结果可覆盖写回（自动创建版本快照，可从版本历史恢复）。</p>' +
      '<div><button type="button" id="ssCleanGo" class="ss-btn ss-btn-primary">分析当前工作表</button></div>' +
      '<div id="ssCleanResult"></div>';
    var result = content.querySelector('#ssCleanResult');
    content.querySelector('#ssCleanGo').addEventListener('click', function () {
      result.innerHTML = '<div class="ss-inline-loading">AI 分析中…</div>';
      var sid = activeSheetId();
      csrfFetch(API.ai.analyze, { method: 'POST', body: JSON.stringify({ task: 'clean', sheetId: sid }) })
        .then(function (json) {
          var data = json.data || {};
          var sheets = data.sheets || [];
          if (!sheets.length) {
            result.innerHTML = '<p class="ss-inline-error">AI 未返回清洗结果</p>';
            return;
          }
          result.innerHTML = '<b style="display:block;margin:0 0 6px;">清洗说明</b>';
          result.appendChild(renderMd(data.notes || ''));
          sheets.forEach(function (s, idx) {
            var label = s.name || ('清洗结果 ' + (idx + 1));
            var block = document.createElement('div');
            block.className = 'ss-preview-block';
            var head = document.createElement('div');
            head.className = 'ss-preview-head';
            head.innerHTML = '<b>' + escapeHtml(label) + '</b>';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ss-btn ss-btn-primary';
            btn.textContent = '覆盖写入当前工作表';
            btn.addEventListener('click', function () {
              applyCleanedData(sid, s.data || [], label);
            });
            head.appendChild(btn);
            block.appendChild(head);
            block.appendChild(previewMatrix(s.data || []));
            result.appendChild(block);
          });
        })
        .catch(function (err) {
          result.innerHTML = '<p class="ss-inline-error">清洗失败：' + escapeHtml(err.message || '未知错误') + '</p>';
        });
    });
  }

  function renderReportTab(content) {
    content.innerHTML =
      '<div class="ss-field"><label>分析类型</label><select id="ssReportKind" class="ss-input">' +
      '<option value="summarize">快速摘要（要点式）</option>' +
      '<option value="analyze">深度分析（概览 / 统计 / 质量 / 建议）</option>' +
      '</select></div>' +
      '<div style="margin-top:10px;"><button type="button" id="ssReportGo" class="ss-btn ss-btn-primary">生成报告</button></div>' +
      '<div id="ssReportResult"></div>';
    var result = content.querySelector('#ssReportResult');
    content.querySelector('#ssReportGo').addEventListener('click', function () {
      var kind = content.querySelector('#ssReportKind').value;
      result.innerHTML = '<div class="ss-inline-loading">AI 分析中（可能需要数十秒）…</div>';
      csrfFetch(API.ai.analyze, { method: 'POST', body: JSON.stringify({ task: kind, sheetId: activeSheetId() }) })
        .then(function (json) {
          result.innerHTML = '';
          result.appendChild(renderMd((json.data && json.data.report) || '（AI 未返回内容）'));
        })
        .catch(function (err) {
          result.innerHTML = '<p class="ss-inline-error">生成失败：' + escapeHtml(err.message || '未知错误') + '</p>';
        });
    });
  }

  function renderChartTab(content) {
    content.innerHTML =
      '<p style="margin:0 0 12px;">AI 将自动分析当前工作表数据，推荐最合适的图表类型、命名并说明推荐理由，可直接预览与保存。</p>' +
      '<button type="button" id="ssAiChartGo" class="ss-btn ss-btn-primary">✨ 生成 AI 推荐图表</button>';
    content.querySelector('#ssAiChartGo').addEventListener('click', function () { aiChart(); });
  }

  /** 将 AI 公式写入指定单元格（命令方式，自动触发标脏与实时同步） */
  function insertFormulaToCell(sheetId, row, col, formula, loc) {
    if (!wb || !univerAPI) return;
    var f = String(formula || '');
    if (f.charAt(0) !== '=') f = '=' + f;
    try {
      var cellValue = {};
      cellValue[row] = {};
      cellValue[row][col] = { f: f };
      // 同 scanCellValuesForLinks：SetRangeValues 命令依赖选区会忽略 cellValue，须走 mutation
      univerAPI.syncExecuteCommand('sheet.mutation.set-range-values', {
        unitId: wb.id,
        subUnitId: sheetId,
        cellValue: cellValue
      });
      showToast('公式已写入 ' + loc, 'success');
    } catch (e) {
      showToast('写入公式失败', 'error');
    }
  }

  // ============ 数据预览 / Markdown 渲染 ============

  function previewRow(row) {
    var tr = document.createElement('tr');
    (row || []).forEach(function (v) {
      var td = document.createElement('td');
      td.textContent = v === null || v === undefined ? '' : String(v);
      tr.appendChild(td);
    });
    return tr;
  }

  function previewMatrix(rows) {
    var wrap = document.createElement('div');
    if (!rows || !rows.length) {
      wrap.innerHTML = '<p class="ss-hint">（空）</p>';
      return wrap;
    }
    var table = document.createElement('table');
    table.className = 'ss-preview-table';
    var thead = document.createElement('thead');
    thead.appendChild(previewRow(rows[0]).cloneNode(true));
    var thRow = document.createElement('tr');
    (rows[0] || []).forEach(function () {
      var th = document.createElement('th');
      thRow.appendChild(th);
    });
    // 用首行值填充表头
    var firstRow = rows[0] || [];
    for (var hc = 0; hc < firstRow.length; hc++) {
      thRow.children[hc].textContent = firstRow[hc] === null || firstRow[hc] === undefined ? '' : String(firstRow[hc]);
    }
    thead.innerHTML = '';
    thead.appendChild(thRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var maxRows = Math.min(rows.length, 20);
    for (var i = 1; i < maxRows; i++) {
      tbody.appendChild(previewRow(rows[i]));
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (rows.length > 20) {
      var tip = document.createElement('p');
      tip.className = 'ss-hint';
      tip.textContent = '仅预览前 20 行（共 ' + rows.length + ' 行）';
      wrap.appendChild(tip);
    }
    return wrap;
  }

  /** 轻量 Markdown 渲染（标题/列表/代码块/粗斜体/行内代码/链接），输入已防 XSS */
  function renderMd(text) {
    var wrap = document.createElement('div');
    wrap.className = 'ss-md-report';
    var src = String(text || '');
    if (!src.trim()) {
      wrap.textContent = '（无内容）';
      return wrap;
    }

    // 抽出代码块占位，避免内部被格式化
    var codeBlocks = [];
    src = src.replace(/```([\s\S]*?)```/g, function (m, code) {
      codeBlocks.push(String(code).replace(/^[^\n]*\n/, '').replace(/\n$/, ''));
      return '@@CODE' + (codeBlocks.length - 1) + '@@';
    });

    var lines = src.split(/\r?\n/);
    var listBuf = null; // 当前列表容器（ul/ol）
    var paraBuf = [];

    function flushPara() {
      if (!paraBuf.length) return;
      var p = document.createElement('p');
      p.innerHTML = inlineMd(paraBuf.join(' '));
      wrap.appendChild(p);
      paraBuf = [];
    }

    lines.forEach(function (line) {
      var t = line.trim();
      var m;
      if (!t) {
        flushPara();
        listBuf = null;
        return;
      }
      if ((m = t.match(/^@@CODE(\d+)@@$/))) {
        flushPara();
        listBuf = null;
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.textContent = codeBlocks[Number(m[1])] || '';
        pre.appendChild(code);
        wrap.appendChild(pre);
        return;
      }
      if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara();
        listBuf = null;
        var h = document.createElement('h' + Math.min(m[1].length + 2, 6));
        h.innerHTML = inlineMd(m[2]);
        wrap.appendChild(h);
        return;
      }
      if (/^([-*_])(\s*\1){2,}[\s\-*_]*$/.test(t)) {
        flushPara();
        listBuf = null;
        wrap.appendChild(document.createElement('hr'));
        return;
      }
      if ((m = t.match(/^[-*+]\s+(.*)$/))) {
        flushPara();
        if (!listBuf || listBuf.tagName !== 'UL') {
          listBuf = document.createElement('ul');
          wrap.appendChild(listBuf);
        }
        var li = document.createElement('li');
        li.innerHTML = inlineMd(m[1]);
        listBuf.appendChild(li);
        return;
      }
      if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!listBuf || listBuf.tagName !== 'OL') {
          listBuf = document.createElement('ol');
          wrap.appendChild(listBuf);
        }
        var li2 = document.createElement('li');
        li2.innerHTML = inlineMd(m[2]);
        listBuf.appendChild(li2);
        return;
      }
      paraBuf.push(t);
    });
    flushPara();
    return wrap;
  }

  function inlineMd(s) {
    var out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return out;
  }

  // ============ AI 结果写入文档 ============

  function matrixToCellData(rows) {
    var cellData = {};
    (rows || []).forEach(function (row, r) {
      (row || []).forEach(function (v, c) {
        if (v === null || v === undefined || v === '') return;
        var cell = {};
        if (typeof v === 'number' && isFinite(v)) cell.v = v;
        else cell.v = String(v);
        if (!cellData[r]) cellData[r] = {};
        cellData[r][c] = cell;
      });
    });
    return cellData;
  }

  /** 直接整档保存（用于 AI 结构性写入；成功后调用方自行 reloadDoc） */
  function saveDocDirect(doc, changeDesc) {
    if (state.saving) return Promise.reject(new Error('正在保存，请稍候'));
    var body = JSON.stringify({
      doc: doc,
      baseVersion: state.version,
      structural: true,
      snapshot: true,
      changeDesc: changeDesc
    });
    if (!checkDocBodySize(body)) return Promise.reject(new Error('文档数据超过 50MB 服务器上限'));
    state.saving = true;
    setSaveStatus('is-saving', '保存中…');
    return csrfFetch(API.doc, {
      method: 'PUT',
      body: body
    }).then(function (json) {
      state.saving = false;
      state.dirty = false;
      state.structural = false;
      state.version = (json.data && json.data.version) || state.version;
      setSaveStatus('is-saved', '已保存 v' + state.version);
      return state.version;
    }).catch(function (err) {
      state.saving = false;
      if (err.status === 409) {
        handleConflict(err.data);
      } else {
        setSaveStatus('is-error', '保存失败');
        showToast(err.message || '保存失败', 'error');
      }
      throw err;
    });
  }

  function insertSheetFromMatrix(name, rows) {
    if (!CFG.canEdit || state.locked) {
      showToast('当前为只读模式，无法插入', 'warning');
      return;
    }
    var doc = extractDoc();
    if (!doc) { showToast('无法提取文档数据', 'error'); return; }
    var sheets = doc.sheets = doc.sheets || {};
    var existing = {};
    Object.keys(sheets).forEach(function (sid) { existing[sheets[sid].name] = sid; });
    var base = String(name || '新工作表').slice(0, 30);
    var finalName = base;
    var n = 2;
    while (existing[finalName]) {
      finalName = base.slice(0, 28) + '-' + n;
      n++;
    }
    var sid = 'sheet-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    var data = rows || [];
    sheets[sid] = {
      id: sid,
      name: finalName,
      tabColor: '',
      hidden: 0,
      freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      rowCount: Math.max(data.length + 20, 100),
      columnCount: 40,
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData: [],
      cellData: matrixToCellData(data),
      rowData: {},
      columnData: {},
      rowHeader: { width: 46 },
      columnHeader: { height: 20 },
      showGridlines: 1,
      rightToLeft: 0
    };
    doc.sheetOrder = (doc.sheetOrder || []).concat([sid]);
    doc.rev = (doc.rev || 1) + 1;
    saveDocDirect(doc, 'AI 生成：' + finalName).then(function () {
      showToast('已插入工作表「' + finalName + '」', 'success');
      reloadDoc();
    }).catch(function () { /* 错误已在 saveDocDirect 提示 */ });
  }

  function applyCleanedData(sheetId, rows, label) {
    if (!CFG.canEdit || state.locked) {
      showToast('当前为只读模式，无法写入', 'warning');
      return;
    }
    var doc = extractDoc();
    if (!doc) { showToast('无法提取文档数据', 'error'); return; }
    var sheet = (doc.sheets || {})[sheetId];
    if (!sheet) { showToast('目标工作表不存在', 'error'); return; }
    var sheetLabel = sheet.name || label || '当前工作表';
    openModal({
      title: '覆盖写入确认',
      body: '<p>将用 AI 清洗后的数据（' + (rows ? rows.length : 0) + ' 行）<b>完全覆盖</b>「' +
        escapeHtml(sheetLabel) + '」的全部现有内容。</p>' +
        '<p class="ss-hint">覆盖前会自动创建版本快照，可从版本历史恢复。</p>',
      actions: [
        { label: '覆盖写入', className: 'ss-btn-primary', onClick: function () {
          sheet.cellData = matrixToCellData(rows || []);
          sheet.rowData = {};
          sheet.rowCount = Math.max((rows || []).length + 20, 100);
          doc.rev = (doc.rev || 1) + 1;
          saveDocDirect(doc, 'AI 清洗：' + sheetLabel).then(function () {
            showToast('清洗数据已写入', 'success');
            reloadDoc();
          }).catch(function () { /* 错误已在 saveDocDirect 提示 */ });
        } },
        { label: '取消' }
      ]
    });
  }

  // ============ 分享 ============

  function openShare() {
    var body = document.createElement('div');
    body.innerHTML = '<div class="ss-inline-loading">加载分享状态…</div>';
    openModal({ title: '🔗 分享链接', body: body });
    csrfFetch(API.share).then(function (json) {
      renderShare(body, json.data || {});
    }).catch(function (err) {
      body.innerHTML = '<p class="ss-inline-error">' + escapeHtml(err.message || '加载失败') + '</p>';
    });
  }

  function absoluteUrl(path) {
    return location.origin + String(path || '');
  }

  function renderShare(body, d) {
    if (!d.shared) {
      body.innerHTML =
        '<p style="margin:0 0 8px;">开启后，任何人都可以通过链接查看此表格（无需登录）。</p>' +
        '<p class="ss-hint" style="margin:0 0 14px;">分享页为只读预览，仅支持在线查看，不允许下载。</p>';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ss-btn ss-btn-primary';
      btn.textContent = '开启分享';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        csrfFetch(API.share, { method: 'POST' }).then(function (json) {
          showToast('分享已开启', 'success');
          renderShare(body, json.data || {});
        }).catch(function (err) {
          btn.disabled = false;
          showToast(err.message, 'error');
        });
      });
      body.appendChild(btn);
      return;
    }
    var link = absoluteUrl(d.url);
    var embedCode = '<iframe src="' + absoluteUrl(d.embedUrl) + '" width="100%" height="480" frameborder="0"></iframe>';
    body.innerHTML =
      (d.status !== 1 ? '<p class="ss-inline-error">分享当前处于停用状态。</p>' : '') +
      '<div class="ss-share-stats"><b>浏览 ' + (d.viewCount || 0) + '</b>' +
      (d.createdAt ? '<span>创建于 ' + escapeHtml(fmtTime(d.createdAt)) + '</span>' : '') + '</div>' +
      '<div class="ss-field"><label>分享链接</label><div class="ss-share-link-row">' +
      '<input type="text" class="ss-input" id="ssShareLink" readonly value="' + escapeHtml(link) + '">' +
      '<button type="button" class="ss-btn" id="ssShareCopy">复制</button>' +
      '<button type="button" class="ss-btn" id="ssShareOpen">打开</button></div></div>' +
      '<div class="ss-field"><label>嵌入代码（iframe）</label>' +
      '<textarea class="ss-input" rows="2" readonly id="ssShareEmbed">' + escapeHtml(embedCode) + '</textarea></div>';
    body.querySelector('#ssShareCopy').addEventListener('click', function () {
      copyText(link).then(function (ok) {
        showToast(ok ? '链接已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error');
      });
    });
    body.querySelector('#ssShareOpen').addEventListener('click', function () {
      window.open(link, '_blank', 'noopener');
    });
    var stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'ss-btn ss-btn-danger';
    stopBtn.style.marginTop = '14px';
    stopBtn.textContent = '停止分享';
    stopBtn.addEventListener('click', function () {
      openModal({
        title: '停止分享',
        body: '<p>停止后分享链接立即失效（统计数据保留）。确定停止分享？</p>',
        actions: [
          { label: '停止分享', className: 'ss-btn-danger', onClick: function () {
            csrfFetch(API.share, { method: 'DELETE' }).then(function () {
              showToast('分享已停止', 'success');
              renderShare(body, { shared: false });
            }).catch(function (err) { showToast(err.message, 'error'); });
          } },
          { label: '取消' }
        ]
      });
    });
    body.appendChild(stopBtn);
  }

  // ============ 权限管理（管理者） ============

  function openPerms() {
    var body = document.createElement('div');
    body.innerHTML = '<div class="ss-inline-loading">加载权限…</div>';
    openModal({ title: '🔒 权限管理', large: true, body: body });
    loadPerms(body);
  }

  function loadPerms(body) {
    Promise.all([csrfFetch(API.permissions), csrfFetch(API.applications), csrfFetch(API.publicRead), csrfFetch(API.users)])
      .then(function (rs) {
        renderPerms(body,
          (rs[0].data && rs[0].data.permissions) || [],
          (rs[1].data && rs[1].data.applications) || [],
          (rs[3].data && rs[3].data.users) || [],
          Boolean(rs[2].data && rs[2].data.enabled));
      })
      .catch(function (err) {
        body.innerHTML = '<p class="ss-inline-error">' + escapeHtml(err.message || '加载失败') + '</p>';
      });
  }

  function renderPerms(body, perms, apps, users, publicRead) {
    body.innerHTML = '';

    // 锁定开关
    var lockLine = document.createElement('div');
    lockLine.className = 'ss-perm-lock';
    lockLine.innerHTML = '<label><input type="checkbox" id="ssLockToggle"' + (state.locked ? ' checked' : '') + '>' +
      '<span>锁定文档（所有人只读，防止误编辑）</span></label>';
    lockLine.querySelector('#ssLockToggle').addEventListener('change', function () {
      var to = this.checked;
      csrfFetch(API.lock, { method: 'POST', body: JSON.stringify({ locked: to }) })
        .then(function () {
          state.locked = to;
          applyEditable();
          showToast(to ? '文档已锁定' : '文档已解锁', 'success');
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          loadPerms(body);
        });
    });
    body.appendChild(lockLine);

    // 公开只读开关：开启后所有登录用户至少可查看（内容保护与水印仍生效）
    var pubLine = document.createElement('div');
    pubLine.className = 'ss-perm-lock';
    pubLine.innerHTML = '<label><input type="checkbox" id="ssPublicReadToggle"' + (publicRead ? ' checked' : '') + '>' +
      '<span>🌐 公开只读（所有登录用户可查看，无需逐个授权）</span></label>';
    pubLine.querySelector('#ssPublicReadToggle').addEventListener('change', function () {
      var to = this.checked;
      var cb = this;
      csrfFetch(API.publicRead, { method: 'POST', body: JSON.stringify({ enabled: to }) })
        .then(function () {
          state.publicRead = to;
          showToast(to ? '已开启公开只读：所有登录用户可查看' : '已关闭公开只读：恢复私有访问', 'success');
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          cb.checked = !to;
        });
    });
    body.appendChild(pubLine);

    // 直接授权（下拉展示全部用户；可授予只读查看 / 评论 / 编辑 / 下载 / 创建副本）
    var grantBox = document.createElement('div');
    grantBox.className = 'ss-perm-grant';
    grantBox.style.margin = '4px 0 14px';
    var grantTitle = document.createElement('h4');
    grantTitle.textContent = '添加授权';
    grantBox.appendChild(grantTitle);
    var grantRow = document.createElement('div');
    grantRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    var grantUser = document.createElement('select');
    grantUser.className = 'ss-input';
    grantUser.style.maxWidth = '220px';
    var grantPh = document.createElement('option');
    grantPh.value = '';
    grantPh.textContent = '—— 选择用户（共 ' + (users.length || 0) + ' 人） ——';
    grantUser.appendChild(grantPh);
    users.forEach(function (u) {
      var o = document.createElement('option');
      o.value = u.id;
      o.textContent = (u.nickname && u.nickname !== u.username)
        ? (u.username + '（' + u.nickname + '）')
        : u.username;
      grantUser.appendChild(o);
    });
    var grantType = document.createElement('select');
    grantType.className = 'ss-input';
    grantType.style.maxWidth = '120px';
    [['view', '只读查看'], ['comment', '评论'], ['edit', '编辑'], ['download', '下载'], ['copy', '创建副本']].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      grantType.appendChild(o);
    });
    var grantBtn = document.createElement('button');
    grantBtn.type = 'button';
    grantBtn.className = 'ss-mini-btn';
    grantBtn.textContent = '授予';
    grantBtn.addEventListener('click', function () {
      var uid = grantUser.value;
      if (!uid) { showToast('请选择要授权的用户', 'warning'); return; }
      grantBtn.disabled = true;
      csrfFetch(API.permissions, { method: 'POST', body: JSON.stringify({ user_id: parseInt(uid, 10), perm_type: grantType.value }) })
        .then(function (json) {
          showToast(json.message || '已授予', 'success');
          grantUser.value = '';
          loadPerms(body);
        })
        .catch(function (err) { showToast(err.message, 'error'); })
        .finally(function () { grantBtn.disabled = false; });
    });
    grantRow.appendChild(grantUser);
    grantRow.appendChild(grantType);
    grantRow.appendChild(grantBtn);
    grantBox.appendChild(grantRow);
    body.appendChild(grantBox);

    // 待审批申请
    var pending = apps.filter(function (a) { return a.status === 'pending'; });
    var h1 = document.createElement('h4');
    h1.textContent = '待审批申请（' + pending.length + '）';
    body.appendChild(h1);
    if (!pending.length) {
      appendHint(body, '暂无待审批申请');
    } else {
      var t1 = document.createElement('table');
      t1.className = 'ss-table';
      t1.innerHTML = '<thead><tr><th>用户</th><th>申请权限</th><th>理由</th><th>时间</th><th>操作</th></tr></thead>';
      var tb1 = document.createElement('tbody');
      pending.forEach(function (a) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(a.username || a.email || ('用户 #' + a.user_id)) + '</td>' +
          '<td>' + escapeHtml(PERM_NAMES[a.perm_type] || a.perm_type) + '</td>' +
          '<td class="ss-cell-reason">' + escapeHtml(a.reason || '—') + '</td>' +
          '<td>' + escapeHtml(fmtTime(a.created_at)) + '</td>' +
          '<td></td>';
        var act = tr.lastElementChild;
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'ss-mini-btn';
        okBtn.textContent = '通过';
        okBtn.addEventListener('click', function () { approveApplication(a.id, true, body); });
        var noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'ss-mini-btn danger';
        noBtn.textContent = '拒绝';
        noBtn.addEventListener('click', function () { approveApplication(a.id, false, body); });
        act.appendChild(okBtn);
        act.appendChild(noBtn);
        tb1.appendChild(tr);
      });
      t1.appendChild(tb1);
      body.appendChild(t1);
    }

    // 已授权用户
    var h2 = document.createElement('h4');
    h2.textContent = '已授权用户（' + perms.length + '）';
    body.appendChild(h2);
    if (!perms.length) {
      appendHint(body, '暂无授权记录（角色继承的权限不在此列）');
    } else {
      var t2 = document.createElement('table');
      t2.className = 'ss-table';
      t2.innerHTML = '<thead><tr><th>用户</th><th>权限</th><th>授权时间</th><th>操作</th></tr></thead>';
      var tb2 = document.createElement('tbody');
      perms.forEach(function (p) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(p.username || p.email || ('用户 #' + p.user_id)) + '</td>' +
          '<td>' + escapeHtml(PERM_NAMES[p.perm_type] || p.perm_type) + '</td>' +
          '<td>' + escapeHtml(fmtTime(p.created_at)) + '</td>' +
          '<td></td>';
        var act = tr.lastElementChild;
        var rvBtn = document.createElement('button');
        rvBtn.type = 'button';
        rvBtn.className = 'ss-mini-btn danger';
        rvBtn.textContent = '撤销';
        rvBtn.addEventListener('click', function () { revokePermission(p, body); });
        act.appendChild(rvBtn);
        tb2.appendChild(tr);
      });
      t2.appendChild(tb2);
      body.appendChild(t2);
    }
  }

  function appendHint(parent, text) {
    var p = document.createElement('p');
    p.className = 'ss-hint';
    p.textContent = text;
    parent.appendChild(p);
  }

  function approveApplication(id, approved, body) {
    csrfFetch(API.approve, { method: 'POST', body: JSON.stringify({ application_id: id, approved: approved }) })
      .then(function (json) {
        showToast(json.message || (approved ? '已通过' : '已拒绝'), 'success');
        loadPerms(body);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  function revokePermission(p, body) {
    openModal({
      title: '撤销权限',
      body: '<p>撤销「' + escapeHtml(p.username || p.email || ('用户 #' + p.user_id)) + '」的「' +
        escapeHtml(PERM_NAMES[p.perm_type] || p.perm_type) + '」权限？</p>',
      actions: [
        { label: '撤销', className: 'ss-btn-danger', onClick: function () {
          csrfFetch(API.revokePerm + '/' + p.user_id, {
            method: 'DELETE',
            body: JSON.stringify({ perm_type: p.perm_type })
          }).then(function () {
            showToast('已撤销', 'success');
            loadPerms(body);
          }).catch(function (err) { showToast(err.message, 'error'); });
        } },
        { label: '取消' }
      ]
    });
  }

  // ============ 权限申请（低权限用户） ============

  function openApplyPerm() {
    var options = [
      { v: 'comment', label: '评论（查看 + 批注 / 任务）' },
      { v: 'download', label: '下载（导出 xlsx / csv）' },
      { v: 'copy', label: '创建副本' },
      { v: 'edit', label: '编辑（读写，可保存）' }
    ];
    var body = document.createElement('div');
    body.innerHTML =
      '<p class="ss-hint" style="margin:0 0 10px;">提交后由文档管理者审批；已有同级或更高权限、有待审批申请时会被拒绝。</p>' +
      '<div class="ss-field"><label>申请权限</label><select id="ssApplyType" class="ss-input">' +
      options.map(function (o) { return '<option value="' + o.v + '">' + escapeHtml(o.label) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="ss-field"><label>申请理由</label>' +
      '<textarea id="ssApplyReason" class="ss-input" rows="3" maxlength="500" placeholder="说明您需要该权限的原因"></textarea></div>';
    openModal({
      title: '🔓 申请更高权限',
      body: body,
      actions: [
        { label: '提交申请', className: 'ss-btn-primary', onClick: function (ctx) {
          var type = body.querySelector('#ssApplyType').value;
          var reason = body.querySelector('#ssApplyReason').value.trim();
          if (!reason) { showToast('请填写申请理由', 'warning'); return false; }
          csrfFetch(API.apply, { method: 'POST', body: JSON.stringify({ perm_type: type, reason: reason }) })
            .then(function (json) {
              showToast(json.message || '已提交申请，等待审批', 'success');
              ctx.close();
            })
            .catch(function (err) { showToast(err.message, 'error'); });
          return false; // 等待请求完成后再关闭
        } },
        { label: '取消' }
      ]
    });
  }

  // ============ 导出 ============

  function openExport() {
    if (CFG.permLevel < 2) {
      showToast('导出需要「下载」或更高权限，可通过「申请权限」获取', 'warning');
      return;
    }
    var body = document.createElement('div');
    var row = document.createElement('div');
    row.className = 'ss-export-row';
    var xlsxBtn = document.createElement('button');
    xlsxBtn.type = 'button';
    xlsxBtn.className = 'ss-btn ss-btn-primary';
    xlsxBtn.textContent = '⬇️ Excel（.xlsx · 全部工作表）';
    xlsxBtn.addEventListener('click', function () { doExport('?format=xlsx'); });
    var csvBtn = document.createElement('button');
    csvBtn.type = 'button';
    csvBtn.className = 'ss-btn';
    csvBtn.textContent = '⬇️ CSV（当前工作表）';
    csvBtn.addEventListener('click', function () {
      doExport('?format=csv&sheetId=' + encodeURIComponent(activeSheetId()));
    });
    row.appendChild(xlsxBtn);
    row.appendChild(csvBtn);
    body.appendChild(row);
    var tip = document.createElement('p');
    tip.className = 'ss-hint';
    tip.textContent = '未保存的修改会先自动保存，随后开始下载。';
    body.appendChild(tip);
    openModal({ title: '⬇️ 导出', body: body });
  }

  function doExport(query) {
    var go = function () { window.location.href = API.export + query; };
    if (state.dirty && CFG.canEdit && !state.locked) {
      saveNow(false);
      setTimeout(go, 800);
    } else {
      go();
    }
  }

  // ============ 表格信息（管理者） ============

  function openMeta() {
    if (!CFG.canManage) return;
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="ss-field"><label>表格名称</label>' +
      '<input type="text" id="ssMetaName" class="ss-input" maxlength="100" value="' + escapeHtml(CFG.name || '') + '"></div>' +
      '<div class="ss-field"><label>描述</label>' +
      '<textarea id="ssMetaDesc" class="ss-input" rows="3" maxlength="500">' + escapeHtml(CFG.description || '') + '</textarea></div>';
    openModal({
      title: '📝 表格信息',
      body: body,
      actions: [
        { label: '保存', className: 'ss-btn-primary', onClick: function (ctx) {
          var name = body.querySelector('#ssMetaName').value.trim();
          var desc = body.querySelector('#ssMetaDesc').value.trim();
          if (!name) { showToast('名称不能为空', 'warning'); return false; }
          csrfFetch(API.meta, { method: 'PUT', body: JSON.stringify({ name: name, description: desc }) })
            .then(function () {
              CFG.name = name;
              CFG.description = desc;
              var h = $('ssDocName');
              if (h) {
                h.textContent = name;
                h.title = desc + '（点击编辑信息）';
              }
              document.title = name + ' - 在线表格';
              showToast('信息已更新', 'success');
              ctx.close();
            })
            .catch(function (err) { showToast(err.message, 'error'); });
          return false;
        } },
        { label: '取消' }
      ]
    });
  }

  // ============ 事件绑定与启动 ============

  function bindUi() {
    bindCommentPanel();

    var saveBtn = $('btnSsSave');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveNow(true); });

    var chartsBtn = $('btnSsCharts');
    if (chartsBtn) chartsBtn.addEventListener('click', function () {
      if (!state.chartsOpen) openCharts();
    });

    var versionsBtn = $('btnSsVersions');
    if (versionsBtn) versionsBtn.addEventListener('click', openVersions);

    var shareBtn = $('btnSsShare');
    if (shareBtn) shareBtn.addEventListener('click', openShare);

    var permsBtn = $('btnSsPerms');
    if (permsBtn) permsBtn.addEventListener('click', openPerms);

    var applyBtn = $('btnSsApplyPerm');
    if (applyBtn) applyBtn.addEventListener('click', openApplyPerm);

    var aiBtn = $('btnSsAi');
    if (aiBtn) aiBtn.addEventListener('click', openAi);

    var exportBtn = $('btnSsExport');
    if (exportBtn) {
      // 只读用户（permLevel<2）隐藏导出入口（服务端导出 API 本就返回 403，双保险）
      if (CFG.permLevel < 2) exportBtn.hidden = true;
      else exportBtn.addEventListener('click', openExport);
    }

    var nameEl = $('ssDocName');
    if (nameEl && CFG.canManage) {
      nameEl.title = (CFG.description || '') + '（点击编辑信息）';
      nameEl.style.cursor = 'pointer';
      nameEl.addEventListener('click', openMeta);
    }

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveNow(true);
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (state.dirty || pendingCellBatches.length) {
        flushCells();
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function boot() {
    bindUi();
    // 调试/自动化测试钩子：仅在 URL 带 #debug 时暴露内部实例与工具（正常访问不可见）
    if (location.hash === '#debug') {
      window.__SS_DEBUG__ = {
        get univerAPI() { return univerAPI; },
        get wb() { return wb; },
        get state() { return state; },
        get cfg() { return CFG; },
        get resolverWrapped() { return hyperLinkResolverWrapped; },
        get resolver() { return hyperLinkResolverSvc; },
        matchCellUrl: matchCellUrl,
        scanCellValuesForLinks: scanCellValuesForLinks,
        handleSheetLinkNavigate: handleSheetLinkNavigate
      };
    }
    if (!initUniver()) return;
    setLoading(true, '正在加载表格…');
    loadDoc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
