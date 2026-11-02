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
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
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
    if (!docInstance) return;
    // 监听命令执行（标记脏数据）
    if (typeof docInstance.onCommandExecuted === 'function') {
      docInstance.onCommandExecuted(function (cmd) {
        if (state.applyingRemote) return;
        var id = (cmd && cmd.id) || '';
        // 过滤非数据变更
        if (id.indexOf('doc.') === -1 && id.indexOf('document.') === -1) return;
        markDirty(true);
      });
    }
    // 备选：通过 univerAPI 全局监听
    if (typeof univerAPI.onCommandExecuted === 'function') {
      univerAPI.onCommandExecuted(function (cmd) {
        if (state.applyingRemote) return;
        var id = (cmd && cmd.id) || '';
        if (id.indexOf('.mutation.') === -1 && id.indexOf('doc.') === -1 && id.indexOf('document.') === -1) return;
        markDirty(true);
      });
    }
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
    if (!snap && docInstance._document && typeof docInstance._document.getSnapshot === 'function') {
      try { snap = docInstance._document.getSnapshot(); } catch (e) { snap = null; }
    }
    // 备选：通过 univerAPI 获取
    if (!snap && univerAPI && univerAPI.doc && typeof univerAPI.doc.getSnapshot === 'function') {
      try { snap = univerAPI.doc.getSnapshot(); } catch (e) { snap = null; }
    }
    return snap;
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

    if (ch.kind === 'doc-reload') {
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
    csrfFetch(API.share)
      .then(function (json) {
        var data = (json.data && json.data.share) || null;
        renderShareModal(data);
      })
      .catch(function (err) { showToast(err.message || '加载分享状态失败', 'error'); });
  }

  function renderShareModal(share) {
    var bodyHtml = '';
    if (share && share.token) {
      var link = location.origin + '/share/' + share.token;
      bodyHtml += '<div class="ss-field"><label>分享链接</label>'
        + '<div class="ss-share-link-row">'
        + '<input type="text" readonly value="' + escapeHtml(link) + '" id="shareLinkInput">'
        + '<button class="ss-btn" id="btnCopyShare">复制</button>'
        + '</div></div>'
        + '<div class="ss-share-stats">访问次数：<b>' + (share.visit_count || 0) + '</b></div>'
        + '<button class="ss-btn ss-btn-danger" id="btnCancelShare">取消分享</button>';
    } else {
      bodyHtml += '<p class="ss-hint">尚未开启分享，开启后所有获得链接的人可查看此文档。</p>'
        + '<button class="ss-btn ss-btn-primary" id="btnEnableShare">开启分享</button>';
    }
    var modal = openModal({ title: '🔗 分享文档', body: bodyHtml });

    if (share && share.token) {
      var copyBtn = modal.body.querySelector('#btnCopyShare');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var input = modal.body.querySelector('#shareLinkInput');
        if (input) { copyText(input.value).then(function () { showToast('已复制', 'success'); }); }
      });
      var cancelBtn = modal.body.querySelector('#btnCancelShare');
      if (cancelBtn) cancelBtn.addEventListener('click', function () {
        csrfFetch(API.share, { method: 'DELETE' })
          .then(function () { modal.close(); showToast('已取消分享', 'success'); })
          .catch(function (err) { showToast(err.message || '操作失败', 'error'); });
      });
    } else {
      var enableBtn = modal.body.querySelector('#btnEnableShare');
      if (enableBtn) enableBtn.addEventListener('click', function () {
        csrfFetch(API.share, { method: 'POST', body: JSON.stringify({}) })
          .then(function (json) {
            modal.close();
            showToast('分享已开启', 'success');
            openShareModal();
          })
          .catch(function (err) { showToast(err.message || '操作失败', 'error'); });
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

    // 快捷键 Ctrl+S / Cmd+S
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (CFG.canEdit && !state.locked) saveNow(true);
      }
    });

    // 页面关闭前保存
    window.addEventListener('beforeunload', function () {
      if (state.dirty && CFG.canEdit && !state.locked) {
        var snapshot = extractDocSnapshot();
        if (snapshot) {
          navigator.sendBeacon(API.doc, JSON.stringify({
            doc: snapshot, baseVersion: state.version, structural: true, changeDesc: '页面关闭自动保存'
          }));
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
