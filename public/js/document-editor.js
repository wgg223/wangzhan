/* global UniverBundle */
/**
 * Univer 在线文档编辑器前端逻辑
 * 页面：views/frontend/document-editor.ejs（layout:false，复用 spreadsheet-editor.css）
 * 依赖：/vendor/univer/univer.min.js（全局 UniverBundle，含 Docs presets）
 */
(function () {
  'use strict';

  // ============ 配置与常量 ============

  var CFG = window.__SHEET__ || {};
  var API = CFG.api || {};
  var BUNDLE = UniverBundle;

  var PERM_API = (API.myPerm || '').replace(/\/my$/, '');
  API.apply = PERM_API + '/apply';
  API.applications = PERM_API + '/applications';
  API.approve = PERM_API + '/approve';
  API.revokePerm = PERM_API;

  var AUTO_SAVE_MS = 3000;
  var CHANGES_POLL_MS = 4000;
  var PRESENCE_POLL_MS = 4000;
  var PRESENCE_BEAT_MS = 8000;
  var AVATAR_COLORS = ['#6366f1', '#059669', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#4d7c0f'];
  var PERM_NAMES = { view: '查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };

  // ============ 运行状态 ============

  var univerAPI = null;
  var docInstance = null;
  var cmdServiceWired = false;
  var state = {
    version: CFG.version || 0,
    locked: Boolean(CFG.isLocked),
    publicRead: Boolean(CFG.isPublicRead),
    dirty: false,
    saving: false,
    applyingRemote: false,
    lastSeq: 0,
    comments: [],
    usersCache: [],
    commentOpen: false,
    commentFilter: 'all',
    reloadPending: false
  };

  var pollTimer = null;
  var presenceTimer = null;
  var beatTimer = null;

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
      return navigator.clipboard.writeText(text)
        .then(function () { return true; }, function () { return legacyCopy(text); });
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

  // ============ 网络请求 ============

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

  // ============ Univer Docs 初始化 ============

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
    if (typeof BUNDLE.UniverDocsCorePreset === 'function') {
      presets.push(BUNDLE.UniverDocsCorePreset({ container: 'univer-container' }));
    }
    if (typeof BUNDLE.UniverDocsDrawingPreset === 'function') {
      presets.push(BUNDLE.UniverDocsDrawingPreset());
    }

    if (presets.length === 0) {
      setLoading(false);
      showToast('文档编辑器预设加载失败，请刷新页面', 'error');
      return false;
    }

    var opts = { presets: presets };
    if (locale !== undefined) opts.locale = locale;
    if (Object.keys(locales).length) opts.locales = locales;
    if (BUNDLE.defaultTheme) opts.theme = BUNDLE.defaultTheme;

    var inst = BUNDLE.createUniver(opts);
    univerAPI = inst.univerAPI;
    return Boolean(univerAPI);
  }

  function loadDoc() {
    return csrfFetch(API.doc).then(function (json) {
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      renderDocument(data.doc);
      setSaveStatus('is-saved', '已加载 v' + state.version);
      setLoading(false);
      startPolling();
    }).catch(function (err) {
      setLoading(false);
      setSaveStatus('is-error', '加载失败');
      showToast(err.message || '文档加载失败', 'error');
    });
  }

  function renderDocument(docData) {
    if (!docData) return;
    // 销毁旧文档
    if (docInstance) {
      var oldId = typeof docInstance.getId === 'function' ? docInstance.getId() : (docInstance.id || null);
      if (oldId && univerAPI && typeof univerAPI.disposeUnit === 'function') {
        try { univerAPI.disposeUnit(oldId); } catch (e) { /* 忽略 */ }
      } else if (docInstance && typeof docInstance.dispose === 'function') {
        try { docInstance.dispose(); } catch (e) { /* 忽略 */ }
      }
      docInstance = null;
    }

    // 创建文档
    if (typeof univerAPI.createDocument === 'function') {
      docInstance = univerAPI.createDocument(docData);
    }
    // 尝试获取活动文档
    if (!docInstance && typeof univerAPI.getActiveDocument === 'function') {
      try { docInstance = univerAPI.getActiveDocument(); } catch (e) { /* 忽略 */ }
    }

    wireDocument();
    applyEditable();
  }

  function wireDocument() {
    if (!docInstance || cmdServiceWired) return;
    // Univer 1.3.1 实测：FDocument 与 univerAPI 都没有 onCommandExecuted，
    // 真实可用的订阅点是 _commandService（浏览器 harness 验证，且为全局单例，只挂一次）
    var svc = docInstance._commandService ||
      (typeof docInstance.commandService === 'object' ? docInstance.commandService : null);
    if (!svc || typeof svc.onCommandExecuted !== 'function') return;
    cmdServiceWired = true;
    svc.onCommandExecuted(function (cmd) {
      if (state.applyingRemote) return;
      var id = (cmd && cmd.id) || '';
      // 只关心会改数据的 command / mutation；光标、选区等 operation 不置脏
      if (/^doc(ument)?\.(command|mutation)\./.test(id) === false) return;
      markDirty();
    });
  }

  function applyEditable() {
    var editable = Boolean(CFG.canEdit && !state.locked);
    if (docInstance && typeof docInstance.setEditable === 'function') {
      try { docInstance.setEditable(editable); } catch (e) { /* 忽略 */ }
    }
    var saveBtn = $('btnSsSave');
    if (saveBtn) saveBtn.hidden = !editable;
  }

  function extractDocSnapshot() {
    if (!docInstance) return null;
    var snap = null;
    if (typeof docInstance.getSnapshot === 'function') {
      try { snap = docInstance.getSnapshot(); } catch (e) { snap = null; }
    }
    // Univer 1.3 的 FDocument 只提供 save()，导入生成的快照没有段落 id， facade 段落 API 会抛错
    if (!snap && typeof docInstance.save === 'function') {
      try { snap = docInstance.save(); } catch (e) { snap = null; }
    }
    if (!snap && docInstance._documentDataModel && typeof docInstance._documentDataModel.getSnapshot === 'function') {
      try { snap = docInstance._documentDataModel.getSnapshot(); } catch (e) { snap = null; }
    }
    if (!snap && docInstance._document && typeof docInstance._document.getSnapshot === 'function') {
      try { snap = docInstance._document.getSnapshot(); } catch (e) { snap = null; }
    }
    // 备选：通过 univerAPI 获取
    if (!snap && univerAPI && univerAPI.doc && typeof univerAPI.doc.getSnapshot === 'function') {
      try { snap = univerAPI.doc.getSnapshot(); } catch (e) { snap = null; }
    }
    return snap;
  }

  /**
   * 从快照读出段落清单（含文本区间与命名样式）
   * 段落区间：Univer 的 paragraph.startIndex 指向段尾 \r，正文是「上一段结束 → startIndex」
   */
  function snapshotParagraphs() {
    var snap = extractDocSnapshot();
    var body = (snap && snap.body) || null;
    if (!body) return [];
    var ds = String(body.dataStream || '');
    var list = [];
    var cursor = 0;
    (body.paragraphs || []).forEach(function (p, i) {
      var end = Number(p.startIndex);
      if (!isFinite(end) || end < cursor) end = cursor;
      list.push({
        index: i,
        start: cursor,
        end: end,
        text: ds.slice(cursor, end).replace(/\r\n$/, ''),
        namedStyleType: numOf(p && p.paragraphStyle && p.paragraphStyle.namedStyleType, 1)
      });
      cursor = end + 2;
    });
    return list;
  }

  // ============ 保存（乐观锁） ============

  function markDirty() {
    if (!CFG.canEdit || state.locked) return;
    state.dirty = true;
    setSaveStatus('is-dirty', '有未保存更改');
    scheduleSave();
  }

  var scheduleSave = debounce(function () { saveNow(false); }, AUTO_SAVE_MS);

  function saveNow(manual) {
    if (state.saving || !state.dirty || !CFG.canEdit || state.locked) return;
    var snapshot = extractDocSnapshot();
    if (!snapshot) {
      if (manual) showToast('无法获取文档数据', 'error');
      return;
    }
    state.saving = true;
    setSaveStatus('is-saving', '保存中…');
    var body = JSON.stringify(snapshot);
    // 预检大小
    try {
      var blobSize = new Blob([body]).size;
      if (blobSize > 50 * 1024 * 1024) {
        state.saving = false;
        setSaveStatus('is-error', '文档过大');
        showToast('文档超过 50MB 上限，请拆分后保存', 'error');
        return;
      }
    } catch (e) { /* 忽略 */ }

    csrfFetch(API.doc, {
      method: 'PUT',
      body: JSON.stringify({
        doc: snapshot,
        baseVersion: state.version,
        structural: true,
        snapshot: body.slice(0, 200),
        changeDesc: manual ? '手动保存' : '自动保存'
      })
    }).then(function (json) {
      state.saving = false;
      state.dirty = false;
      var data = json.data || {};
      if (data.version) state.version = data.version;
      setSaveStatus('is-saved', '已保存 v' + state.version);
      if (manual) showToast('保存成功', 'success');
    }).catch(function (err) {
      state.saving = false;
      if (err.status === 409) {
        handleConflict();
      } else {
        setSaveStatus('is-error', '保存失败');
        showToast(err.message || '保存失败', 'error');
      }
    });
  }

  function handleConflict() {
    setSaveStatus('is-error', '版本冲突');
    showToast('其他客户端已修改文档，请刷新获取最新版本', 'warning', 5000);
    state.reloadPending = true;
  }

  // ============ 协同轮询 ============

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    if (beatTimer) clearInterval(beatTimer);

    pollTimer = setInterval(pollChanges, CHANGES_POLL_MS);
    presenceTimer = setInterval(pollPresence, PRESENCE_POLL_MS);
    beatTimer = setInterval(beatPresence, PRESENCE_BEAT_MS);

    pollChanges();
    pollPresence();
    beatPresence();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  }

  function pollChanges() {
    csrfFetch(API.changes + '?since=' + (state.lastSeq || 0))
      .then(function (json) {
        var changes = (json.data && json.data.changes) || [];
        for (var i = 0; i < changes.length; i++) {
          handleRemoteChange(changes[i]);
        }
      })
      .catch(function () { /* 网络抖动忽略 */ });
  }

  function handleRemoteChange(ch) {
    if (!ch || ch.seq <= state.lastSeq) return;
    state.lastSeq = ch.seq;

    if (ch.kind === 'docReload') {
      // 其他人保存了文档 → 拉取最新版本
      if (!state.dirty && !state.saving) {
        reloadRemoteDoc();
      } else {
        state.reloadPending = true;
      }
    } else if (ch.kind === 'lock' || ch.kind === 'publicRead') {
      if (ch.kind === 'lock') state.locked = Boolean(ch.payload && ch.payload.locked);
      if (ch.kind === 'publicRead') state.publicRead = Boolean(ch.payload && ch.payload.publicRead);
      applyEditable();
    } else if (ch.kind === 'comments') {
      if (state.commentOpen) loadComments();
    }
  }

  function reloadRemoteDoc() {
    csrfFetch(API.doc).then(function (json) {
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      state.applyingRemote = true;
      renderDocument(data.doc);
      state.applyingRemote = false;
      setSaveStatus('is-saved', '已同步 v' + state.version);
      state.reloadPending = false;
    }).catch(function () { /* 忽略 */ });
  }

  function pollPresence() {
    csrfFetch(API.presence)
      .then(function (json) {
        var users = (json.data && json.data.users) || [];
        renderPresenceBar(users);
      })
      .catch(function () { /* 忽略 */ });
  }

  function beatPresence() {
    csrfFetch(API.presence, {
      method: 'POST',
      body: JSON.stringify({ mode: CFG.canEdit ? 'edit' : 'view' })
    }).catch(function () { /* 忽略 */ });
  }

  function renderPresenceBar(users) {
    var bar = $('ssPresenceBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!Array.isArray(users) || users.length === 0) return;
    var shown = users.slice(0, 8);
    shown.forEach(function (u) {
      var el = document.createElement('span');
      el.className = 'ss-presence-avatar';
      el.style.background = hashColor(u.username);
      el.textContent = (u.username || '?').charAt(0).toUpperCase();
      var mode = u.mode === 'edit' ? '编辑中' : u.mode === 'cursor' ? '查看中' : '在线';
      el.title = (u.username || '') + ' · ' + mode;
      bar.appendChild(el);
    });
    if (users.length > 8) {
      var more = document.createElement('span');
      more.className = 'ss-presence-avatar';
      more.style.background = '#94a3b8';
      more.textContent = '+' + (users.length - 8);
      more.title = '还有 ' + (users.length - 8) + ' 人在线';
      bar.appendChild(more);
    }
  }

  // ============ 批注/评论 ============

  function loadComments() {
    csrfFetch(API.comments)
      .then(function (json) {
        state.comments = (json.data && json.data.comments) || [];
        renderComments();
        updateCommentBadge();
      })
      .catch(function () { /* 忽略 */ });
  }

  function toggleCommentPanel() {
    var panel = $('ssCommentPanel');
    if (!panel) return;
    state.commentOpen = !state.commentOpen;
    panel.hidden = !state.commentOpen;
    var btn = $('btnSsComments');
    if (btn) btn.classList.toggle('is-active', state.commentOpen);
    if (state.commentOpen) loadComments();
  }

  function renderComments() {
    var list = $('ssCommentList');
    if (!list) return;
    if (state.comments.length === 0) {
      list.innerHTML = '<div class="ss-comment-empty">暂无批注</div>';
      return;
    }
    list.innerHTML = state.comments.map(function (c) {
      var head = '<div class="ss-comment-head">'
        + '<span class="ss-comment-author">' + escapeHtml(c.username) + '</span>'
        + '<span>' + fmtTime(c.created_at) + '</span>'
        + '</div>';
      var body = '<div class="ss-comment-body">' + escapeHtml(c.content) + '</div>';
      var actions = '';
      if (CFG.canEdit || c.user_id === CFG.user.id) {
        actions = '<div class="ss-comment-actions">'
          + '<button class="ss-mini-btn" data-reply="' + c.id + '">回复</button>'
          + (c.user_id === CFG.user.id ? '<button class="ss-mini-btn danger" data-delete="' + c.id + '">删除</button>' : '')
          + '</div>';
      }
      return '<div class="ss-comment-item">' + head + body + actions + '</div>';
    }).join('');

    // 绑定事件
    list.querySelectorAll('[data-reply]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = $('ssCommentInput');
        if (input) { input.focus(); input.value = '@' + btn.dataset.reply + ' '; }
      });
    });
    list.querySelectorAll('[data-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteComment(btn.dataset.delete); });
    });
  }

  function updateCommentBadge() {
    var badge = $('ssCommentCount');
    if (!badge) return;
    var count = state.comments.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  function sendComment() {
    var input = $('ssCommentInput');
    if (!input) return;
    var content = input.value.trim();
    if (!content) return;
    csrfFetch(API.comments, {
      method: 'POST',
      body: JSON.stringify({ content: content, row: 0, col: 0, sheetId: '' })
    }).then(function () {
      input.value = '';
      loadComments();
    }).catch(function (err) {
      showToast(err.message || '发送失败', 'error');
    });
  }

  function deleteComment(commentId) {
    if (!confirm('确定删除此批注？')) return;
    csrfFetch(API.comments + '/' + commentId, { method: 'DELETE' })
      .then(function () { loadComments(); })
      .catch(function (err) { showToast(err.message || '删除失败', 'error'); });
  }

  // ============ 版本历史 ============

  function openVersionModal() {
    csrfFetch(API.versions)
      .then(function (json) {
        var versions = (json.data && json.data.versions) || [];
        renderVersionModal(versions);
      })
      .catch(function (err) { showToast(err.message || '加载版本失败', 'error'); });
  }

  function renderVersionModal(versions) {
    var bodyHtml = '<div style="margin-bottom:12px"><button class="ss-btn ss-btn-primary" id="btnCreateVersion">📸 创建当前版本快照</button></div>';
    if (versions.length === 0) {
      bodyHtml += '<div class="ss-comment-empty">暂无历史版本</div>';
    } else {
      bodyHtml += versions.map(function (v) {
        var isCurrent = v.version === state.version;
        return '<div class="ss-version-item' + (isCurrent ? ' is-current' : '') + '">'
          + '<div class="ss-version-info">'
          + '<div class="ver">v' + v.version + (isCurrent ? ' （当前）' : '') + '</div>'
          + '<div class="desc">' + escapeHtml(v.change_desc || '') + '</div>'
          + '<div class="meta">' + escapeHtml(v.username || '') + ' · ' + fmtTime(v.created_at) + ' · ' + (v.size_bytes || 0) + ' bytes</div>'
          + '</div>'
          + '<div>'
          + '<button class="ss-btn" data-preview-ver="' + v.version + '">预览</button> '
          + (!isCurrent ? '<button class="ss-btn" data-restore-ver="' + v.version + '">恢复</button>' : '')
          + '</div></div>';
      }).join('');
    }
    var modal = openModal({ title: '🕘 历史版本', large: true, body: bodyHtml });

    var createBtn = modal.body.querySelector('#btnCreateVersion');
    if (createBtn) createBtn.addEventListener('click', function () { createManualVersion(modal); });

    modal.body.querySelectorAll('[data-preview-ver]').forEach(function (btn) {
      btn.addEventListener('click', function () { previewVersion(parseInt(btn.dataset.previewVer, 10)); });
    });
    modal.body.querySelectorAll('[data-restore-ver]').forEach(function (btn) {
      btn.addEventListener('click', function () { restoreVersion(parseInt(btn.dataset.restoreVer, 10), modal); });
    });
  }

  function createManualVersion(modal) {
    csrfFetch(API.versions, { method: 'POST', body: JSON.stringify({ changeDesc: '手动创建版本快照' }) })
      .then(function () {
        showToast('版本快照已创建', 'success');
        if (modal) modal.close();
      })
      .catch(function (err) { showToast(err.message || '创建失败', 'error'); });
  }

  function previewVersion(ver) {
    csrfFetch(API.versions + '/' + ver)
      .then(function (json) {
        var data = (json && json.data) || {};
        var docData = data.doc;
        if (!docData) { showToast('无法加载此版本', 'error'); return; }
        // 在模态框中显示文档内容概览
        var text = '';
        if (docData.body && docData.body.dataStream) {
          text = docData.body.dataStream.replace(/\r?\n/g, '\n').slice(0, 5000);
        } else {
          text = JSON.stringify(docData, null, 2).slice(0, 5000);
        }
        openModal({
          title: '版本 v' + ver + ' 预览',
          large: true,
          body: '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;max-height:60vh;overflow:auto;background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0">' + escapeHtml(text) + '</pre>'
        });
      })
      .catch(function (err) { showToast(err.message || '加载失败', 'error'); });
  }

  function restoreVersion(ver, modal) {
    if (!confirm('确定恢复到版本 v' + ver + '？当前未保存的更改将丢失。')) return;
    csrfFetch(API.versions + '/' + ver + '/restore', { method: 'POST' })
      .then(function () {
        showToast('已恢复到版本 v' + ver, 'success');
        if (modal) modal.close();
        reloadRemoteDoc();
      })
      .catch(function (err) { showToast(err.message || '恢复失败', 'error'); });
  }

  // ============ 分享 ============

  function openShareModal() {
    var modal = openModal({ title: '🔗 分享文档', body: '<div class="ss-inline-loading">加载分享状态…</div>' });
    csrfFetch(API.share)
      .then(function (json) { renderShareModal(modal, json.data || {}); })
      .catch(function (err) {
        modal.body.innerHTML = '<p class="ss-inline-error">' + escapeHtml(err.message || '加载分享状态失败') + '</p>';
      });
  }

  // /api/document/:id/share 返回 data = {shared,status,token,url,embedUrl,viewCount,createdAt}
  function renderShareModal(modal, d) {
    var bodyHtml;
    if (d.shared && d.token) {
      var link = location.origin + (d.url || '/share/' + d.token);
      var embedUrl = location.origin + (d.embedUrl || ('/share/' + d.token + '/embed'));
      var embedCode = '<iframe src="' + embedUrl + '" width="100%" height="640" frameborder="0" style="border:1px solid #e0e4ea;border-radius:12px;" loading="lazy" allowfullscreen></iframe>';
      bodyHtml = (d.status !== 1 ? '<p class="ss-inline-error">分享当前处于停用状态。</p>' : '')
        + '<div class="ss-share-stats"><b>浏览 ' + (d.viewCount || 0) + '</b>'
        + (d.createdAt ? '<span>创建于 ' + escapeHtml(fmtTime(d.createdAt)) + '</span>' : '') + '</div>'
        + '<div class="ss-field"><label>分享链接</label>'
        + '<div class="ss-share-link-row">'
        + '<input type="text" class="ss-input" readonly value="' + escapeHtml(link) + '" id="shareLinkInput">'
        + '<button type="button" class="ss-btn" id="btnCopyShare">复制</button>'
        + '<button type="button" class="ss-btn" id="btnOpenShare">打开</button>'
        + '</div></div>'
        + '<div class="ss-field"><label>嵌入代码（iframe）</label>'
        + '<textarea class="ss-input" rows="2" readonly id="shareEmbedCode">' + escapeHtml(embedCode) + '</textarea></div>'
        + '<p class="ss-hint">获得链接的人无需登录即可在线只读查看，分享页不支持下载。</p>'
        + '<button type="button" class="ss-btn ss-btn-danger" id="btnCancelShare">停止分享</button>';
    } else {
      bodyHtml = '<p class="ss-hint">尚未开启分享，开启后所有获得链接的人可在线只读查看此文档。</p>'
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
        csrfFetch(API.share, { method: 'DELETE' })
          .then(function () { showToast('分享已停止', 'success'); renderShareModal(modal, { shared: false }); })
          .catch(function (err) { showToast(err.message || '操作失败', 'error'); });
      });
    } else {
      var enableBtn = modal.body.querySelector('#btnEnableShare');
      enableBtn.addEventListener('click', function () {
        enableBtn.disabled = true;
        csrfFetch(API.share, { method: 'POST', body: JSON.stringify({}) })
          .then(function (json) {
            showToast('分享已开启', 'success');
            renderShareModal(modal, json.data || { shared: false });
          })
          .catch(function (err) { enableBtn.disabled = false; showToast(err.message || '操作失败', 'error'); });
      });
    }
  }

  // ============ 权限管理 ============

  function openPermModal() {
    csrfFetch(API.permissions)
      .then(function (json) {
        var perms = (json.data && json.data.permissions) || [];
        renderPermModal(perms);
      })
      .catch(function (err) { showToast(err.message || '加载权限失败', 'error'); });
  }

  function renderPermModal(perms) {
    var bodyHtml = '<div class="ss-field"><label>公开只读</label>'
      + '<label style="font-size:13px;cursor:pointer"><input type="checkbox" id="permPublicRead"' + (state.publicRead ? ' checked' : '') + '> 所有登录用户可查看</label></div>'
      + '<hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0">'
      + '<div class="ss-field"><label>授权用户</label>'
      + '<div class="ss-row">'
      + '<select id="permUserSelect" class="ss-field-select"><option value="">选择用户…</option></select>'
      + '<select id="permTypeSelect">';
    Object.keys(PERM_NAMES).forEach(function (k) {
      bodyHtml += '<option value="' + k + '">' + PERM_NAMES[k] + '</option>';
    });
    bodyHtml += '</select><button class="ss-btn ss-btn-primary" id="btnGrantPerm">授权</button></div></div>';

    if (perms.length > 0) {
      bodyHtml += '<table class="ss-table"><thead><tr><th>用户</th><th>权限</th><th>操作</th></tr></thead><tbody>';
      perms.forEach(function (p) {
        bodyHtml += '<tr><td>' + escapeHtml(p.username || p.user_id) + '</td>'
          + '<td>' + escapeHtml(PERM_NAMES[p.perm_type] || p.perm_type) + '</td>'
          + '<td><button class="ss-mini-btn danger" data-revoke="' + p.user_id + '">撤销</button></td></tr>';
      });
      bodyHtml += '</tbody></table>';
    } else {
      bodyHtml += '<p class="ss-hint">暂无授权用户</p>';
    }

    var modal = openModal({ title: '🔐 权限管理', large: true, body: bodyHtml });

    // 加载用户列表
    csrfFetch(API.users).then(function (json) {
      var users = (json.data && json.data.users) || [];
      state.usersCache = users;
      var sel = modal.body.querySelector('#permUserSelect');
      if (!sel) return;
      users.forEach(function (u) {
        var opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = (u.nickname || u.username) + ' (' + u.username + ')';
        sel.appendChild(opt);
      });
    }).catch(function () { /* 忽略 */ });

    // 公开只读切换
    var pubChk = modal.body.querySelector('#permPublicRead');
    if (pubChk) pubChk.addEventListener('change', function () {
      csrfFetch(API.publicRead, { method: 'POST', body: JSON.stringify({ publicRead: pubChk.checked }) })
        .then(function () {
          state.publicRead = pubChk.checked;
          showToast(pubChk.checked ? '已开启公开只读' : '已关闭公开只读', 'success');
        })
        .catch(function (err) { showToast(err.message || '操作失败', 'error'); pubChk.checked = !pubChk.checked; });
    });

    // 授权
    var grantBtn = modal.body.querySelector('#btnGrantPerm');
    if (grantBtn) grantBtn.addEventListener('click', function () {
      var userId = modal.body.querySelector('#permUserSelect').value;
      var permType = modal.body.querySelector('#permTypeSelect').value;
      if (!userId) { showToast('请选择用户', 'warning'); return; }
      csrfFetch(API.permissions, { method: 'POST', body: JSON.stringify({ user_id: parseInt(userId, 10), perm_type: permType }) })
        .then(function () { showToast('授权成功', 'success'); modal.close(); openPermModal(); })
        .catch(function (err) { showToast(err.message || '授权失败', 'error'); });
    });

    // 撤销
    modal.body.querySelectorAll('[data-revoke]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        csrfFetch(API.revokePerm + '/' + btn.dataset.revoke, { method: 'DELETE' })
          .then(function () { showToast('已撤销', 'success'); modal.close(); openPermModal(); })
          .catch(function (err) { showToast(err.message || '操作失败', 'error'); });
      });
    });
  }

  function openApplyPermModal() {
    var bodyHtml = '<p class="ss-hint">您目前没有访问此文档的权限，可以申请以下权限：</p>'
      + '<div class="ss-field"><label>申请权限类型</label><select id="applyPermType">';
    Object.keys(PERM_NAMES).forEach(function (k) {
      bodyHtml += '<option value="' + k + '">' + PERM_NAMES[k] + '</option>';
    });
    bodyHtml += '</select></div>'
      + '<div class="ss-field"><label>申请理由（可选）</label><textarea id="applyReason" rows="3" maxlength="500"></textarea></div>';
    var modal = openModal({
      title: '🔓 申请权限',
      body: bodyHtml,
      actions: [
        { label: '取消', className: '' },
        {
          label: '提交申请', className: 'ss-btn-primary',
          onClick: function () {
            var permType = modal.body.querySelector('#applyPermType').value;
            var reason = modal.body.querySelector('#applyReason').value.trim();
            csrfFetch(API.apply, { method: 'POST', body: JSON.stringify({ perm_type: permType, reason: reason }) })
              .then(function () { modal.close(); showToast('申请已提交，等待管理员审批', 'success'); })
              .catch(function (err) { showToast(err.message || '申请失败', 'error'); });
            return false;
          }
        }
      ]
    });
  }

  // ============ AI 助手（文档专用） ============

  function openAiModal() {
    var bodyHtml = '<div class="ss-tabs">'
      + '<button class="ss-tab is-active" data-tab="polish">润色</button>'
      + '<button class="ss-tab" data-tab="continue">续写</button>'
      + '<button class="ss-tab" data-tab="translate">翻译</button>'
      + '<button class="ss-tab" data-tab="summarize">总结</button>'
      + '</div>'
      + '<div class="ss-tab-body is-active" data-tab="polish">'
      + '<div class="ss-field"><label>选择要润色的文本（或留空使用全文）</label>'
      + '<textarea id="aiInputPolish" rows="4" placeholder="选中的文本将自动填入…"></textarea></div>'
      + '<button class="ss-btn ss-btn-primary" data-ai-run="polish">开始润色</button>'
      + '</div>'
      + '<div class="ss-tab-body" data-tab="continue">'
      + '<div class="ss-field"><label>续写起点（留空则从文档末尾续写）</label>'
      + '<textarea id="aiInputContinue" rows="4" placeholder="文档末尾文本将自动填入…"></textarea></div>'
      + '<button class="ss-btn ss-btn-primary" data-ai-run="continue">开始续写</button>'
      + '</div>'
      + '<div class="ss-tab-body" data-tab="translate">'
      + '<div class="ss-row"><div class="ss-field"><label>源语言</label><select id="aiTransFrom"><option value="zh">中文</option><option value="en">英文</option></select></div>'
      + '<div class="ss-field"><label>目标语言</label><select id="aiTransTo"><option value="en">英文</option><option value="zh">中文</option></select></div></div>'
      + '<div class="ss-field"><label>要翻译的文本</label><textarea id="aiInputTranslate" rows="4"></textarea></div>'
      + '<button class="ss-btn ss-btn-primary" data-ai-run="translate">开始翻译</button>'
      + '</div>'
      + '<div class="ss-tab-body" data-tab="summarize">'
      + '<p class="ss-hint">将生成文档的摘要总结。</p>'
      + '<button class="ss-btn ss-btn-primary" data-ai-run="summarize">开始总结</button>'
      + '</div>'
      + '<div id="aiResult" style="margin-top:16px"></div>';

    var modal = openModal({ title: '✨ AI 文档助手', large: true, body: bodyHtml });

    // Tab 切换
    modal.body.querySelectorAll('.ss-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        modal.body.querySelectorAll('.ss-tab').forEach(function (t) { t.classList.remove('is-active'); });
        modal.body.querySelectorAll('.ss-tab-body').forEach(function (b) { b.classList.remove('is-active'); });
        tab.classList.add('is-active');
        var target = modal.body.querySelector('.ss-tab-body[data-tab="' + tab.dataset.tab + '"]');
        if (target) target.classList.add('is-active');
      });
    });

    // AI 操作
    modal.body.querySelectorAll('[data-ai-run]').forEach(function (btn) {
      btn.addEventListener('click', function () { runAiAction(btn.dataset.aiRun, modal); });
    });
  }

  function runAiAction(action, modal) {
    var resultDiv = modal.body.querySelector('#aiResult');
    if (!resultDiv) return;
    resultDiv.innerHTML = '<div class="ss-inline-loading">AI 正在处理…</div>';

    var inputText = '';
    var extra = {};
    if (action === 'polish') {
      inputText = (modal.body.querySelector('#aiInputPolish') || {}).value || '';
    } else if (action === 'continue') {
      inputText = (modal.body.querySelector('#aiInputContinue') || {}).value || '';
    } else if (action === 'translate') {
      inputText = (modal.body.querySelector('#aiInputTranslate') || {}).value || '';
      extra.from = (modal.body.querySelector('#aiTransFrom') || {}).value || 'zh';
      extra.to = (modal.body.querySelector('#aiTransTo') || {}).value || 'en';
    }

    // 如果输入为空，尝试从文档提取全文
    if (!inputText.trim()) {
      var snap = extractDocSnapshot();
      if (snap && snap.body && snap.body.dataStream) {
        inputText = snap.body.dataStream.replace(/\r?\n/g, '\n').trim();
      }
    }

    if (!inputText.trim()) {
      resultDiv.innerHTML = '<div class="ss-inline-error">请先输入或选择要处理的文本</div>';
      return;
    }

    var endpoint = API.ai.analyze;
    var payload = { text: inputText, action: action, extra: extra };

    csrfFetch(endpoint, { method: 'POST', body: JSON.stringify(payload) })
      .then(function (json) {
        var result = (json.data && json.data.result) || json.data || '';
        if (typeof result === 'object') result = JSON.stringify(result, null, 2);
        resultDiv.innerHTML = '<div class="ss-md-report">' + escapeHtml(String(result)) + '</div>'
          + '<div style="margin-top:8px"><button class="ss-btn ss-btn-primary" id="btnAiInsert">插入到文档</button></div>';
        var insertBtn = resultDiv.querySelector('#btnAiInsert');
        if (insertBtn) insertBtn.addEventListener('click', function () {
          showToast('AI 结果已复制到剪贴板，请手动粘贴到文档中', 'success');
          copyText(String(result));
        });
      })
      .catch(function (err) {
        resultDiv.innerHTML = '<div class="ss-inline-error">' + escapeHtml(err.message || 'AI 处理失败') + '</div>';
      });
  }

  // ============ 导出 ============

  function exportDoc() {
    if (state.dirty) {
      saveNow(true);
    }
    var a = document.createElement('a');
    a.href = API.export + '?format=docx';
    a.download = (CFG.name || 'document') + '.docx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============ 视图层（页面视图 / 阅读视图 / 大纲窗格） ============

  var layout = {
    open: false,
    mode: 'layout',
    instance: null,
    data: null,
    setup: null,
    zoom: 1,
    ruler: true,
    pages: 0,
    outline: true,
    fontSize: 17,
    pageWidth: 0
  };

  function toggleLayoutView() { toggleView('layout'); }

  function toggleReadingView() { toggleView('reading'); }

  function toggleView(mode) {
    if (layout.open && layout.mode === mode) { closeView(); return; }
    if (layout.open) closeView();
    openView(mode);
  }

  function openView(mode) {
    var root = $('docLayoutRoot');
    if (!root || !window.DocLayout) return;
    layout.mode = mode;
    root.hidden = false;
    viewBar();
    layout.open = true;
    markViewActive();
    if (CFG.canEdit && state.dirty) saveNow(false);
    fetchPageView();
  }

  function closeView() {
    var root = $('docLayoutRoot');
    if (!root) return;
    layout.open = false;
    layout.mode = 'layout';
    layout.data = null;
    root.hidden = true;
    root.innerHTML = '';
    if (layout.instance) layout.instance.destroy();
    layout.instance = null;
    markViewActive();
  }

  function markViewActive() {
    var lb = $('btnDocLayout');
    var rb = $('btnDocReading');
    if (lb) lb.classList.toggle('is-active', layout.open && layout.mode === 'layout');
    if (rb) rb.classList.toggle('is-active', layout.open && layout.mode === 'reading');
  }

  function fetchPageView(useStoredDoc) {
    var payload = {};
    if (!useStoredDoc && CFG.canEdit) {
      var snap = extractDocSnapshot();
      if (snap && snap.body) payload.doc = snap;
    }
    return csrfFetch(API.pageView + '?mode=' + layout.mode, {
      method: 'POST',
      body: JSON.stringify(payload)
    }).then(function (json) {
      layout.data = json.data;
      mountView();
    }).catch(function (err) {
      showToast(err.message || '视图生成失败', 'error');
      closeView();
    });
  }

  function mountView() {
    var host = $('dlViewer');
    if (!host || !layout.data) return;
    if (layout.instance) layout.instance.destroy();
    var reading = layout.mode === 'reading';
    var opts = {
      onActiveAnchor: highlightOutline,
      onReady: function (count, warnings) {
        if (reading) {
          layout.pages = 0;
        } else {
          layout.pages = count;
        }
        var info = $('dlBarInfo');
        if (info) {
          var toc = (layout.data && layout.data.toc) || [];
          info.textContent = (reading ? '正文 ' + count + ' 段 · ' : '共 ' + count + ' 页 · ')
            + toc.length + ' 个标题'
            + (warnings && warnings.length ? ' · ' + warnings.join('；') : '');
        }
      }
    };
    if (reading) {
      opts.fontSize = layout.fontSize;
      opts.pageWidth = layout.pageWidth;
      layout.instance = window.DocLayout.mountReading(host, layout.data, opts);
    } else {
      opts.zoom = layout.zoom;
      opts.showRuler = layout.ruler;
      opts.canEdit = CFG.canEdit && !state.locked;
      opts.onEditHeaderFooter = openHeaderFooterEditor;
      layout.instance = window.DocLayout.mount(host, layout.data, opts);
    }
    renderOutline((layout.data.toc || []));
    setOutlineVisible(layout.outline);
  }

  // ============ 大纲 / 导航窗格 ============

  function renderOutline(toc) {
    var box = $('dlOutline');
    if (!box) return;
    box.textContent = '';
    if (!toc.length) {
      var hint = document.createElement('div');
      hint.className = 'dl-outline-empty';
      hint.textContent = '还没有标题。选中段落后用「🎨 样式」设为标题，即可在此导航。';
      box.appendChild(hint);
      return;
    }
    toc.forEach(function (item) {
      var li = document.createElement('button');
      li.type = 'button';
      li.className = 'dl-ol-item dl-ol-lv' + Math.max(1, Math.min(6, item.level || 1));
      li.dataset.anchor = item.anchor;
      li.textContent = item.text || '（空标题）';
      li.title = item.text || '';
      li.addEventListener('click', function () {
        if (layout.instance) layout.instance.goTo(this.dataset.anchor);
      });
      box.appendChild(li);
    });
  }

  function highlightOutline(anchor) {
    var box = $('dlOutline');
    if (!box) return;
    var items = box.querySelectorAll('.dl-ol-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-active', Boolean(anchor) && items[i].dataset.anchor === anchor);
    }
  }

  function setOutlineVisible(visible) {
    var side = $('dlSide');
    if (side) side.style.display = visible ? '' : 'none';
    var btn = $('dlOutlineBtn');
    if (btn) btn.textContent = '🧭 大纲：' + (visible ? '开' : '关');
  }

  // ============ 视图工具栏 ============

  function selectOptions(list, current) {
    return list.map(function (it) {
      var sel = String(it.v) === String(current) ? ' selected' : '';
      return '<option value="' + it.v + '"' + sel + '>' + it.label + '</option>';
    }).join('');
  }

  var FONT_SIZES = [
    { v: 14, label: '14px' }, { v: 15, label: '15px' }, { v: 16, label: '16px' },
    { v: 17, label: '17px' }, { v: 19, label: '19px' }, { v: 21, label: '21px' }, { v: 24, label: '24px' }
  ];
  var PAGE_WIDTHS = [
    { v: 680, label: '窄栏' }, { v: 780, label: '标准' }, { v: 960, label: '宽栏' }, { v: 0, label: '自适应' }
  ];

  function viewBar() {
    var root = $('docLayoutRoot');
    if (!root) return null;
    if (root.querySelector('.dl-bar')) return root;

    var reading = layout.mode === 'reading';
    var bar = document.createElement('div');
    bar.className = 'dl-bar';
    bar.innerHTML = ''
      + '<button type="button" class="ss-btn" id="dlBack">← 返回编辑</button>'
      + (reading
        ? '<label class="dl-setup-field is-inline" style="flex-direction:row;align-items:center;gap:6px">字号'
        + '<select class="ss-input" id="drFont" style="width:88px">' + selectOptions(FONT_SIZES, layout.fontSize) + '</select></label>'
        + '<label class="dl-setup-field is-inline" style="flex-direction:row;align-items:center;gap:6px">页宽'
        + '<select class="ss-input" id="drWidth" style="width:96px">' + selectOptions(PAGE_WIDTHS, layout.pageWidth) + '</select></label>'
        : '<label class="dl-setup-field" style="flex-direction:row;align-items:center;gap:6px">缩放'
        + '<select class="ss-input" id="dlZoom" style="width:96px">'
        + '<option value="0.5">50%</option><option value="0.75">75%</option>'
        + '<option value="1">100%</option><option value="1.25">125%</option>'
        + '<option value="1.5">150%</option><option value="2">200%</option>'
        + '</select></label>'
        + '<button type="button" class="ss-btn" id="dlFit">适应宽度</button>'
        + '<button type="button" class="ss-btn" id="dlRulerBtn">标尺：' + (layout.ruler ? '开' : '关') + '</button>'
        + '<button type="button" class="ss-btn" id="dlSetup">📐 页面设置</button>')
      + '<button type="button" class="ss-btn" id="dlOutlineBtn">🧭 大纲：' + (layout.outline ? '开' : '关') + '</button>'
      + '<button type="button" class="ss-btn" id="dlTocBtn">📑 生成目录</button>'
      + (reading
        ? '<button type="button" class="ss-btn" id="drPrint">🖨️ 打印</button>'
        : '<button type="button" class="ss-btn" id="dlPrint">🖨️ 打印 / PDF</button>')
      + '<span class="dl-bar-info" id="dlBarInfo"></span>';

    var body = document.createElement('div');
    body.className = 'dl-body';
    var side = document.createElement('aside');
    side.className = 'dl-side';
    side.id = 'dlSide';
    side.innerHTML = '<div class="dl-side-head">大纲导航</div><div class="dl-outline" id="dlOutline"></div>';
    var viewer = document.createElement('div');
    viewer.className = 'dl-viewer';
    viewer.id = 'dlViewer';
    body.appendChild(side);
    body.appendChild(viewer);
    root.appendChild(bar);
    root.appendChild(body);

    function on(id, handler) {
      var el = bar.querySelector('#' + id);
      if (el) el.addEventListener('click', handler);
    }
    function onChange(id, handler) {
      var el = bar.querySelector('#' + id);
      if (el) el.addEventListener('change', handler);
    }

    on('dlBack', closeView);
    on('dlOutlineBtn', function () {
      layout.outline = !layout.outline;
      setOutlineVisible(layout.outline);
    });
    on('dlTocBtn', generateToc);

    if (reading) {
      onChange('drFont', function () {
        layout.fontSize = parseFloat(this.value) || 17;
        if (layout.instance) layout.instance.setFontSize(layout.fontSize);
      });
      onChange('drWidth', function () {
        layout.pageWidth = parseFloat(this.value) || 0;
        if (layout.instance) layout.instance.setPageWidth(layout.pageWidth);
      });
      on('drPrint', function () { if (layout.instance) layout.instance.print(); });
    } else {
      onChange('dlZoom', function () {
        layout.zoom = parseFloat(this.value) || 1;
        if (layout.instance) layout.instance.setZoom(layout.zoom);
      });
      on('dlFit', function () {
        if (!layout.instance) return;
        var z = layout.instance.fitWidth();
        var sel = bar.querySelector('#dlZoom');
        if (sel) sel.value = '';
        layout.zoom = z;
      });
      on('dlRulerBtn', function () {
        layout.ruler = !layout.ruler;
        this.textContent = '标尺：' + (layout.ruler ? '开' : '关');
        if (layout.instance) layout.instance.setRuler(layout.ruler);
      });
      on('dlSetup', openPageSetupModal);
      on('dlPrint', openPrintModal);
    }
    return root;
  }

  // ============ 段落样式（namedStyleType 与后端 doc-renderer 的映射保持一致） ============

  var NAMED_STYLE_HEADING_LEVEL = { 2: 1, 3: 2, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5 };
  var NAMED_STYLES = [
    { value: 1, label: '正文' },
    { value: 4, label: '标题 1' },
    { value: 5, label: '标题 2' },
    { value: 6, label: '标题 3' },
    { value: 7, label: '标题 4' },
    { value: 8, label: '标题 5' },
    { value: 2, label: '大标题' },
    { value: 3, label: '副标题' }
  ];

  function numOf(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function styleLabel(value) {
    for (var i = 0; i < NAMED_STYLES.length; i++) if (NAMED_STYLES[i].value === value) return NAMED_STYLES[i].label;
    return '正文';
  }

  /** 当前文档里的标题段落（大纲数据源，编辑态无需等后端） */
  function docHeadings() {
    var out = [];
    snapshotParagraphs().forEach(function (p) {
      var level = NAMED_STYLE_HEADING_LEVEL[p.namedStyleType] || 0;
      if (!level) return;
      var text = String(p.text || '').replace(/[\r\n]+/g, ' ').trim();
      if (!text) return;
      out.push({ index: p.index, level: level, text: text, start: p.start, end: p.end });
    });
    return out;
  }

  // ============ 样式面板 ============

  var MAX_STYLE_PARAS = 300;

  function paraPreview(item) {
    var text = String(item.text || '').replace(/\s+/g, ' ').trim();
    return {
      index: item.index,
      text: text ? (text.length > 34 ? text.slice(0, 34) + '…' : text) : '（空段落）',
      style: styleLabel(item.namedStyleType)
    };
  }

  function openStylesPanel() {
    if (!CFG.canEdit || state.locked) {
      showToast('您没有编辑权限，无法修改段落样式', 'error');
      return;
    }
    var paras = snapshotParagraphs();
    if (!paras.length) {
      showToast('文档还没有内容', 'info');
      return;
    }
    var picked = { index: 0 };
    var box = document.createElement('div');
    box.className = 'dl-styles';
    box.innerHTML = ''
      + '<div class="dl-styles-col">'
      + '<div class="dl-styles-head">段落（共 ' + paras.length + ' 段，最多列 ' + MAX_STYLE_PARAS + ' 段）</div>'
      + '<div class="dl-styles-list" id="stParaList"></div>'
      + '</div>'
      + '<div class="dl-styles-col">'
      + '<div class="dl-styles-head">段落样式</div>'
      + '<div class="dl-styles-grid">'
      + NAMED_STYLES.map(function (s) {
        return '<button type="button" class="ss-btn dl-style-btn" data-style="' + s.value + '">' + s.label + '</button>';
      }).join('')
      + '</div>'
      + '<div class="dl-setup-hint">样式按段落即时应用。设为「标题」的段落会出现在大纲窗格里，'
      + '并作为「📑 生成目录」的条目；正文样式用于取消标题。</div>'
      + '</div>';
    openModal({ title: '🎨 段落样式', large: true, body: box, actions: [{ label: '关闭' }] });

    function refresh() {
      paras = snapshotParagraphs();
      if (picked.index >= paras.length) picked.index = 0;
      var list = box.querySelector('#stParaList');
      if (!list) return;
      list.textContent = '';
      var limit = Math.min(paras.length, MAX_STYLE_PARAS);
      for (var i = 0; i < limit; i++) {
        var meta = paraPreview(paras[i]);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dl-para-item' + (meta.index === picked.index ? ' is-active' : '');
        btn.dataset.index = String(meta.index);
        btn.innerHTML = '<span class="dl-para-no">' + (meta.index + 1) + '</span>'
          + '<span class="dl-para-text">' + escapeHtml(meta.text) + '</span>'
          + '<span class="dl-para-style">' + escapeHtml(meta.style) + '</span>';
        list.appendChild(btn);
      }
    }
    refresh();

    box.querySelector('#stParaList').addEventListener('click', function (ev) {
      var target = ev.target && ev.target.closest ? ev.target.closest('.dl-para-item') : null;
      if (!target) return;
      picked.index = parseInt(target.dataset.index, 10) || 0;
      refresh();
    });

    box.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.dl-style-btn') : null;
      if (!btn) return;
      var item = paras[picked.index];
      if (!item) return;
      applyNamedStyle(item, parseInt(btn.dataset.style, 10)).then(function (ok) {
        if (!ok) { showToast('样式应用失败', 'error'); return; }
        markDirty();
        refresh();
        if (layout.open) fetchPageView();
      });
    });
  }

  /**
   * 按快照偏移量应用命名样式：导入文档没有段落 id，facade 的 getRange/setStyle 会抛错，
   * 命令自带 outlineLevel，正文样式（1）会把它复位
   */
  function applyNamedStyle(item, value) {
    if (!univerAPI || typeof univerAPI.executeCommand !== 'function') {
      return Promise.resolve(false);
    }
    return Promise.resolve(univerAPI.executeCommand('doc.command.set-paragraph-named-style', {
      value: value,
      textRanges: [{ startOffset: item.start, endOffset: item.end }]
    })).then(function (done) {
      return done !== false;
    }).catch(function () {
      return false;
    });
  }

  // ============ 目录自动生成 ============

  var TOC_TITLE = '目录';
  var TOC_ENTRY_RE = /\t第\s*\d+\s*页\s*$/;

  function contentWidthPt() {
    var sec = (layout.data && layout.data.sections && layout.data.sections[0]) || {};
    var mg = sec.margins || {};
    var w = numOf(sec.pageWidthPt, 595) - numOf(mg.left, 90) - numOf(mg.right, 90);
    return Math.max(120, Math.round(w));
  }

  /** 在离屏容器里跑一遍页面视图，量出每个标题落在第几页 */
  function measureAnchorPages() {
    return new Promise(function (resolve, reject) {
      var snap = extractDocSnapshot();
      if (!snap || !snap.body) {
        reject(new Error('文档内容尚未就绪'));
        return;
      }
      var host = document.createElement('div');
      host.className = 'dl-measure-host';
      document.body.appendChild(host);
      var settled = false;
      var timer = null;

      function finish(instance, payload) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        var pages = {};
        try { pages = instance.anchorPages() || {}; } catch (e) { pages = {}; }
        try { instance.destroy(); } catch (e) { /* 忽略 */ }
        if (host.parentNode) host.parentNode.removeChild(host);
        resolve({ toc: (payload.data && payload.data.toc) || [], pages: pages });
      }

      // toc=0：只渲染文档真实内容，否则额外目录块会把后文挤到下页、页码偏大
      csrfFetch(API.pageView + '?mode=layout&toc=0', {
        method: 'POST',
        body: JSON.stringify({ doc: snap })
      }).then(function (json) {
        if (!window.DocLayout) { reject(new Error('页面布局脚本未加载')); return; }
        var instance = window.DocLayout.mount(host, json.data, {
          zoom: 1,
          showRuler: false,
          onReady: function () { finish(instance, json); }
        });
        timer = setTimeout(function () { finish(instance, json); }, 20000);
      }).catch(function (err) {
        if (settled) return;
        settled = true;
        if (host.parentNode) host.parentNode.removeChild(host);
        reject(err);
      });
    });
  }

  /** 删除上一次生成的目录块（开头的「目录」段 + 紧随其后带页码的条目段） */
  function removeGeneratedToc() {
    var paras = snapshotParagraphs();
    if (!paras.length || String(paras[0].text || '').trim() !== TOC_TITLE) return 0;
    var last = 0;
    for (var i = 1; i < paras.length; i++) {
      if (!TOC_ENTRY_RE.test(String(paras[i].text || ''))) break;
      last = i;
    }
    // 只有「目录」两字、下面没有页码条目，那是作者自己写的标题，不动它
    if (last < 1 || !docInstance || typeof docInstance.deleteRange !== 'function') return 0;
    try {
      // 段尾的 \r\n 也要一起删掉，否则会留下空段
      if (!docInstance.deleteRange({ startOffset: 0, endOffset: paras[last].end + 2 })) return 0;
    } catch (e) {
      return 0;
    }
    return last + 1;
  }

  function insertTocLines(toc, pagesMap) {
    var tabPt = contentWidthPt();
    var lines = [{ head: true, level: 1, text: TOC_TITLE }];
    toc.forEach(function (item) {
      var level = Math.max(1, Math.min(6, numOf(item.level, 1)));
      var page = numOf(pagesMap[item.anchor], 0);
      lines.push({
        head: false,
        level: level,
        text: page > 0 ? (item.text + '\t第 ' + page + ' 页') : String(item.text || '')
      });
    });
    var inserted = 0;
    // 倒序插入 index 0，最终顺序与 lines 一致
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      var para = null;
      try {
        para = docInstance.insertParagraph(0, line.text);
      } catch (e) {
        para = null;
      }
      if (!para) continue;
      inserted++;
      if (typeof para.setStyle !== 'function') continue;
      var style = { namedStyleType: 1, outlineLevel: 9 };
      if (line.head) {
        style.textStyle = { bl: 1, fs: 14 };
      } else {
        style.indentStart = { v: (line.level - 1) * 18, u: 0 };
        style.tabStops = [{ offset: tabPt, alignment: 3, leader: 2 }];
      }
      try { para.setStyle(style); } catch (e) { /* 样式失败不影响目录可用 */ }
    }
    return inserted;
  }

  function generateToc() {
    if (!CFG.canEdit || state.locked) {
      showToast('您没有编辑权限，无法生成目录', 'error');
      return;
    }
    if (!docInstance || typeof docInstance.insertParagraph !== 'function') {
      showToast('文档编辑器尚未就绪', 'error');
      return;
    }
    if (!docHeadings().length) {
      showToast('文档里还没有标题：请用「🎨 样式」把段落设为标题', 'info');
      return;
    }
    setLoading(true, '正在计算目录页码…');
    measureAnchorPages().then(function (res) {
      if (!res.toc.length) {
        setLoading(false);
        showToast('没有可用于目录的标题', 'info');
        return;
      }
      var replaced = removeGeneratedToc();
      var inserted = insertTocLines(res.toc, res.pages);
      setLoading(false);
      if (!inserted) {
        showToast('目录插入失败，请刷新后重试', 'error');
        return;
      }
      markDirty();
      showToast((replaced ? '目录已更新' : '目录已生成') + '：' + res.toc.length + ' 条。改动正文后再次点击可刷新页码', 'success');
      if (layout.open) fetchPageView();
    }).catch(function (err) {
      setLoading(false);
      showToast(err.message || '目录生成失败', 'error');
    });
  }

  function printFormHtml(total) {
    return '<div class="dl-setup">'
      + field('pRange', '页码范围', '<label style="display:flex;gap:6px;align-items:center">'
        + '<input type="radio" name="dlRangeMode" value="all" checked> 全部（1–' + total + '）'
        + '</label><label style="display:flex;gap:6px;align-items:center;margin-top:4px">'
        + '<input type="radio" name="dlRangeMode" value="part"> 从'
        + '<input class="ss-input" type="number" id="dlRangeFrom" min="1" max="' + total + '" value="1" style="width:64px">'
        + '到<input class="ss-input" type="number" id="dlRangeTo" min="1" max="' + total + '" value="' + total + '" style="width:64px">'
        + '</label>')
      + field('pHf', '页眉页脚', '<label style="display:flex;gap:6px;align-items:center">'
        + '<input type="checkbox" id="dlHf" checked> 包含页眉页脚</label>')
      + '<div class="dl-setup-hint">打印 / 导出 PDF 都按页面视图的分页结果输出，两者版式一致。'
        + '导出 PDF 需服务器安装 Chromium，未安装时请用「打印」并在对话框选择「另存为 PDF」。</div>'
      + '</div>';
  }

  function collectPrintOpts(rootEl, total) {
    var radios = rootEl.querySelectorAll('input[name="dlRangeMode"]');
    var partial = false;
    for (var i = 0; i < radios.length; i++) if (radios[i].checked && radios[i].value === 'part') partial = true;
    var from = partial ? (parseInt((rootEl.querySelector('#dlRangeFrom') || {}).value, 10) || 1) : 1;
    var to = partial ? (parseInt((rootEl.querySelector('#dlRangeTo') || {}).value, 10) || total) : total;
    if (from > to) { var t = from; from = to; to = t; }
    return {
      from: Math.min(Math.max(1, from), total),
      to: Math.min(Math.max(1, to), total),
      headerFooter: (rootEl.querySelector('#dlHf') || {}).checked !== false
    };
  }

  function openPrintModal() {
    if (!layout.instance) { showToast('请先进入页面视图', 'info'); return; }
    var total = layout.pages || 0;
    if (!total) { showToast('文档暂无可打印内容', 'info'); return; }
    var box = document.createElement('div');
    box.innerHTML = printFormHtml(total);
    openModal({
      title: '打印 / 导出 PDF',
      body: box,
      actions: [
        { label: '取消' },
        {
          label: '🖨️ 打印',
          onClick: function (ctx) {
            var opts = collectPrintOpts(box, total);
            ctx.close();
            layout.instance.print(opts);
          }
        },
        {
          label: '📄 导出 PDF',
          className: 'ss-btn-primary',
          onClick: function (ctx) {
            var opts = collectPrintOpts(box, total);
            ctx.close();
            exportPdf(opts);
          }
        }
      ]
    });
  }

  function exportPdf(opts) {
    if (!API.exportPdf) { showToast('导出地址未配置', 'error'); return; }
    var payload = { from: opts.from, to: opts.to, headerFooter: opts.headerFooter };
    if (CFG.canEdit) {
      var snap = extractDocSnapshot();
      if (snap && snap.body) payload.doc = snap;
    }
    setLoading(true, '正在生成 PDF…');
    fetch(API.exportPdf, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CFG.csrf || '' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          throw Object.assign(new Error((json && json.error) || ('PDF 导出失败（' + res.status + '）')), { code: json && json.code });
        });
      }
      return res.blob();
    }).then(function (blob) {
      setLoading(false);
      downloadBlob(blob, (CFG.name || '文档') + '.pdf');
      showToast('PDF 已导出', 'success');
    }).catch(function (err) {
      setLoading(false);
      if (err.code === 'NO_BROWSER' && layout.instance) {
        layout.instance.print(opts);
      }
      showToast(err.message || 'PDF 导出失败', 'error');
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function fetchPageSetup() {
    return csrfFetch(API.pageSetup).then(function (json) {
      layout.setup = (json.data && json.data.pageSetup) || null;
      return layout.setup;
    });
  }

  function paperOptions() {
    return [
      { value: 'A4', label: 'A4（210 × 297 mm）' },
      { value: 'A5', label: 'A5（148 × 210 mm）' },
      { value: 'B5', label: 'B5（176 × 250 mm）' },
      { value: 'LETTER', label: 'Letter（216 × 279 mm）' },
      { value: 'CUSTOM', label: '自定义' }
    ];
  }

  function field(id, label, inputHtml, wide) {
    return '<label class="dl-setup-field' + (wide ? ' is-wide' : '') + '">' + escapeHtml(label)
      + '<span id="' + id + '">' + inputHtml + '</span></label>';
  }

  function setupFormHtml(s) {
    var opts = paperOptions().map(function (p) {
      return '<option value="' + p.value + '"' + (p.value === s.paper ? ' selected' : '') + '>' + p.label + '</option>';
    }).join('');
    return '<div class="dl-setup">'
      + field('fPaper', '纸张', '<select class="ss-input" data-k="paper">' + opts + '</select>')
      + field('fOrient', '方向', '<select class="ss-input" data-k="orientation">'
        + '<option value="portrait"' + (s.orientation === 'portrait' ? ' selected' : '') + '>纵向</option>'
        + '<option value="landscape"' + (s.orientation === 'landscape' ? ' selected' : '') + '>横向</option>'
        + '</select>')
      + field('fTop', '上边距（磅）', '<input class="ss-input" type="number" min="0" max="200" data-k="margins.top" value="' + s.margins.top + '">')
      + field('fBottom', '下边距（磅）', '<input class="ss-input" type="number" min="0" max="200" data-k="margins.bottom" value="' + s.margins.bottom + '">')
      + field('fLeft', '左边距（磅）', '<input class="ss-input" type="number" min="0" max="200" data-k="margins.left" value="' + s.margins.left + '">')
      + field('fRight', '右边距（磅）', '<input class="ss-input" type="number" min="0" max="200" data-k="margins.right" value="' + s.margins.right + '">')
      + field('fCols', '分栏', '<select class="ss-input" data-k="columns">'
        + [1, 2, 3, 4].map(function (n) {
          return '<option value="' + n + '"' + (n === s.columns ? ' selected' : '') + '>' + n + ' 栏</option>';
        }).join('') + '</select>')
      + field('fStart', '起始页码', '<input class="ss-input" type="number" min="1" max="9999" data-k="pageNumberStart" value="' + s.pageNumberStart + '">')
      + field('fHeader', '页眉', '<input class="ss-input" type="text" maxlength="80" data-k="header.content" placeholder="留空则不显示页眉" value="' + escapeHtml(s.header.content) + '">', true)
      + field('fFooter', '页脚', '<input class="ss-input" type="text" maxlength="80" data-k="footer.content" placeholder="可用 {PAGE} / {NUMPAGES} / {SECTION}" value="' + escapeHtml(s.footer.content) + '">', true)
      + '<div class="dl-setup-hint">页眉页脚留空即不显示；页脚默认显示「第 {PAGE} 页 / 共 {NUMPAGES} 页」。</div>'
      + '</div>';
  }

  function collectSetup(rootEl, base) {
    var out = {
      paper: base.paper, orientation: base.orientation,
      margins: {
        top: base.margins.top, bottom: base.margins.bottom,
        left: base.margins.left, right: base.margins.right
      },
      columns: base.columns, pageNumberStart: base.pageNumberStart,
      width: base.width, height: base.height,
      header: { enabled: Boolean(base.header && base.header.content), content: (base.header && base.header.content) || '' },
      footer: { enabled: Boolean(base.footer && base.footer.content), content: (base.footer && base.footer.content) || '' }
    };
    var nodes = rootEl.querySelectorAll('[data-k]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.dataset.k;
      var val = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value;
      if (key.indexOf('.') > 0) {
        var parts = key.split('.');
        if (!out[parts[0]]) out[parts[0]] = {};
        out[parts[0]][parts[1]] = val;
      } else {
        out[key] = val;
      }
    }
    out.header.enabled = Boolean(out.header.content);
    out.footer.enabled = Boolean(out.footer.content);
    return out;
  }

  function openPageSetupModal() {
    if (!CFG.canEdit || state.locked) {
      showToast('只读模式下不能修改页面设置', 'info');
      return;
    }
    setLoading(true, '正在读取页面设置…');
    fetchPageSetup().then(function (s) {
      setLoading(false);
      if (!s) { showToast('页面设置读取失败', 'error'); return; }
      var box = document.createElement('div');
      box.innerHTML = setupFormHtml(s);
      openModal({
        title: '页面设置',
        body: box,
        actions: [
          { label: '取消' },
          {
            label: '保存',
            className: 'ss-btn-primary',
            onClick: function (ctx) {
              var next = collectSetup(box, s);
              ctx.close();
              savePageSetup(next);
            }
          }
        ]
      });
    }).catch(function (err) {
      setLoading(false);
      showToast(err.message || '页面设置读取失败', 'error');
    });
  }

  function openHeaderFooterEditor(type, current) {
    if (!CFG.canEdit || state.locked) return;
    fetchPageSetup().then(function (s) {
      if (!s) return;
      var box = document.createElement('div');
      box.innerHTML = '<label class="dl-setup-field is-wide">'
        + (type === 'header' ? '页眉内容' : '页脚内容')
        + '<input class="ss-input" type="text" maxlength="80" id="hfInput" value="'
        + escapeHtml((s[type] && s[type].content) || current || '') + '">'
        + '<span class="dl-setup-hint">可用 {PAGE} / {NUMPAGES} / {SECTION} 占位符，留空则不显示。</span></label>';
      openModal({
        title: type === 'header' ? '编辑页眉' : '编辑页脚',
        body: box,
        actions: [
          { label: '取消' },
          {
            label: '保存',
            className: 'ss-btn-primary',
            onClick: function (ctx) {
              var input = box.querySelector('#hfInput');
              var next = JSON.parse(JSON.stringify(s));
              next[type] = { enabled: Boolean(input && input.value), content: (input && input.value) || '' };
              ctx.close();
              savePageSetup(next);
            }
          }
        ]
      });
      var focusEl = box.querySelector('#hfInput');
      if (focusEl) focusEl.focus();
    });
  }

  function savePageSetup(setup) {
    return csrfFetch(API.pageSetup, {
      method: 'PUT',
      body: JSON.stringify(setup)
    }).then(function (json) {
      var data = json.data || {};
      if (data.version) state.version = data.version;
      layout.setup = data.pageSetup || setup;
      setSaveStatus('is-saved', '已保存 v' + state.version);
      showToast('页面设置已保存', 'success');
      // 页面设置只影响版式，不需要同步回 Univer，直接按库里最新版本重绘
      return fetchPageView(true);
    }).catch(function (err) {
      if (err.status === 409) handleConflict();
      showToast(err.message || '页面设置保存失败', 'error');
    });
  }

  // ============ UI 绑定 ============

  function bindUi() {
    var saveBtn = $('btnSsSave');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveNow(true); });

    var commentBtn = $('btnSsComments');
    if (commentBtn) commentBtn.addEventListener('click', toggleCommentPanel);

    var commentClose = $('ssCommentClose');
    if (commentClose) commentClose.addEventListener('click', function () { toggleCommentPanel(); });

    var commentSend = $('ssCommentSend');
    if (commentSend) commentSend.addEventListener('click', sendComment);

    var commentInput = $('ssCommentInput');
    if (commentInput) commentInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); }
    });

    var versionBtn = $('btnSsVersions');
    if (versionBtn) versionBtn.addEventListener('click', openVersionModal);

    var shareBtn = $('btnSsShare');
    if (shareBtn) shareBtn.addEventListener('click', openShareModal);

    var permBtn = $('btnSsPerms');
    if (permBtn) permBtn.addEventListener('click', openPermModal);

    var applyBtn = $('btnSsApplyPerm');
    if (applyBtn) applyBtn.addEventListener('click', openApplyPermModal);

    var aiBtn = $('btnSsAi');
    if (aiBtn) aiBtn.addEventListener('click', openAiModal);

    var exportBtn = $('btnSsExport');
    if (exportBtn) exportBtn.addEventListener('click', exportDoc);

    var layoutBtn = $('btnDocLayout');
    if (layoutBtn) layoutBtn.addEventListener('click', toggleLayoutView);

    var readingBtn = $('btnDocReading');
    if (readingBtn) readingBtn.addEventListener('click', toggleReadingView);

    var stylesBtn = $('btnDocStyles');
    if (stylesBtn) stylesBtn.addEventListener('click', openStylesPanel);

    // 快捷键 Ctrl+S / Cmd+S
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (CFG.canEdit && !state.locked) saveNow(true);
      }
    });

    // 页签切到后台时停止轮询，回到前台恢复（小服务器减少无效请求）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { saveNow(false); stopPolling(); } else { startPolling(); }
    });

    // 页面关闭前保存
    window.addEventListener('pagehide', function () {
      if (state.dirty && CFG.canEdit && !state.locked) {
        var snapshot = extractDocSnapshot();
        if (snapshot) {
          // sendBeacon 无法自定义请求头：Content-Type 必须是 application/json 服务端才会解析，
          // CSRF 令牌改由 body._csrf 携带
          navigator.sendBeacon(API.doc, new Blob([JSON.stringify({
            doc: snapshot, baseVersion: state.version, structural: true,
            changeDesc: '页面关闭自动保存', _csrf: CFG.csrf || ''
          })], { type: 'application/json' }));
        }
      }
    });
  }

  // ============ 启动 ============

  function boot() {
    bindUi();
    if (!initUniver()) return;
    loadDoc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
