/* global UniverBundle */
/**
 * 演示文稿编辑器前端逻辑
 * 页面：views/frontend/presentation-editor.ejs（layout:false）
 * 自定义幻灯片编辑器 + 协同 + 自动保存
 */
(function () {
  'use strict';

  var CFG = window.__SHEET__ || {};
  var API = CFG.api || {};

  var AUTO_SAVE_MS = 3000;
  var CHANGES_POLL_MS = 4000;
  var PRESENCE_POLL_MS = 4000;
  var PRESENCE_BEAT_MS = 8000;
  var AVATAR_COLORS = ['#6366f1', '#059669', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#4d7c0f'];
  var PERM_NAMES = { view: '查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };

  var state = {
    version: CFG.version || 0,
    locked: Boolean(CFG.isLocked),
    publicRead: Boolean(CFG.isPublicRead),
    dirty: false,
    saving: false,
    lastSeq: 0,
    currentSlide: 0,
    doc: null
  };

  var pollTimer = null, presenceTimer = null, beatTimer = null;

  // ============ 工具函数 ============

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
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
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

  function openModal(opts) {
    var backdrop = document.createElement('div');
    backdrop.className = 'ss-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ss-modal' + (opts.large ? ' ss-modal-lg' : '');
    var head = document.createElement('div');
    head.className = 'ss-modal-head';
    head.innerHTML = '<h3>' + escapeHtml(opts.title || '') + '</h3>';
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

  // ============ 幻灯片渲染 ============

  function renderSlideNav() {
    var nav = $('pptSlideNav'); if (!nav || !state.doc) return;
    var slides = state.doc.slides || [];
    nav.innerHTML = '';
    slides.forEach(function (slide, idx) {
      var thumb = document.createElement('div');
      thumb.style.cssText = 'min-width:120px;height:68px;background:#fff;border:2px solid ' + (idx === state.currentSlide ? '#ec4899' : '#e2e8f0') + ';border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;color:#64748b;flex-shrink:0;position:relative';
      thumb.innerHTML = '<span>' + (idx + 1) + '. ' + escapeHtml((slide.title || '幻灯片').slice(0, 12)) + '</span>';
      thumb.addEventListener('click', function () { state.currentSlide = idx; renderCurrentSlide(); renderSlideNav(); });
      nav.appendChild(thumb);
    });
    // 添加新幻灯片按钮
    if (CFG.canEdit && !state.locked) {
      var addBtn = document.createElement('div');
      addBtn.style.cssText = 'min-width:120px;height:68px;background:#f8fafc;border:2px dashed #cbd5e1;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:24px;color:#94a3b8;flex-shrink:0';
      addBtn.textContent = '+';
      addBtn.title = '添加幻灯片';
      addBtn.addEventListener('click', addNewSlide);
      nav.appendChild(addBtn);
    }
  }

  function renderCurrentSlide() {
    var container = $('pptSlideContainer'); if (!container || !state.doc) return;
    var slides = state.doc.slides || [];
    var slide = slides[state.currentSlide];
    if (!slide) { container.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:40px">无幻灯片</div>'; return; }

    container.style.background = slide.background || '#ffffff';
    container.innerHTML = '';

    (slide.elements || []).forEach(function (el) {
      var div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:' + el.x + 'px;top:' + el.y + 'px;width:' + el.width + 'px;height:' + el.height + 'px;cursor:' + (CFG.canEdit && !state.locked ? 'move' : 'default');
      div.dataset.elId = el.id;

      if (el.type === 'text') {
        div.contentEditable = CFG.canEdit && !state.locked ? 'true' : 'false';
        div.style.cssText += ';font-size:' + (el.style && el.style.fontSize || 18) + 'px;font-weight:' + (el.style && el.style.fontWeight || 'normal') + ';text-align:' + (el.style && el.style.textAlign || 'left') + ';color:' + (el.style && el.style.color || '#333') + ';overflow:auto;padding:4px 8px;box-sizing:border-box;outline:none;border:1px solid transparent;border-radius:4px';
        div.textContent = el.content || '';
        div.addEventListener('focus', function () { div.style.borderColor = '#ec4899'; });
        div.addEventListener('blur', function () {
          div.style.borderColor = 'transparent';
          var newContent = div.textContent;
          if (newContent !== el.content) {
            el.content = newContent;
            markDirty();
          }
        });
      } else if (el.type === 'image') {
        var img = document.createElement('img');
        img.src = el.src || '';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain';
        div.appendChild(img);
      }

      container.appendChild(div);
    });
  }

  function addNewSlide() {
    if (!state.doc) return;
    if (!state.doc.slides) state.doc.slides = [];
    if (!state.doc.slideOrder) state.doc.slideOrder = [];
    var newId = 'slide_' + (state.doc.slides.length + 1) + '_' + Date.now();
    var newSlide = {
      id: newId, title: '新幻灯片', layout: 'blank',
      elements: [{
        id: 'title_' + Date.now(), type: 'text',
        x: 100, y: 200, width: 760, height: 80,
        content: '点击添加标题',
        style: { fontSize: 36, fontWeight: 'bold', textAlign: 'center', color: '#333333' }
      }],
      background: '#ffffff'
    };
    state.doc.slides.push(newSlide);
    state.doc.slideOrder.push(newId);
    state.currentSlide = state.doc.slides.length - 1;
    renderSlideNav();
    renderCurrentSlide();
    markDirty();
  }

  // ============ 加载与保存 ============

  function loadDoc() {
    return csrfFetch(API.doc).then(function (json) {
      var data = json.data || {};
      state.version = data.version || 0;
      state.locked = Boolean(data.locked);
      state.doc = data.doc || { slides: [], slideOrder: [] };
      setSaveStatus('is-saved', '已加载 v' + state.version);
      setLoading(false);
      renderSlideNav();
      renderCurrentSlide();
      startPolling();
    }).catch(function (err) {
      setLoading(false);
      setSaveStatus('is-error', '加载失败');
      showToast(err.message || '文档加载失败', 'error');
    });
  }

  function markDirty() {
    if (!CFG.canEdit || state.locked) return;
    state.dirty = true;
    setSaveStatus('is-dirty', '有未保存更改');
    scheduleSave();
  }

  var scheduleSave = debounce(function () { saveNow(false); }, AUTO_SAVE_MS);

  function saveNow(manual) {
    if (state.saving || !state.dirty || !CFG.canEdit || state.locked) return;
    if (!state.doc) return;
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
      showToast(err.message || '保存失败', 'error');
    });
  }

  // ============ 协同轮询 ============

  function startPolling() {
    pollTimer = setInterval(pollChanges, CHANGES_POLL_MS);
    presenceTimer = setInterval(pollPresence, PRESENCE_POLL_MS);
    beatTimer = setInterval(beatPresence, PRESENCE_BEAT_MS);
    pollChanges(); pollPresence(); beatPresence();
  }

  function pollChanges() {
    csrfFetch(API.changes + '?since=' + (state.lastSeq || 0))
      .then(function (json) {
        var changes = (json.data && json.data.changes) || [];
        changes.forEach(function (ch) {
          if (ch.seq <= state.lastSeq) return;
          state.lastSeq = ch.seq;
          if (ch.kind === 'doc-reload' && !state.dirty) {
            csrfFetch(API.doc).then(function (j) {
              var d = j.data || {};
              state.version = d.version || 0;
              state.doc = d.doc || state.doc;
              renderSlideNav(); renderCurrentSlide();
              setSaveStatus('is-saved', '已同步 v' + state.version);
            }).catch(function () {});
          }
        });
      }).catch(function () {});
  }

  function pollPresence() {
    csrfFetch(API.presence).then(function (json) {
      var users = (json.data && json.data.users) || [];
      renderPresenceBar(users);
    }).catch(function () {});
  }

  function beatPresence() {
    csrfFetch(API.presence, { method: 'POST', body: JSON.stringify({ mode: CFG.canEdit ? 'edit' : 'view' }) }).catch(function () {});
  }

  function renderPresenceBar(users) {
    var bar = $('ssPresenceBar'); if (!bar) return;
    bar.innerHTML = '';
    if (!Array.isArray(users) || users.length === 0) return;
    users.slice(0, 8).forEach(function (u) {
      var el = document.createElement('span');
      el.className = 'ss-presence-avatar';
      el.style.background = hashColor(u.username);
      el.textContent = (u.username || '?').charAt(0).toUpperCase();
      el.title = u.username + ' · ' + (u.mode === 'edit' ? '编辑中' : '在线');
      bar.appendChild(el);
    });
    if (users.length > 8) {
      var more = document.createElement('span');
      more.className = 'ss-presence-avatar';
      more.style.background = '#94a3b8';
      more.textContent = '+' + (users.length - 8);
      bar.appendChild(more);
    }
  }

  // ============ 版本历史 ============

  function openVersionModal() {
    csrfFetch(API.versions).then(function (json) {
      var versions = (json.data && json.data.versions) || [];
      var bodyHtml = '<div style="margin-bottom:12px"><button class="ss-btn ss-btn-primary" id="btnCreateVersion">📸 创建当前版本快照</button></div>';
      if (versions.length === 0) {
        bodyHtml += '<div class="ss-comment-empty">暂无历史版本</div>';
      } else {
        bodyHtml += versions.map(function (v) {
          var isCurrent = v.version === state.version;
          return '<div class="ss-version-item' + (isCurrent ? ' is-current' : '') + '">'
            + '<div class="ss-version-info"><div class="ver">v' + v.version + (isCurrent ? ' （当前）' : '') + '</div>'
            + '<div class="desc">' + escapeHtml(v.change_desc || '') + '</div>'
            + '<div class="meta">' + escapeHtml(v.username || '') + ' · ' + fmtTime(v.created_at) + '</div></div>'
            + '<div>' + (!isCurrent ? '<button class="ss-btn" data-restore-ver="' + v.version + '">恢复</button>' : '') + '</div></div>';
        }).join('');
      }
      var modal = openModal({ title: '🕘 历史版本', large: true, body: bodyHtml });
      var createBtn = modal.body.querySelector('#btnCreateVersion');
      if (createBtn) createBtn.addEventListener('click', function () {
        csrfFetch(API.versions, { method: 'POST', body: JSON.stringify({ changeDesc: '手动创建版本快照' }) })
          .then(function () { showToast('版本快照已创建', 'success'); modal.close(); })
          .catch(function (err) { showToast(err.message || '创建失败', 'error'); });
      });
      modal.body.querySelectorAll('[data-restore-ver]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('确定恢复到版本 v' + btn.dataset.restoreVer + '？')) return;
          csrfFetch(API.versions + '/' + btn.dataset.restoreVer + '/restore', { method: 'POST' })
            .then(function () { showToast('已恢复', 'success'); modal.close(); loadDoc(); })
            .catch(function (err) { showToast(err.message || '恢复失败', 'error'); });
        });
      });
    }).catch(function (err) { showToast(err.message || '加载版本失败', 'error'); });
  }

  // ============ 分享 & 权限 ============

  function openShareModal() {
    var modal = openModal({ title: '🔗 分享演示文稿', body: '<div class="ss-inline-loading">加载分享状态…</div>' });
    csrfFetch(API.share).then(function (json) {
      renderShareModal(modal, json.data || {});
    }).catch(function (err) {
      modal.body.innerHTML = '<p class="ss-inline-error">' + escapeHtml(err.message || '加载分享状态失败') + '</p>';
    });
  }

  // /api/presentation/:id/share 返回 data = {shared,status,token,url,embedUrl,viewCount,createdAt}
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
        + '<p class="ss-hint">获得链接的人无需登录即可在线放映，分享页不支持下载。</p>'
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
    var bodyHtml = '<p class="ss-hint">您目前没有访问权限</p><div class="ss-field"><label>申请类型</label><select id="applyPermType">';
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

  function exportPpt() {
    if (state.dirty) saveNow(true);
    window.open(API.export + '?format=html', '_blank');
  }

  // ============ UI 绑定 ============

  function bindUi() {
    var saveBtn = $('btnSsSave'); if (saveBtn) saveBtn.addEventListener('click', function () { saveNow(true); });
    var versionBtn = $('btnSsVersions'); if (versionBtn) versionBtn.addEventListener('click', openVersionModal);
    var shareBtn = $('btnSsShare'); if (shareBtn) shareBtn.addEventListener('click', openShareModal);
    var permBtn = $('btnSsPerms'); if (permBtn) permBtn.addEventListener('click', openPermModal);
    var applyBtn = $('btnSsApplyPerm'); if (applyBtn) applyBtn.addEventListener('click', openApplyPermModal);
    var exportBtn = $('btnSsExport'); if (exportBtn) exportBtn.addEventListener('click', exportPpt);

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (CFG.canEdit && !state.locked) saveNow(true); }
    });

    window.addEventListener('beforeunload', function () {
      if (state.dirty && CFG.canEdit && !state.locked && state.doc) {
        navigator.sendBeacon(API.doc, JSON.stringify({ doc: state.doc, baseVersion: state.version, structural: true, changeDesc: '页面关闭自动保存' }));
      }
    });
  }

  // ============ 启动 ============

  function boot() {
    bindUi();
    loadDoc();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
