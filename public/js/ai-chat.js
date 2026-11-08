/**
 * AI 聊天前端逻辑：会话管理、SSE 流式对话、消息操作、世界书/记忆/分支/角色/模型
 * 依赖 views/frontend/layout 的 utils.js（csrfFetch/showToast/escapeHtml/copyToClipboard）
 */
(function () {
  'use strict';

  var dataEl = document.getElementById('ai-chat-data');
  var page = dataEl ? JSON.parse(dataEl.textContent) : {};
  var csrfToken = page.csrfToken || getCsrfToken() || '';
  var canPickPrompt = !!page.canPickPrompt;
  var canShareLink = !!page.canShareLink;
  var prompts = page.prompts || [];

  var state = {
    conversations: [],
    roles: [],
    models: [],
    globalModels: [],
    providers: [],
    settings: { aiEnabled: true, streamEnabled: true },
    quota: null,
    quotaUnlimited: false,
    currentConv: null,
    messages: [],
    branches: [],
    worldBook: [],
    summaries: [],
    streaming: false,
    abortController: null,
    convSearch: ''
  };

  var els = {};
  ['acConvList', 'acConvSearch', 'acNewChat', 'acQuotaBadge', 'acConvTitle', 'acMessages', 'acEmpty',
    'acInput', 'acSend', 'acStop', 'acRoleBtn', 'acRoleLabel', 'acWorldBtn', 'acMemoryBtn', 'acBranchBtn',
    'acModelBtn', 'acModelLabel', 'acModelModal', 'acModelList',
    'acRoleModal', 'acRoleList', 'acRoleCreate', 'acRoleCreateModal', 'acNewRoleName', 'acNewRolePrompt', 'acNewRoleGreeting', 'acNewRoleDesc', 'acNewRolePersonality', 'acNewRoleScenario', 'acNewRoleExamples', 'acRoleSave',
    'acWorldModal', 'acWorldList', 'acWorldAdd', 'acWorldImport', 'acWorldEditModal', 'acWorldEditTitle', 'acWorldKey', 'acWorldPos',
    'acWorldContent', 'acWorldConstant', 'acWorldSave', 'acWorldDelete', 'acMemoryModal', 'acMemoryEnabled', 'acRagEnabled', 'acMemoryMode', 'acMemorySave', 'acMemoryRefresh',
    'acBranchModal', 'acBranchList', 'acMsgMenu', 'acMenuBtn', 'acSidebar',
    'acModelsToggle', 'acModelsBody', 'acMyModels', 'acGlobalModels', 'acModelAddBtn', 'acModelAddRow',
    'acmProvider', 'acmKey', 'acmEndpoint', 'acmApiKey', 'acmDefault', 'acmSave', 'acmCancel', 'acmGetWrap', 'acmGetLink',
    'acmFetch', 'acmFetchWrap', 'acmFetchList', 'acmFetchUse', 'acmFetchTip',
    'acShareBtn', 'acShareModal', 'acShareUrl', 'acShareCopy', 'acShareToggle',
    'acPickPrompt', 'acPromptModal', 'acPromptSearch', 'acPromptList', 'acPromptCount', 'acPromptMore',
    'acFullscreenBtn', 'acApp',
    'acTtsSettings', 'acTtsVoice', 'acTtsRate', 'acTtsRateVal', 'acTtsPitch', 'acTtsPitchVal', 'acTtsToggle',
    'acRoleImport', 'acRoleExport', 'acRoleFileInput',
    'acRoleImportUrl', 'acRoleUrlModal', 'acRoleUrlInput', 'acRoleUrlFetch',
    'acRoleSearch', 'acRoleFilter', 'acChatExport', 'acChatImport', 'acChatFileInput',
    'acNewRoleAvatar', 'acNewRoleAvatarFile', 'acNewRoleAvatarBtn', 'acNewRoleAvatarPreview',
    'acWorldSearch', 'acWorldCount', 'acWorldEnableAll', 'acWorldDisableAll', 'acWorldDeleteAll']
    .forEach(function (id) { els[id] = document.getElementById(id); });

  // ============ 通用请求 ============

  function api(url, data) {
    return csrfFetch(url, {
      method: 'POST',
      body: JSON.stringify(data || {})
    }, 20000).catch(function (err) {
      throw new Error((err && err.message) || '网络请求失败');
    });
  }

  // 自动获取模型列表（更长超时，服务商 /models 接口可能较慢）
  function fetchModelsApi(payload) {
    return csrfFetch('/ai-chat/api/models/fetch', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    }, 35000).catch(function (err) {
      throw new Error((err && err.message) || '获取模型失败');
    });
  }

  // SSE 流式请求（自定义：外部 signal + X-CSRF-Token；onEvent(event, data)，结束回调 '__end__'）
  function streamFetch(url, body, onEvent, signal) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        // 错误响应可能不是 JSON（如网关 502 HTML 页），兜底显示 HTTP 状态
        return resp.json().catch(function () { return null; }).then(function (j) {
          var err = new Error((j && j.error) || '请求失败（HTTP ' + resp.status + '）');
          err.status = resp.status;
          throw err;
        });
      }
      if (!resp.body || !resp.body.getReader) {
        throw new Error('当前浏览器不支持流式响应');
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function parseBlock(block) {
        var event = 'message';
        var data = '';
        block.split('\n').forEach(function (line) {
          if (line.indexOf('event: ') === 0) event = line.slice(7).trim();
          else if (line.indexOf('data: ') === 0) data += line.slice(6);
        });
        if (!data) return;
        try { onEvent(event, JSON.parse(data)); } catch (e) { /* 忽略解析失败 */ }
      }
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            onEvent('__end__', null);
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          var blocks = buffer.split('\n\n');
          buffer = blocks.pop();
          blocks.forEach(parseBlock);
          return pump();
        });
      }
      return pump();
    });
  }

  // ============ 引导数据 ============

  function loadBootstrap(opts) {
    var autoSelect = !opts || opts.autoSelect !== false;
    return fetch('/ai-chat/api/bootstrap', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '加载失败');
        var d = json.data;
        state.conversations = d.conversations || [];
        state.roles = d.roles || [];
        state.models = d.models || [];
        state.globalModels = d.globalModels || [];
        state.providers = d.providers || [];
        state.settings = {
          aiEnabled: !!d.aiEnabled,
          streamEnabled: !!d.streamEnabled,
          allowUserModels: !!d.allowUserModels,
          memoryDefaults: d.memoryDefaults || {}
        };
        state.quota = d.quota || null;
        state.quotaUnlimited = !!d.quotaUnlimited;
        renderConversations();
        renderQuota();
        renderMyModels();
        renderProviderOptions();
        if (autoSelect && state.conversations.length) {
          selectConversation(state.conversations[0].id);
        }
        return true;
      });
  }

  // ============ 我的 API 模型（与 AI 生图 Key 填写一致） ============

  function renderProviderOptions() {
    if (!els.acmProvider) return;
    var cur = els.acmProvider.value;
    els.acmProvider.innerHTML = '<option value="">自定义</option>';
    state.providers.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.provider_key;
      opt.textContent = p.name + (p.requires_key ? '' : '（免费）');
      els.acmProvider.appendChild(opt);
    });
    if (cur) els.acmProvider.value = cur;
  }

  // 选择内置提供商 → 自动带出端点/默认模型/获取链接
  function applyProviderPreset() {
    var key = els.acmProvider.value;
    if (!key) {
      els.acmEndpoint.value = '';
      els.acmKey.value = '';
      els.acmGetWrap.hidden = true;
      return;
    }
    var p = state.providers.filter(function (x) { return x.provider_key === key; })[0];
    if (!p) return;
    els.acmEndpoint.value = p.api_base || '';
    els.acmKey.value = p.default_model || '';
    if (p.api_key_url) {
      els.acmGetLink.href = p.api_key_url;
      els.acmGetWrap.hidden = false;
    } else {
      els.acmGetWrap.hidden = true;
    }
  }

  function renderMyModels() {
    // 全局模型（只读展示）
    var g = els.acGlobalModels;
    g.innerHTML = '';
    if (state.globalModels.length) {
      var label = document.createElement('span');
      label.textContent = '站长全局模型：';
      g.appendChild(label);
      state.globalModels.forEach(function (m) {
        var s = document.createElement('span');
        s.textContent = m.name + (m.is_default ? ' ★' : '');
        g.appendChild(s);
      });
    } else {
      g.textContent = '站长未配置全局模型；添加我的模型优先使用，未配置时走免费兜底。';
    }

    // 我的模型行
    var wrap = els.acMyModels;
    wrap.innerHTML = '';
    if (!state.models.length) {
      wrap.innerHTML = '<p style="font-size:12px;color:var(--ac-muted);padding:6px 0;">还没有我的模型。选择下方内置提供商，填入 API Key 即可使用。</p>';
      return;
    }
    state.models.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'ac-model-line';
      row.dataset.modelId = m.id;

      var name = document.createElement('div');
      name.className = 'ac-model-line-name';
      var nm = document.createElement('span');
      nm.textContent = m.name;
      var mk = document.createElement('small');
      mk.textContent = m.model_key + (m.is_default ? ' ★默认' : '');
      name.appendChild(nm);
      name.appendChild(mk);

      var status = document.createElement('span');
      status.className = 'ac-model-line-status' + (m.has_key ? ' ok' : '');
      status.textContent = m.has_key ? '✓ 已配置' : '未配置';

      var ep = document.createElement('input');
      ep.type = 'text';
      ep.className = 'ac-model-input';
      ep.value = m.api_endpoint || '';
      ep.placeholder = 'API 端点';
      ep.setAttribute('data-f-role', 'ep');

      var key = document.createElement('input');
      key.type = 'password';
      key.className = 'ac-model-input';
      key.placeholder = m.has_key ? '已配置，填入覆盖' : 'API Key';
      key.setAttribute('data-f-role', 'key');

      var def = document.createElement('button');
      def.type = 'button';
      def.className = 'ac-btn ac-btn-sm';
      def.textContent = m.is_default ? '★ 默认' : '设为默认';
      def.addEventListener('click', function () { setDefaultMyModel(m.id); });

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'ac-btn ac-btn-primary ac-btn-sm';
      save.textContent = '保存';
      save.addEventListener('click', function () { saveMyModel(m, ep.value.trim(), key.value.trim()); });

      var test = document.createElement('button');
      test.type = 'button';
      test.className = 'ac-btn ac-btn-sm';
      test.textContent = '测试';
      test.addEventListener('click', function () { testMyModel(m.id, test); });

      var fetchBtn = document.createElement('button');
      fetchBtn.type = 'button';
      fetchBtn.className = 'ac-btn ac-btn-sm';
      fetchBtn.textContent = '获取';
      fetchBtn.title = '按端点 + Key 自动获取可用模型';
      fetchBtn.setAttribute('data-f-role', 'fetch');
      fetchBtn.addEventListener('click', function () { fetchModelsForRow(m, row); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ac-btn ac-btn-sm';
      del.textContent = '删除';
      del.addEventListener('click', function () { deleteMyModel(m.id); });

      row.appendChild(name);
      row.appendChild(status);
      row.appendChild(ep);
      row.appendChild(key);
      row.appendChild(def);
      row.appendChild(save);
      row.appendChild(test);
      row.appendChild(fetchBtn);
      row.appendChild(del);
      wrap.appendChild(row);
    });
  }

  function saveMyModel(m, endpoint, apiKey, modelKey) {
    api('/ai-chat/api/models', {
      id: m.id,
      name: m.name,
      model_key: modelKey || m.model_key,
      provider: m.provider,
      api_endpoint: endpoint,
      api_key: apiKey,
      is_default: m.is_default ? 1 : 0
    }).then(function () {
      showToast('已保存', 'success');
      loadBootstrap({ autoSelect: false });
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // 已有模型行：按行内端点 + Key 获取模型列表，选择后直接更新该模型的 model_key
  function fetchModelsForRow(m, rowEl) {
    var ep = rowEl.querySelector('[data-f-role="ep"]').value.trim();
    var key = rowEl.querySelector('[data-f-role="key"]').value.trim();
    var btn = rowEl.querySelector('[data-f-role="fetch"]');
    if (!ep && !key) { showToast('请先填写 API 端点与 API Key', 'error'); return; }
    btn.disabled = true;
    btn.textContent = '…';
    fetchModelsApi({ id: m.id, api_endpoint: ep, api_key: key })
      .then(function (json) {
        var list = json.data || [];
        var old = rowEl.parentNode.querySelector('.ac-model-fetch-row[data-for="' + m.id + '"]');
        if (old) old.remove();
        var bar = document.createElement('div');
        bar.className = 'ac-model-fetch-row';
        bar.dataset.for = m.id;
        var sel = document.createElement('select');
        sel.className = 'ac-model-input';
        list.forEach(function (md) {
          var opt = document.createElement('option');
          opt.value = md.id;
          opt.textContent = md.id + (md.owned_by ? '（' + md.owned_by + '）' : '');
          sel.appendChild(opt);
        });
        var use = document.createElement('button');
        use.type = 'button';
        use.className = 'ac-btn ac-btn-primary ac-btn-sm';
        use.textContent = '设为模型';
        use.addEventListener('click', function () {
          if (!sel.value) return;
          saveMyModel(m, ep, key, sel.value);
          bar.remove();
        });
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ac-btn ac-btn-sm';
        cancel.textContent = '取消';
        cancel.addEventListener('click', function () { bar.remove(); });
        var tip = document.createElement('span');
        tip.className = 'ac-model-fetch-tip';
        tip.textContent = '共 ' + list.length + ' 个模型';
        bar.appendChild(sel);
        bar.appendChild(use);
        bar.appendChild(cancel);
        bar.appendChild(tip);
        rowEl.after(bar);
      })
      .catch(function (err) { showToast(err.message, 'error'); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '获取';
      });
  }

  function setDefaultMyModel(id) {
    var m = state.models.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    api('/ai-chat/api/models', {
      id: m.id, name: m.name, model_key: m.model_key, provider: m.provider,
      api_endpoint: m.api_endpoint, api_key: '', is_default: 1
    }).then(function () {
      showToast('已设为默认', 'success');
      loadBootstrap({ autoSelect: false });
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function deleteMyModel(id) {
    if (!window.confirm('确定删除该模型？')) return;
    api('/ai-chat/api/models/delete', { id: id }).then(function () {
      showToast('已删除', 'success');
      loadBootstrap({ autoSelect: false });
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function testMyModel(id, btn) {
    btn.disabled = true;
    btn.textContent = '测试中…';
    api('/ai-chat/api/models/test', { id: id }).then(function (json) {
      showToast('连接成功：' + String((json.data && json.data.reply) || '').slice(0, 60), 'success');
    }).catch(function (err) {
      showToast(err.message || '测试失败', 'error');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '测试';
    });
  }

  function resetAddModelForm() {
    els.acModelAddRow.hidden = true;
    els.acModelAddBtn.style.display = '';
    els.acmProvider.value = '';
    els.acmKey.value = '';
    els.acmEndpoint.value = '';
    els.acmApiKey.value = '';
    els.acmDefault.checked = false;
    els.acmGetWrap.hidden = true;
    els.acmFetchWrap.hidden = true;
    els.acmFetchList.innerHTML = '';
    els.acmFetchTip.textContent = '';
  }

  // ============ 提示词库选择（同 AI 生图：浏览全部 + 搜索 + 分页） ============
  var PROMPT_PAGE_SIZE = 100;
  var promptFilter = '';
  var promptShown = 0;

  function matchedPrompts() {
    var f = promptFilter.toLowerCase();
    if (!f) return prompts;
    return prompts.filter(function (p) {
      return (p.title || '').toLowerCase().indexOf(f) !== -1 ||
        (p.excerpt || '').toLowerCase().indexOf(f) !== -1;
    });
  }

  function renderPromptList(append) {
    if (!els.acPromptList) return;
    var list = matchedPrompts();
    if (!append) {
      els.acPromptList.innerHTML = '';
      promptShown = 0;
    }
    var chunk = list.slice(promptShown, promptShown + PROMPT_PAGE_SIZE);
    promptShown += chunk.length;
    if (!chunk.length) {
      if (promptShown === 0) {
        els.acPromptList.innerHTML = '<p style="font-size:13px;color:var(--text-muted);padding:14px 0;">未找到匹配的提示词</p>';
      }
      els.acPromptCount.textContent = '共 ' + list.length + ' 条';
      els.acPromptMore.style.display = 'none';
      return;
    }
    var html = '';
    chunk.forEach(function (p) {
      html += '<div class="ac-prompt-item" data-id="' + p.id + '">' +
        '<div class="ac-prompt-item-title">' + escapeHtml(p.title) + '</div>' +
        (p.excerpt ? '<div class="ac-prompt-item-excerpt">' + escapeHtml(p.excerpt) + '</div>' : '') +
        '</div>';
    });
    if (append) {
      els.acPromptList.insertAdjacentHTML('beforeend', html);
    } else {
      els.acPromptList.innerHTML = html;
    }
    els.acPromptCount.textContent = '共 ' + list.length + ' 条' + (promptShown < list.length ? ' · 已显示 ' + promptShown : '');
    els.acPromptMore.style.display = promptShown < list.length ? '' : 'none';
  }

  function openPromptPicker() {
    els.acPromptSearch.value = '';
    promptFilter = '';
    renderPromptList(false);
    showModal('acPromptModal');
    els.acPromptSearch.focus();
  }

  // ============ 会话分享链接（同 AI 生图分享链接） ============
  var shareToken = null;
  var shareEnabled = true;

  function updateShareBtn() {
    if (!els.acShareBtn) return;
    els.acShareBtn.style.display = (canShareLink && state.currentConv) ? '' : 'none';
  }

  function openShareModal() {
    if (!state.currentConv) return;
    api('/share/api/create', { source_type: 'ai_chat', source_id: state.currentConv.id })
      .then(function (json) {
        if (json.success) {
          shareToken = json.token;
          shareEnabled = true;
          els.acShareUrl.value = location.origin + json.url;
          els.acShareToggle.style.display = 'inline-block';
          els.acShareToggle.textContent = '停用链接';
          els.acShareToggle.className = 'ac-btn ac-btn-danger ac-btn-sm';
          showModal('acShareModal');
          els.acShareUrl.select();
        } else {
          showToast(json.error || '创建分享链接失败', 'error');
        }
      })
      .catch(function (err) { showToast(err.message || '创建分享链接失败', 'error'); });
  }

  function toggleShare() {
    if (!shareToken) return;
    api('/share/api/' + (shareEnabled ? 'disable' : 'enable'), { token: shareToken })
      .then(function (json) {
        if (json.success) {
          shareEnabled = !shareEnabled;
          els.acShareToggle.textContent = shareEnabled ? '停用链接' : '启用链接';
          els.acShareToggle.className = shareEnabled
            ? 'ac-btn ac-btn-danger ac-btn-sm'
            : 'ac-btn ac-btn-primary ac-btn-sm';
          showToast(shareEnabled ? '链接已启用' : '链接已停用', 'success');
        } else {
          showToast(json.error || '操作失败', 'error');
        }
      })
      .catch(function (err) { showToast(err.message || '操作失败', 'error'); });
  }

  // ============ 渲染：会话栏 ============

  function renderConversations() {
    var kw = state.convSearch.toLowerCase();
    var list = state.conversations.filter(function (c) {
      return !kw || String(c.title || '').toLowerCase().indexOf(kw) !== -1;
    });
    els.acConvList.innerHTML = '';
    if (!list.length) {
      els.acConvList.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--ac-muted);text-align:center;">暂无会话</div>';
      return;
    }
    list.forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'ac-conv-item' + (state.currentConv && state.currentConv.id === c.id ? ' active' : '');
      item.innerHTML = '<span class="ac-conv-title-sm"></span><button type="button" class="ac-conv-del" title="删除会话">✕</button>';
      item.querySelector('.ac-conv-title-sm').textContent = c.title || '新对话';
      item.addEventListener('click', function (e) {
        if (e.target.classList.contains('ac-conv-del')) return;
        selectConversation(c.id);
      });
      item.addEventListener('dblclick', function () {
        var title = window.prompt('重命名会话', c.title || '');
        if (title && title.trim() && title.trim() !== c.title) {
          api('/ai-chat/api/conversations/rename', { id: c.id, title: title.trim() }).then(function () {
            c.title = title.trim();
            renderConversations();
          }).catch(function (err) { showToast(err.message, 'error'); });
        }
      });
      item.querySelector('.ac-conv-del').addEventListener('click', function (e) {
        e.stopPropagation();
        if (!window.confirm('确定删除该会话？所有消息将一并删除')) return;
        api('/ai-chat/api/conversations/delete', { id: c.id }).then(function () {
          state.conversations = state.conversations.filter(function (x) { return x.id !== c.id; });
          if (state.currentConv && state.currentConv.id === c.id) {
            state.currentConv = null;
            state.messages = [];
            renderMessages();
            els.acConvTitle.textContent = '新对话';
            updateModelLabel();
          }
          renderConversations();
        }).catch(function (err) { showToast(err.message, 'error'); });
      });
      els.acConvList.appendChild(item);
    });
  }

  function renderQuota() {
    if (state.quotaUnlimited) {
      els.acQuotaBadge.textContent = '管理员 · 不限量';
      els.acQuotaBadge.className = 'ac-quota-badge';
      return;
    }
    var q = state.quota || {};
    var remaining = typeof q.remaining === 'number' ? q.remaining : q.dailyLimit - q.dailyUsed;
    els.acQuotaBadge.textContent = '今日剩余 ' + Math.max(0, remaining) + '/' + (q.dailyLimit || 0);
    els.acQuotaBadge.className = 'ac-quota-badge' + (remaining <= 0 ? ' blocked' : remaining <= 5 ? ' warn' : '');
  }

  // ============ 会话选择 / 消息加载 ============

  function selectConversation(convId) {
    var conv = state.conversations.filter(function (c) { return c.id === convId; })[0];
    if (!conv) return;
    state.currentConv = conv;
    renderConversations();
    els.acConvTitle.textContent = conv.title || '新对话';
    updateRoleLabel();
    updateModelLabel();
    updateShareBtn();
    closeAllModals();
    fetch('/ai-chat/api/conversations/' + conv.id + '/messages', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '加载失败');
        state.messages = json.data.messages || [];
        state.branches = json.data.branches || [];
        state.worldBook = json.data.worldBook || [];
        state.summaries = json.data.summaries || [];
        renderMessages();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  function updateRoleLabel() {
    var role = null;
    if (state.currentConv && state.currentConv.role_id) {
      role = state.roles.filter(function (r) { return r.id === state.currentConv.role_id; })[0] || null;
    }
    els.acRoleLabel.textContent = role ? role.name : '角色';
    els.acRoleBtn.classList.toggle('active', !!role);
  }

  // ============ 会话模型选择 ============

  function updateModelLabel() {
    var key = state.currentConv ? (state.currentConv.model || '') : '';
    var name = '';
    if (key) {
      var m = state.models.filter(function (x) { return x.model_key === key; })[0] ||
        state.globalModels.filter(function (x) { return x.model_key === key; })[0];
      name = m ? m.name : key;
    }
    els.acModelLabel.textContent = name || '自动';
    els.acModelBtn.classList.toggle('active', !!name);
  }

  function openModelModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    renderModelList();
    showModal('acModelModal');
  }

  function renderModelList() {
    var wrap = els.acModelList;
    wrap.innerHTML = '';
    var cur = state.currentConv.model || '';

    var auto = document.createElement('div');
    auto.className = 'ac-model-pick-item' + (cur ? '' : ' active');
    auto.innerHTML = '<div class="ac-model-pick-info"><div class="ac-model-pick-name">自动选择<small>我的模型 → 全局模型 → 默认/免费兜底</small></div></div><span class="ac-model-pick-tag">推荐</span>';
    auto.addEventListener('click', function () { pickModel(''); });
    wrap.appendChild(auto);

    var items = [];
    state.models.forEach(function (m) { items.push({ m: m, scope: '我的' }); });
    state.globalModels.forEach(function (m) { items.push({ m: m, scope: '全局' }); });
    if (!items.length) {
      wrap.appendChild(emptyModelHint());
      return;
    }
    items.forEach(function (it) {
      var m = it.m;
      var usable = it.scope !== '我的' || !!m.has_key;
      var item = document.createElement('div');
      item.className = 'ac-model-pick-item' + (cur === m.model_key ? ' active' : '') + (usable ? '' : ' disabled');
      var info = document.createElement('div');
      info.className = 'ac-model-pick-info';
      var name = document.createElement('div');
      name.className = 'ac-model-pick-name';
      name.textContent = m.name;
      var sub = document.createElement('small');
      sub.textContent = m.model_key + (m.is_default ? ' · 默认' : '');
      name.appendChild(sub);
      info.appendChild(name);
      item.appendChild(info);
      var tag = document.createElement('span');
      tag.className = 'ac-model-pick-tag';
      tag.textContent = usable ? it.scope : '未配置 Key';
      item.appendChild(tag);
      if (usable) {
        item.addEventListener('click', function () { pickModel(m.model_key); });
      }
      wrap.appendChild(item);
    });
  }

  function emptyModelHint() {
    var p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:var(--text-muted);padding:14px 0;';
    p.textContent = '当前没有可用模型，可在上方「我的 API 模型」卡片添加，或等待站长配置全局模型。';
    return p;
  }

  function pickModel(modelKey) {
    api('/ai-chat/api/conversations/model', { id: state.currentConv.id, model: modelKey })
      .then(function () {
        state.currentConv.model = modelKey;
        updateModelLabel();
        hideModal('acModelModal');
        showToast(modelKey ? '模型已切换' : '已切换为自动选择', 'success');
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 消息渲染 ============

  function renderMessages() {
    els.acMessages.innerHTML = '';
    els.acEmpty.style.display = state.messages.length ? 'none' : 'block';
    if (!state.messages.length) {
      renderEmptyHint();
      return;
    }
    state.messages.forEach(function (m) {
      appendMessageEl(m, false);
    });
    scrollToBottom(true);
  }

  function renderEmptyHint() {
    var hint = els.acEmpty.querySelector('.ac-empty-hint');
    if (!hint) return;
    var official = state.roles.filter(function (r) { return r.is_official; }).slice(0, 4);
    hint.innerHTML = '';
    official.forEach(function (r) {
      var chip = document.createElement('button');
      chip.className = 'ac-btn ac-btn-sm';
      chip.style.cssText = 'margin:4px;';
      chip.textContent = '🎭 ' + r.name;
      chip.addEventListener('click', function () { startWithRole(r.id); });
      hint.appendChild(chip);
    });
  }

  function appendMessageEl(m, streaming) {
    var el = document.createElement('div');
    el.className = 'ac-msg ' + (m.role === 'user' ? 'user' : 'assistant');
    el.dataset.id = m.id;

    var avatar = document.createElement('div');
    avatar.className = 'ac-msg-avatar';
    avatar.textContent = m.role === 'user' ? '🧑' : '🤖';

    var body = document.createElement('div');
    body.className = 'ac-msg-body';

    var meta = document.createElement('div');
    meta.className = 'ac-msg-meta';
    var name = document.createElement('span');
    name.textContent = m.role === 'user' ? '我' : (getCurrentRoleName() || 'AI');
    meta.appendChild(name);
    if (m.branch_id && m.branch_id !== 0) {
      var tag = document.createElement('span');
      tag.className = 'ac-msg-branch-tag';
      tag.textContent = '分支' + m.branch_id;
      meta.appendChild(tag);
    }
    if (m.role === 'assistant' && m.model) {
      var mtag = document.createElement('span');
      mtag.className = 'ac-msg-model-tag';
      mtag.textContent = m.model;
      meta.appendChild(mtag);
    }
    var actions = document.createElement('span');
    actions.className = 'ac-msg-actions';
    buildMsgActions(actions, m);
    meta.appendChild(actions);
    body.appendChild(meta);

    var content = document.createElement('div');
    content.className = 'ac-msg-content';
    content.textContent = m.content || '';
    if (m.status === 'error') content.classList.add('error');
    if (m.status === 'stopped') content.classList.add('stopped');
    body.appendChild(content);

    el.appendChild(avatar);
    el.appendChild(body);
    els.acMessages.appendChild(el);

    // 流式结束前保持纯文本；结束后渲染 markdown
    if (!streaming && m.role === 'assistant' && m.status !== 'error' && m.status !== 'stopped' && m.content) {
      renderMarkdown(content);
    }
    return el;
  }

  function renderMarkdown(el) {
    if (!window.marked || !window.DOMPurify) return;
    try {
      var raw = marked.parse(el.textContent);
      el.innerHTML = DOMPurify.sanitize(raw);
      el.classList.add('markdown');
      // 代码块添加复制按钮
      el.querySelectorAll('pre').forEach(function (pre) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ac-code-copy';
        btn.textContent = '复制';
        btn.addEventListener('click', function () {
          var code = pre.querySelector('code');
          copyToClipboard(code ? code.textContent : pre.textContent, '代码已复制');
        });
        pre.appendChild(btn);
      });
    } catch (e) { /* 渲染失败保留纯文本 */ }
  }

  function getCurrentRoleName() {
    if (!state.currentConv || !state.currentConv.role_id) return '';
    var role = state.roles.filter(function (r) { return r.id === state.currentConv.role_id; })[0];
    return role ? role.name : '';
  }

  function buildMsgActions(container, m) {
    if (m.role === 'user') {
      addAction(container, '编辑', function (e) { e.stopPropagation(); editMessageInline(m); });
      addAction(container, '复制', function (e) { e.stopPropagation(); copyToClipboard(m.content || '', '已复制'); });
      addAction(container, '删除', function (e) { e.stopPropagation(); deleteMessage(m); });
    } else {
      // TTS 朗读按钮
      if (tts.synth && tts.enabled && m.content) {
        var ttsBtn = document.createElement('button');
        ttsBtn.type = 'button';
        ttsBtn.className = 'ac-tts-btn';
        ttsBtn.textContent = '🔊';
        ttsBtn.title = '朗读消息';
        ttsBtn.dataset.msgId = m.id;
        ttsBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          speakMessage(m.id, m.content || '');
        });
        container.appendChild(ttsBtn);
      }
      addAction(container, '重生成', function (e) { e.stopPropagation(); regenerateMessage(m); });
      addAction(container, '分叉', function (e) { e.stopPropagation(); forkAt(m); });
      addAction(container, '复制', function (e) { e.stopPropagation(); copyToClipboard(m.content || '', '已复制'); });
      addAction(container, '删除', function (e) { e.stopPropagation(); deleteMessage(m); });
    }
  }

  function addAction(container, label, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ac-msg-act';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
  }

  function scrollToBottom(force) {
    // 流式增量/渲染结束时不强制拉底：用户上滑阅读历史消息时不被打断（距底 80px 内视为贴底）
    if (!force && els.acMessages.scrollHeight - els.acMessages.scrollTop - els.acMessages.clientHeight > 80) return;
    els.acMessages.scrollTop = els.acMessages.scrollHeight;
  }

  // ============ 发送 / 停止 ============

  function send() {
    if (state.streaming) return;
    var content = els.acInput.value.trim();
    if (!content) return;
    if (!state.settings.aiEnabled) {
      showToast('AI 聊天功能暂未开放', 'error');
      return;
    }
    if (state.quota && !state.quotaUnlimited && state.quota.remaining <= 0) {
      showToast('今日对话次数已用完', 'error');
      return;
    }
    // 同步置位：startStream 在微任务中才执行，若此时不置位，连点 Enter/发送按钮会重复发送同一内容
    state.streaming = true;

    var convPromise;
    if (state.currentConv) {
      convPromise = Promise.resolve(state.currentConv);
    } else {
      convPromise = api('/ai-chat/api/conversations', { title: content.slice(0, 30) || '新对话' })
        .then(function (json) {
          var conv = json.data;
          state.conversations.unshift(conv);
          state.currentConv = conv;
          renderConversations();
          els.acConvTitle.textContent = conv.title || '新对话';
          updateModelLabel();
          return conv;
        });
    }

    convPromise.then(function (conv) {
      els.acInput.value = '';
      els.acInput.style.height = 'auto';
      // 用户消息立即上屏
      var userMsg = { id: 'u' + Date.now(), role: 'user', content: content, branch_id: conv.current_branch_id || 0 };
      state.messages.push(userMsg);
      els.acEmpty.style.display = 'none';
      appendMessageEl(userMsg, false);
      scrollToBottom(true);

      // AI 回复占位气泡：流式增量写入此条，避免 AI 内容追加到用户消息里
      var assistantMsg = { id: 'a' + Date.now(), role: 'assistant', content: '', status: 'streaming', branch_id: conv.current_branch_id || 0 };
      state.messages.push(assistantMsg);
      appendMessageEl(assistantMsg, true);
      scrollToBottom(true);

      startStream('/ai-chat/api/send', { conversation_id: conv.id, content: content }, assistantMsg);
    }).catch(function (err) {
      state.streaming = false;
      showToast(err.message, 'error');
    });
  }

  function regenerateMessage(m) {
    if (state.streaming || !state.currentConv) return;
    var placeholder = { id: 'r' + Date.now(), role: 'assistant', content: '', status: 'streaming', branch_id: m.branch_id || 0 };
    state.messages.push(placeholder);
    appendMessageEl(placeholder, true);
    scrollToBottom(true);
    startStream('/ai-chat/api/messages/regenerate', { conversation_id: state.currentConv.id, message_id: m.id }, placeholder);
  }

  // 流式发送核心：管理中止、增量渲染、结束落库
  function startStream(url, body, placeholderMsg) {
    state.streaming = true;
    els.acSend.style.display = 'none';
    els.acStop.style.display = 'inline-block';
    var controller = new AbortController();
    state.abortController = controller;

    var typingEl = appendTypingDots();
    var lastEl = els.acMessages.lastElementChild;

    function updateContent(text) {
      var contentEl = lastEl && lastEl.querySelector('.ac-msg-content');
      if (contentEl) {
        contentEl.textContent = text;
        contentEl.classList.add('streaming');
        scrollToBottom();
      }
    }

    streamFetch(url, body, function (event, data) {
      if (event === 'delta') {
        placeholderMsg.content = (placeholderMsg.content || '') + (data.delta || '');
        updateContent(placeholderMsg.content);
      } else if (event === 'message') {
        placeholderMsg.id = data.id;
        placeholderMsg.content = data.content || placeholderMsg.content;
        placeholderMsg.tokens = data.tokens;
        if (data.model) placeholderMsg.model = data.model;
        if (data.quota) state.quota = data.quota;
        renderQuota();
      } else if (event === 'error') {
        placeholderMsg.status = 'error';
        placeholderMsg.content = data.message || '生成失败';
        if (data.messageId) placeholderMsg.id = data.messageId;
      } else if (event === 'done') {
        placeholderMsg.status = placeholderMsg.status === 'error' ? 'error' : (data.aborted ? 'stopped' : 'done');
      }
    }, controller.signal)
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          placeholderMsg.status = 'stopped';
        } else {
          placeholderMsg.status = 'error';
          placeholderMsg.content = (err && err.message) || '网络请求失败';
        }
      })
      .then(function () {
        state.streaming = false;
        els.acSend.style.display = '';
        els.acStop.style.display = 'none';
        if (typingEl) typingEl.remove();
        finalizeMessage(placeholderMsg, lastEl);
      });
  }

  function appendTypingDots() {
    var lastEl = els.acMessages.lastElementChild;
    if (!lastEl) return null;
    var body = lastEl.querySelector('.ac-msg-body');
    if (!body) return null;
    var dots = document.createElement('div');
    dots.className = 'ac-typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(dots);
    scrollToBottom(true);
    return dots;
  }

  function finalizeMessage(m, placeholderEl) {
    // 移除流式占位气泡（m.id 已被服务端 id 覆盖，DOM 上的临时 id 对不上，需用元素引用判断）
    if (placeholderEl && placeholderEl.parentNode) placeholderEl.remove();
    appendMessageEl(m, false);
    // 刷新会话列表（标题/计数可能变化）与配额，保持当前会话选中
    var convId = state.currentConv ? state.currentConv.id : null;
    loadBootstrap({ autoSelect: false })
      .then(function () {
        if (convId) {
          state.currentConv = state.conversations.filter(function (c) { return c.id === convId; })[0] || state.currentConv;
          renderConversations();
          updateModelLabel();
        }
      })
      .catch(function () { /* ignore */ });
    scrollToBottom();
  }

  function stopStream() {
    if (!state.streaming || !state.abortController) return;
    state.abortController.abort();
  }

  // ============ 消息操作 ============

  function deleteMessage(m) {
    if (!window.confirm('删除该消息及其后的所有消息？')) return;
    api('/ai-chat/api/messages/delete', { message_id: m.id, conversation_id: state.currentConv.id })
      .then(function () {
        // 服务端会级联删除其后同分支消息，重新拉取保持一致
        selectConversation(state.currentConv.id);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  function editMessageInline(m) {
    var el = document.querySelector('.ac-msg[data-id="' + m.id + '"]');
    if (!el) return;
    var contentEl = el.querySelector('.ac-msg-content');
    var old = m.content || '';
    var ta = document.createElement('textarea');
    ta.className = 'ac-field-ta';
    ta.value = old;
    ta.maxLength = 8000;
    ta.style.cssText = 'width:100%;min-height:70px;background:rgba(148,163,184,.07);border:1px solid var(--ac-border);border-radius:8px;color:var(--ac-text);font-size:13px;padding:9px 11px;outline:none;font-family:inherit;resize:vertical;';
    contentEl.replaceWith(ta);
    ta.focus();

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-top:8px;justify-content:flex-end;';
    var cancel = document.createElement('button');
    cancel.className = 'ac-btn ac-btn-sm';
    cancel.textContent = '取消';
    var save = document.createElement('button');
    save.className = 'ac-btn ac-btn-primary ac-btn-sm';
    save.textContent = '保存';
    bar.appendChild(cancel);
    bar.appendChild(save);
    ta.after(bar);

    function done(saveIt) {
      bar.remove();
      if (saveIt && ta.value.trim() !== old) {
        api('/ai-chat/api/messages/edit', { message_id: m.id, content: ta.value })
          .then(function () {
            m.content = ta.value;
            renderMessages();
          })
          .catch(function (err) { showToast(err.message, 'error'); ta.replaceWith(contentEl); });
      } else {
        ta.replaceWith(contentEl);
      }
    }
    cancel.addEventListener('click', function () { done(false); });
    save.addEventListener('click', function () { done(true); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
      if (e.key === 'Escape') done(false);
    });
  }

  function forkAt(m) {
    if (state.streaming) return;
    api('/ai-chat/api/messages/fork', { message_id: m.id, conversation_id: state.currentConv.id })
      .then(function () {
        showToast('已创建新分支', 'success');
        if (state.currentConv) {
          state.currentConv.current_branch_id = (state.currentConv.current_branch_id || 0); // 由服务端返回后刷新
        }
        selectConversation(state.currentConv.id);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 角色 ============

  function openRoleModal() {
    renderRoleList();
    showModal('acRoleModal');
  }

  var roleFilter = { category: '', search: '', favOnly: false };

  function getRoleFavs() {
    try { return JSON.parse(localStorage.getItem('ac_role_favs') || '[]'); } catch (e) { return []; }
  }
  function setRoleFavs(arr) {
    try { localStorage.setItem('ac_role_favs', JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }
  function toggleRoleFav(roleId) {
    var favs = getRoleFavs();
    var idx = favs.indexOf(roleId);
    if (idx >= 0) favs.splice(idx, 1); else favs.push(roleId);
    setRoleFavs(favs);
    renderRoleList();
  }

  function renderRoleList() {
    els.acRoleList.innerHTML = '';
    var kw = roleFilter.search.toLowerCase();
    var favs = getRoleFavs();

    var filtered = state.roles.filter(function (r) {
      if (roleFilter.favOnly && favs.indexOf(r.id) < 0) return false;
      if (roleFilter.category === 'my' && r.is_official) return false;
      if (roleFilter.category === 'fav') return favs.indexOf(r.id) >= 0;
      if (roleFilter.category && roleFilter.category !== 'my' && roleFilter.category !== 'fav' && r.category !== roleFilter.category) return false;
      if (kw) {
        var hay = (r.name + ' ' + (r.description || '') + ' ' + (r.personality || '')).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });

    if (!filtered.length) {
      els.acRoleList.innerHTML = '<p style="grid-column:1/-1;font-size:13px;color:var(--ac-muted);text-align:center;padding:20px 0;">' +
        (kw ? '未找到匹配的角色' : '该分类下暂无角色') + '</p>';
      return;
    }

    filtered.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'ac-role-card' + (state.currentConv && state.currentConv.role_id === r.id ? ' active' : '');

      // 收藏按钮
      var isFav = favs.indexOf(r.id) >= 0;
      var favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'ac-role-fav' + (isFav ? ' active' : '');
      favBtn.textContent = isFav ? '⭐' : '☆';
      favBtn.title = isFav ? '取消收藏' : '收藏角色';
      favBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleRoleFav(r.id);
      });
      card.appendChild(favBtn);

      // 头像 + 名称
      var header = document.createElement('div');
      header.className = 'ac-role-card-header';
      var avatar = document.createElement('div');
      avatar.className = 'ac-role-card-avatar';
      if (r.avatar) {
        var img = document.createElement('img');
        img.src = r.avatar;
        img.alt = r.name;
        img.onerror = function () { this.style.display = 'none'; this.parentNode.textContent = '🎭'; };
        avatar.appendChild(img);
      } else {
        avatar.textContent = r.is_official ? '🎭' : '⭐';
      }
      var h = document.createElement('h3');
      h.textContent = r.name;
      header.appendChild(avatar);
      header.appendChild(h);
      card.appendChild(header);

      var p = document.createElement('p');
      p.textContent = r.description || r.personality || r.system_prompt || '';
      card.appendChild(p);

      var foot = document.createElement('div');
      foot.className = 'ac-role-card-foot';
      var tag = document.createElement('span');
      tag.className = 'ac-role-tag';
      tag.textContent = r.is_official ? '官方' : '我的';
      foot.appendChild(tag);
      if (r.category && r.category !== 'default') {
        var catTag = document.createElement('span');
        catTag.className = 'ac-role-tag';
        catTag.textContent = r.category;
        foot.appendChild(catTag);
      }
      if (r.greeting) {
        var g = document.createElement('span');
        g.className = 'ac-role-tag ac-role-tag-greeting';
        g.textContent = '有开场白';
        foot.appendChild(g);
      }
      // 用户自建角色：导出和删除
      if (!r.is_official) {
        var actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:4px;margin-left:auto;';
        var expBtn = document.createElement('button');
        expBtn.type = 'button';
        expBtn.className = 'ac-role-tag';
        expBtn.textContent = '⤴';
        expBtn.title = '导出角色卡';
        expBtn.addEventListener('click', function (e) { e.stopPropagation(); exportRole(r); });
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ac-role-tag';
        delBtn.textContent = '✕';
        delBtn.title = '删除角色';
        delBtn.style.color = 'var(--danger)';
        delBtn.addEventListener('click', function (e) { e.stopPropagation(); deleteRole(r); });
        actions.appendChild(expBtn);
        actions.appendChild(delBtn);
        foot.appendChild(actions);
      }
      card.appendChild(foot);
      card.addEventListener('click', function () {
        hideModal('acRoleModal');
        startWithRole(r.id);
      });
      els.acRoleList.appendChild(card);
    });
  }

  // 导出指定角色卡
  function exportRole(role) {
    var card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: role.name,
        description: role.description || '',
        personality: role.personality || '',
        scenario: role.scenario || '',
        first_mes: role.greeting || '',
        mes_example: role.examples || '',
        system_prompt: role.system_prompt || '',
        avatar: role.avatar || '',
        creator_notes: 'Exported from AI Chat',
        character_version: '1.0'
      }
    };
    var blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (role.name || 'character') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('角色卡已导出', 'success');
  }

  // 删除用户自建角色
  function deleteRole(role) {
    if (!window.confirm('确定删除角色「' + role.name + '」？')) return;
    api('/ai-chat/api/roles/delete', { id: role.id }).then(function () {
      state.roles = state.roles.filter(function (r) { return r.id !== role.id; });
      renderRoleList();
      showToast('角色已删除', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // 选择角色 → 开启新会话（沿用旧会话若为空则复用）
  function startWithRole(roleId) {
    if (state.currentConv && !state.messages.length) {
      api('/ai-chat/api/conversations/role', { id: state.currentConv.id, role_id: roleId })
        .then(function () {
          state.currentConv.role_id = roleId;
          updateRoleLabel();
          showToast('已切换角色', 'success');
          // 重新加载消息（角色带开场白时会注入第一条 AI 消息）
          selectConversation(state.currentConv.id);
        })
        .catch(function (err) { showToast(err.message, 'error'); });
      return;
    }
    api('/ai-chat/api/conversations', { title: '新对话', role_id: roleId })
      .then(function (json) {
        var conv = json.data;
        state.conversations.unshift(conv);
        state.currentConv = conv;
        renderConversations();
        els.acConvTitle.textContent = conv.title || '新对话';
        updateRoleLabel();
        updateModelLabel();
        // 加载消息（含开场白）
        selectConversation(conv.id);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  function createRole() {
    var name = els.acNewRoleName.value.trim();
    var prompt = els.acNewRolePrompt.value.trim();
    var greeting = els.acNewRoleGreeting.value.trim();
    if (!name) { showToast('请输入角色名称', 'error'); return; }
    if (!prompt && !greeting) { showToast('角色设定或开场白至少填写一项', 'error'); return; }
    api('/ai-chat/api/roles', {
      name: name,
      system_prompt: prompt,
      greeting: greeting,
      description: els.acNewRoleDesc.value.trim(),
      personality: els.acNewRolePersonality.value.trim(),
      scenario: els.acNewRoleScenario.value.trim(),
      examples: els.acNewRoleExamples.value.trim(),
      avatar: els.acNewRoleAvatar ? els.acNewRoleAvatar.value.trim() : ''
    }).then(function (json) {
      state.roles.push(json.data);
      els.acNewRoleName.value = '';
      els.acNewRolePrompt.value = '';
      els.acNewRoleGreeting.value = '';
      els.acNewRoleDesc.value = '';
      els.acNewRolePersonality.value = '';
      els.acNewRoleScenario.value = '';
      els.acNewRoleExamples.value = '';
      if (els.acNewRoleAvatar) els.acNewRoleAvatar.value = '';
      updateAvatarPreview('');
      hideModal('acRoleCreateModal');
      renderRoleList();
      showToast('角色已创建', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 角色卡导入/导出 ============

  // 导出当前会话角色为 JSON（兼容 SillyTavern V2 格式）
  function exportCurrentRole() {
    if (!state.currentConv || !state.currentConv.role_id) {
      showToast('当前会话未选择角色', 'error');
      return;
    }
    var role = state.roles.filter(function (r) { return r.id === state.currentConv.role_id; })[0];
    if (!role) { showToast('角色不存在', 'error'); return; }
    exportRole(role);
  }

  // 导入角色卡（JSON 或 PNG 文件）
  function importRoleFile(file) {
    if (!file) return;
    var isPng = /\.png$/i.test(file.name) || file.type === 'image/png';

    if (isPng) {
      // PNG 角色卡：从 tEXt chunk 提取 chara 字段（base64 JSON）
      var bufReader = new FileReader();
      bufReader.onload = function (e) {
        var buffer = e.target.result;
        var charaJson = extractPngChara(buffer);
        if (!charaJson) {
          showToast('该 PNG 文件中未找到角色卡数据', 'error');
          return;
        }
        var card;
        try { card = JSON.parse(charaJson); } catch (err) {
          showToast('角色卡 JSON 解析失败：' + err.message, 'error');
          return;
        }
        createRoleFromCard(card, file.name);
      };
      bufReader.readAsArrayBuffer(file);
    } else {
      // JSON 角色卡
      var textReader = new FileReader();
      textReader.onload = function (e) {
        var card;
        try { card = JSON.parse(e.target.result); } catch (err) {
          showToast('JSON 解析失败：' + err.message, 'error');
          return;
        }
        createRoleFromCard(card, file.name);
      };
      textReader.readAsText(file, 'UTF-8');
    }
    // 重置 input 以便重复导入同一文件
    if (els.acRoleFileInput) els.acRoleFileInput.value = '';
  }

  // 从 PNG 二进制数据中提取 tEXt chunk 的 chara 字段
  function extractPngChara(buffer) {
    var bytes = new Uint8Array(buffer);
    // 验证 PNG 签名
    var pngSig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== pngSig[i]) return null;
    }
    var offset = 8;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) break;
      var len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      var type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      offset += 8;
      if (type === 'tEXt' && len > 0 && offset + len <= bytes.length) {
        var chunkData = bytes.subarray(offset, offset + len);
        // 找 null 分隔符
        var nullIdx = -1;
        for (var j = 0; j < chunkData.length; j++) {
          if (chunkData[j] === 0) { nullIdx = j; break; }
        }
        if (nullIdx > 0) {
          var keyword = String.fromCharCode.apply(null, chunkData.subarray(0, nullIdx));
          if (keyword === 'chara') {
            var textBytes = chunkData.subarray(nullIdx + 1);
            var base64Str = '';
            for (var k = 0; k < textBytes.length; k++) {
              base64Str += String.fromCharCode(textBytes[k]);
            }
            try {
              // atob 返回 Latin-1 二进制字符串，需转 UTF-8
              var binary = atob(base64Str);
              var bytes = new Uint8Array(binary.length);
              for (var m = 0; m < binary.length; m++) {
                bytes[m] = binary.charCodeAt(m);
              }
              return new TextDecoder('utf-8').decode(bytes);
            } catch (e) { return null; }
          }
        }
      }
      offset += len + 4; // 跳过数据 + CRC
    }
    return null;
  }

  // 从角色卡对象创建角色（JSON / PNG 通用）
  function createRoleFromCard(card, fileName) {
    var data = card.data || card;
    var name = (data.name || '').trim().slice(0, 50);
    var systemPrompt = (data.system_prompt || data.system || data.personality || '').trim();
    var greeting = (data.first_mes || data.greeting || '').trim().slice(0, 2000);
    var description = (data.description || data.char_desc || '').trim().slice(0, 500);
    var personality = (data.personality || '').trim().slice(0, 4000);
    var scenario = (data.scenario || '').trim().slice(0, 4000);
    var examples = (data.mes_example || data.examples || data.mesExample || '').trim().slice(0, 8000);
    var avatar = (data.avatar || data.avatar_url || data.image || '').trim();

    if (!name) {
      // 尝试从文件名推断
      name = (fileName || '').replace(/\.(json|png)$/i, '').trim().slice(0, 50);
    }
    if (!name) { showToast('角色卡缺少名称', 'error'); return; }
    if (!systemPrompt && !greeting) { showToast('角色卡缺少设定或开场白', 'error'); return; }

    api('/ai-chat/api/roles', {
      name: name,
      system_prompt: systemPrompt,
      greeting: greeting,
      description: description,
      personality: personality,
      scenario: scenario,
      examples: examples,
      avatar: avatar
    }).then(function (json) {
      state.roles.push(json.data);
      renderRoleList();
      showToast('角色「' + name + '」已导入', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // 角色卡导入/导出事件绑定
  if (els.acRoleExport) {
    els.acRoleExport.addEventListener('click', exportCurrentRole);
  }
  if (els.acRoleImport) {
    els.acRoleImport.addEventListener('click', function () {
      if (els.acRoleFileInput) els.acRoleFileInput.click();
    });
  }
  if (els.acRoleFileInput) {
    els.acRoleFileInput.addEventListener('change', function () {
      var file = els.acRoleFileInput.files && els.acRoleFileInput.files[0];
      if (file) importRoleFile(file);
    });
  }

  // 从 URL 抓取角色卡
  if (els.acRoleImportUrl) {
    els.acRoleImportUrl.addEventListener('click', function () {
      if (els.acRoleUrlInput) els.acRoleUrlInput.value = '';
      showModal('acRoleUrlModal');
      if (els.acRoleUrlInput) els.acRoleUrlInput.focus();
    });
  }
  if (els.acRoleUrlFetch) {
    els.acRoleUrlFetch.addEventListener('click', function () {
      var url = (els.acRoleUrlInput && els.acRoleUrlInput.value || '').trim();
      if (!url) { showToast('请输入角色卡页面 URL', 'error'); return; }
      var btn = els.acRoleUrlFetch;
      btn.disabled = true;
      btn.textContent = '抓取中…';
      api('/ai-chat/api/roles/fetch-url', { url: url })
        .then(function (json) {
          if (json.success && json.data && json.data.name) {
            hideModal('acRoleUrlModal');
            // 用抓取到的数据创建角色
            return api('/ai-chat/api/roles', {
              name: json.data.name,
              system_prompt: json.data.system_prompt || '',
              greeting: json.data.greeting || '',
              description: json.data.description || '',
              personality: json.data.personality || '',
              scenario: json.data.scenario || '',
              examples: json.data.examples || ''
            }).then(function (createJson) {
              state.roles.push(createJson.data);
              renderRoleList();
              showToast('角色「' + json.data.name + '」已从 URL 导入', 'success');
            });
          } else {
            showToast(json.error || '抓取失败', 'error');
          }
        })
        .catch(function (err) { showToast(err.message || '抓取失败', 'error'); })
        .then(function () {
          btn.disabled = false;
          btn.textContent = '抓取并导入';
        });
    });
  }

  // ============ 角色分类筛选 ============
  if (els.acRoleFilter) {
    els.acRoleFilter.addEventListener('click', function (e) {
      var tag = e.target.closest('.ac-role-filter-tag');
      if (!tag) return;
      var cat = tag.dataset.cat || '';
      roleFilter.favOnly = cat === 'fav';
      roleFilter.category = cat === 'fav' ? '' : cat;
      els.acRoleFilter.querySelectorAll('.ac-role-filter-tag').forEach(function (t) {
        t.classList.toggle('active', t === tag);
      });
      renderRoleList();
    });
  }
  if (els.acRoleSearch) {
    els.acRoleSearch.addEventListener('input', function () {
      roleFilter.search = els.acRoleSearch.value;
      renderRoleList();
    });
  }

  // ============ 头像上传 ============
  if (els.acNewRoleAvatarBtn) {
    els.acNewRoleAvatarBtn.addEventListener('click', function () {
      if (els.acNewRoleAvatarFile) els.acNewRoleAvatarFile.click();
    });
  }
  if (els.acNewRoleAvatarPreview) {
    els.acNewRoleAvatarPreview.addEventListener('click', function () {
      if (els.acNewRoleAvatarFile) els.acNewRoleAvatarFile.click();
    });
  }
  if (els.acNewRoleAvatarFile) {
    els.acNewRoleAvatarFile.addEventListener('change', function () {
      var file = els.acNewRoleAvatarFile.files && els.acNewRoleAvatarFile.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { showToast('图片不能超过 2MB', 'error'); return; }
      var reader = new FileReader();
      reader.onload = function (e) {
        var dataUrl = e.target.result;
        if (els.acNewRoleAvatar) els.acNewRoleAvatar.value = dataUrl;
        updateAvatarPreview(dataUrl);
      };
      reader.readAsDataURL(file);
    });
  }
  if (els.acNewRoleAvatar) {
    els.acNewRoleAvatar.addEventListener('input', function () {
      updateAvatarPreview(els.acNewRoleAvatar.value);
    });
  }
  function updateAvatarPreview(src) {
    var preview = els.acNewRoleAvatarPreview;
    if (!preview) return;
    if (src) {
      preview.textContent = '';
      var img = document.createElement('img');
      img.src = src;
      img.alt = '头像预览';
      img.onerror = function () { preview.textContent = '🎭'; };
      preview.appendChild(img);
    } else {
      preview.textContent = '🎭';
    }
  }

  // ============ 聊天记录导出 ============
  if (els.acChatExport) {
    els.acChatExport.addEventListener('click', exportChatHistory);
  }

  function exportChatHistory() {
    if (!state.currentConv) { showToast('请先选择一个会话', 'error'); return; }
    if (!state.messages.length) { showToast('该会话没有消息', 'error'); return; }

    var conv = state.currentConv;
    var role = null;
    if (conv.role_id) {
      role = state.roles.filter(function (r) { return r.id === conv.role_id; })[0] || null;
    }

    var chatData = {
      chat_export: true,
      export_date: new Date().toISOString(),
      title: conv.title || '新对话',
      character: role ? {
        name: role.name,
        description: role.description || '',
        personality: role.personality || '',
        scenario: role.scenario || '',
        first_mes: role.greeting || '',
        mes_example: role.examples || '',
        system_prompt: role.system_prompt || '',
        avatar: role.avatar || ''
      } : null,
      messages: state.messages.map(function (m) {
        return {
          role: m.role,
          content: m.content || '',
          created_at: m.created_at || null,
          model: m.model || null
        };
      })
    };

    var blob = new Blob([JSON.stringify(chatData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (conv.title || 'chat') + '_' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('聊天记录已导出', 'success');
  }

  // 聊天记录导入
  if (els.acChatImport) {
    els.acChatImport.addEventListener('click', function () {
      if (els.acChatFileInput) els.acChatFileInput.click();
    });
  }
  if (els.acChatFileInput) {
    els.acChatFileInput.addEventListener('change', function () {
      var file = els.acChatFileInput.files && els.acChatFileInput.files[0];
      if (!file) return;
      els.acChatFileInput.value = '';
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = JSON.parse(e.target.result);
          if (!data.chat_export || !Array.isArray(data.messages)) {
            showToast('无效的聊天记录文件', 'error');
            return;
          }
          api('/ai-chat/api/conversations/import', data).then(function (json) {
            if (json.success && json.data) {
              showToast('聊天记录已导入（' + data.messages.length + ' 条消息）', 'success');
              loadConversations().then(function () {
                var newConv = state.conversations.filter(function (c) { return c.id === json.data.id; })[0];
                if (newConv) selectConversation(newConv);
              });
            } else {
              showToast(json.error || '导入失败', 'error');
            }
          }).catch(function (err) { showToast(err.message || '导入失败', 'error'); });
        } catch (ex) {
          showToast('JSON 解析失败：' + ex.message, 'error');
        }
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  // ============ 世界书 ============

  function openWorldModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    renderWorldList();
    showModal('acWorldModal');
  }

  function renderWorldList() {
    els.acWorldList.innerHTML = '';
    var kw = (els.acWorldSearch && els.acWorldSearch.value || '').toLowerCase();
    var list = state.worldBook.filter(function (w) {
      if (!kw) return true;
      return (w.key || '').toLowerCase().indexOf(kw) !== -1 ||
        (w.content || '').toLowerCase().indexOf(kw) !== -1;
    });

    // 更新计数
    if (els.acWorldCount) {
      var total = state.worldBook.length;
      var enabled = state.worldBook.filter(function (w) { return w.enabled; }).length;
      els.acWorldCount.textContent = (kw ? list.length + '/' : '') + total + ' 条（' + enabled + ' 启用）';
    }

    if (!list.length) {
      els.acWorldList.innerHTML = '<p style="font-size:13px;color:var(--ac-muted);padding:8px 0;">' +
        (kw ? '未找到匹配的条目' : '还没有世界书条目，点击「添加条目」创建。') + '</p>';
      return;
    }
    list.forEach(function (w) {
      var item = document.createElement('div');
      item.className = 'ac-world-item' + (w.enabled ? '' : ' off') + (w.constant ? ' constant' : '');
      var key = document.createElement('span');
      key.className = 'ac-world-key';
      key.textContent = w.key || '（常驻）';
      var prev = document.createElement('span');
      prev.className = 'ac-world-preview';
      prev.textContent = w.content || '';
      var pos = document.createElement('span');
      pos.className = 'ac-world-pos';
      pos.textContent = positionLabel(w.position);
      item.appendChild(key);
      item.appendChild(prev);
      item.appendChild(pos);
      if (w.constant) {
        var ctag = document.createElement('span');
        ctag.className = 'ac-world-pos ac-world-const';
        ctag.textContent = '常驻';
        item.appendChild(ctag);
      }
      var tog = document.createElement('button');
      tog.type = 'button';
      tog.className = 'ac-world-toggle';
      tog.textContent = w.enabled ? '停用' : '启用';
      tog.title = w.enabled ? '停用该条目' : '启用该条目';
      tog.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleWorldEntry(w);
      });
      item.appendChild(tog);
      item.addEventListener('click', function () { openWorldEdit(w); });
      els.acWorldList.appendChild(item);
    });
  }

  // 快速启用/停用世界书条目（保留原字段）
  function toggleWorldEntry(w) {
    api('/ai-chat/api/world-book', {
      conversation_id: state.currentConv.id,
      id: w.id,
      key: w.key || '',
      content: w.content || '',
      position: w.position || 'before_char',
      enabled: w.enabled ? 0 : 1,
      constant: w.constant ? 1 : 0
    }).then(function () {
      w.enabled = w.enabled ? 0 : 1;
      renderWorldList();
      showToast(w.enabled ? '条目已启用' : '条目已停用', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function positionLabel(pos) {
    var map = { system_top: '系统前', before_char: '角色前', after_char: '角色后', user_top: '消息尾', assistant_top: 'AI前' };
    return map[pos] || pos;
  }

  // 从默认世界书模板导入到当前会话（已存在的 key 跳过）
  function importDefaultWorldBook() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    api('/ai-chat/api/world-book/import-defaults', { conversation_id: state.currentConv.id }).then(function (json) {
      if (json && json.data && json.data.imported > 0) {
        selectConversation(state.currentConv.id);
        showToast('已从默认模板导入 ' + json.data.imported + ' 条', 'success');
      } else {
        showToast('默认模板中无新条目可导入（可能已全部存在）', 'info');
      }
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function openWorldEdit(w) {
    els.acWorldEditTitle.textContent = w ? '编辑条目' : '添加条目';
    els.acWorldKey.value = w ? (w.key || '') : '';
    els.acWorldPos.value = w ? (w.position || 'before_char') : 'before_char';
    els.acWorldConstant.checked = Boolean(w && w.constant);
    els.acWorldContent.value = w ? (w.content || '') : '';
    els.acWorldDelete.style.display = w ? 'inline-block' : 'none';
    els.acWorldEditModal.dataset.id = w ? w.id : '';
    showModal('acWorldEditModal');
  }

  function saveWorldEntry() {
    var convId = state.currentConv.id;
    var id = parseInt(els.acWorldEditModal.dataset.id, 10) || 0;
    var payload = {
      conversation_id: convId,
      id: id,
      key: els.acWorldKey.value,
      content: els.acWorldContent.value,
      position: els.acWorldPos.value,
      constant: els.acWorldConstant.checked ? 1 : 0
    };
    api('/ai-chat/api/world-book', payload).then(function () {
      hideModal('acWorldEditModal');
      selectConversation(convId);
      showToast(id ? '条目已更新' : '条目已添加', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function deleteWorldEntry() {
    var id = parseInt(els.acWorldEditModal.dataset.id, 10);
    var convId = state.currentConv.id;
    if (!id || !window.confirm('确定删除该条目？')) return;
    api('/ai-chat/api/world-book/delete', { conversation_id: convId, id: id }).then(function () {
      hideModal('acWorldEditModal');
      selectConversation(convId);
      showToast('条目已删除', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // 批量启用/停用/删除世界书条目
  function batchWorldAction(action) {
    if (!state.currentConv) return;
    var convId = state.currentConv.id;

    if (action === 'deleteAll') {
      if (!window.confirm('确定清空所有世界书条目？此操作不可恢复')) return;
    }

    var promises = state.worldBook.map(function (w) {
      if (action === 'enableAll' && !w.enabled) {
        return api('/ai-chat/api/world-book', {
          conversation_id: convId, id: w.id, key: w.key || '', content: w.content || '',
          position: w.position || 'before_char', enabled: 1, constant: w.constant ? 1 : 0
        }).then(function () { w.enabled = 1; });
      } else if (action === 'disableAll' && w.enabled) {
        return api('/ai-chat/api/world-book', {
          conversation_id: convId, id: w.id, key: w.key || '', content: w.content || '',
          position: w.position || 'before_char', enabled: 0, constant: w.constant ? 1 : 0
        }).then(function () { w.enabled = 0; });
      } else if (action === 'deleteAll') {
        return api('/ai-chat/api/world-book/delete', { conversation_id: convId, id: w.id });
      }
      return Promise.resolve();
    });

    Promise.all(promises).then(function () {
      if (action === 'deleteAll') {
        state.worldBook = [];
      }
      renderWorldList();
      showToast(action === 'enableAll' ? '已全部启用' : action === 'disableAll' ? '已全部停用' : '已清空', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // 世界书搜索
  if (els.acWorldSearch) {
    els.acWorldSearch.addEventListener('input', function () {
      renderWorldList();
    });
  }
  // 世界书批量操作
  if (els.acWorldEnableAll) {
    els.acWorldEnableAll.addEventListener('click', function () { batchWorldAction('enableAll'); });
  }
  if (els.acWorldDisableAll) {
    els.acWorldDisableAll.addEventListener('click', function () { batchWorldAction('disableAll'); });
  }
  if (els.acWorldDeleteAll) {
    els.acWorldDeleteAll.addEventListener('click', function () { batchWorldAction('deleteAll'); });
  }

  // ============ 记忆 ============

  function openMemoryModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    els.acMemoryEnabled.checked = state.currentConv.memory_enabled !== 0;
    els.acRagEnabled.checked = state.currentConv.rag_enabled !== 0;
    els.acMemoryMode.value = state.currentConv.memory_mode || 'summary';
    showModal('acMemoryModal');
  }

  function saveMemorySettings() {
    api('/ai-chat/api/memory/settings', {
      conversation_id: state.currentConv.id,
      memory_enabled: els.acMemoryEnabled.checked ? 1 : 0,
      memory_mode: els.acMemoryMode.value
    }).then(function () {
      state.currentConv.memory_enabled = els.acMemoryEnabled.checked ? 1 : 0;
      state.currentConv.memory_mode = els.acMemoryMode.value;
      // 知识库（RAG）开关独立保存
      return api('/ai-chat/api/conversations/rag', {
        conversation_id: state.currentConv.id,
        rag_enabled: els.acRagEnabled.checked ? 1 : 0
      });
    }).then(function () {
      state.currentConv.rag_enabled = els.acRagEnabled.checked ? 1 : 0;
      hideModal('acMemoryModal');
      showToast('记忆与知识库设置已保存', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function refreshMemory() {
    api('/ai-chat/api/memory/refresh', { conversation_id: state.currentConv.id })
      .then(function () {
        showToast('记忆已更新', 'success');
        selectConversation(state.currentConv.id);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 分支 ============

  function openBranchModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    renderBranchList();
    showModal('acBranchModal');
  }

  function renderBranchList() {
    els.acBranchList.innerHTML = '';
    var main = document.createElement('div');
    main.className = 'ac-branch-item' + ((state.currentConv.current_branch_id || 0) === 0 ? ' active' : '');
    main.innerHTML = '<span class="ac-branch-name">主分支</span>';
    main.addEventListener('click', function () {
      switchBranch(0);
    });
    els.acBranchList.appendChild(main);
    state.branches.forEach(function (b) {
      var item = document.createElement('div');
      item.className = 'ac-branch-item' + (state.currentConv.current_branch_id === b.id ? ' active' : '');
      var name = document.createElement('span');
      name.className = 'ac-branch-name';
      name.textContent = b.name + '（#' + b.id + '）';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ac-branch-del';
      del.textContent = '✕';
      del.title = '删除分支';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!window.confirm('删除该分支及其消息？')) return;
        api('/ai-chat/api/branches/delete', { conversation_id: state.currentConv.id, branch_id: b.id })
          .then(function () { selectConversation(state.currentConv.id); })
          .catch(function (err) { showToast(err.message, 'error'); });
      });
      item.appendChild(name);
      item.appendChild(del);
      item.addEventListener('click', function () { switchBranch(b.id); });
      els.acBranchList.appendChild(item);
    });
  }

  function switchBranch(branchId) {
    api('/ai-chat/api/branches/switch', { conversation_id: state.currentConv.id, branch_id: branchId })
      .then(function () {
        state.currentConv.current_branch_id = branchId;
        hideModal('acBranchModal');
        selectConversation(state.currentConv.id);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 弹窗通用 ============

  function showModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = false;
  }

  function hideModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = true;
  }

  function closeAllModals() {
    ['acRoleModal', 'acRoleCreateModal', 'acRoleUrlModal', 'acWorldModal', 'acWorldEditModal', 'acMemoryModal', 'acBranchModal',
      'acShareModal', 'acPromptModal', 'acModelModal']
      .forEach(hideModal);
  }

  // ============ 事件绑定 ============

  els.acNewChat.addEventListener('click', function () {
    if (state.streaming) return;
    api('/ai-chat/api/conversations', { title: '新对话' }).then(function (json) {
      var conv = json.data;
      state.conversations.unshift(conv);
      state.currentConv = conv;
      state.messages = [];
      renderConversations();
      els.acConvTitle.textContent = '新对话';
      renderMessages();
      updateRoleLabel();
      updateModelLabel();
      els.acInput.focus();
    }).catch(function (err) { showToast(err.message, 'error'); });
  });

  els.acConvSearch.addEventListener('input', function () {
    state.convSearch = els.acConvSearch.value;
    renderConversations();
  });

  els.acSend.addEventListener('click', send);
  els.acStop.addEventListener('click', stopStream);
  els.acInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 输入框自适应高度
  function autoResizeInput() {
    els.acInput.style.height = 'auto';
    els.acInput.style.height = Math.min(els.acInput.scrollHeight, 180) + 'px';
  }
  els.acInput.addEventListener('input', autoResizeInput);

  els.acRoleBtn.addEventListener('click', openRoleModal);
  els.acModelBtn.addEventListener('click', openModelModal);
  els.acRoleCreate.addEventListener('click', function () { showModal('acRoleCreateModal'); });
  els.acRoleSave.addEventListener('click', createRole);

  els.acWorldBtn.addEventListener('click', openWorldModal);
  els.acWorldAdd.addEventListener('click', function () { openWorldEdit(null); });
  els.acWorldImport.addEventListener('click', importDefaultWorldBook);
  els.acWorldSave.addEventListener('click', saveWorldEntry);
  els.acWorldDelete.addEventListener('click', deleteWorldEntry);

  els.acMemoryBtn.addEventListener('click', openMemoryModal);
  els.acMemorySave.addEventListener('click', saveMemorySettings);
  els.acMemoryRefresh.addEventListener('click', refreshMemory);

  els.acBranchBtn.addEventListener('click', openBranchModal);

  // 弹窗关闭（点击 × / 遮罩）
  document.querySelectorAll('[data-ac-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { hideModal(btn.getAttribute('data-ac-close')); });
  });
  document.querySelectorAll('.ac-modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) {
      if (e.target === ov) ov.hidden = true;
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAllModals();
      hideModal('acMsgMenu');
    }
  });

  // 移动端侧栏
  els.acMenuBtn.addEventListener('click', function () {
    els.acSidebar.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (window.innerWidth <= 820 && els.acSidebar.classList.contains('open') &&
        !els.acSidebar.contains(e.target) && e.target !== els.acMenuBtn) {
      els.acSidebar.classList.remove('open');
    }
  });

  // ============ 我的 API 模型卡片 ============
  els.acModelsToggle.addEventListener('click', function () {
    var collapsed = els.acModelsBody.classList.toggle('collapsed');
    els.acModelsToggle.textContent = collapsed ? '展开 ▾' : '收起 ▴';
  });

  els.acModelAddBtn.addEventListener('click', function () {
    els.acModelAddRow.hidden = false;
    els.acModelAddBtn.style.display = 'none';
    els.acmProvider.focus();
  });
  els.acmCancel.addEventListener('click', resetAddModelForm);
  els.acmProvider.addEventListener('change', applyProviderPreset);

  // 添加模型：填写端点 + Key 后自动获取可用模型
  els.acmFetch.addEventListener('click', function () {
    var endpoint = els.acmEndpoint.value.trim();
    var apiKey = els.acmApiKey.value.trim();
    if (!endpoint && !apiKey) { showToast('请先填写 API 端点与 API Key', 'error'); return; }
    els.acmFetch.disabled = true;
    els.acmFetch.textContent = '获取中…';
    fetchModelsApi({ api_endpoint: endpoint, api_key: apiKey })
      .then(function (json) {
        var list = json.data || [];
        els.acmFetchList.innerHTML = '';
        list.forEach(function (md) {
          var opt = document.createElement('option');
          opt.value = md.id;
          opt.textContent = md.id + (md.owned_by ? '（' + md.owned_by + '）' : '');
          els.acmFetchList.appendChild(opt);
        });
        els.acmFetchTip.textContent = '共 ' + list.length + ' 个模型';
        els.acmFetchWrap.hidden = false;
      })
      .catch(function (err) { showToast(err.message, 'error'); })
      .then(function () {
        els.acmFetch.disabled = false;
        els.acmFetch.textContent = '⟳ 获取模型';
      });
  });
  els.acmFetchUse.addEventListener('click', function () {
    var v = els.acmFetchList.value;
    if (v) {
      els.acmKey.value = v;
      els.acmKey.focus();
      showToast('已选用模型：' + v, 'success');
    }
    els.acmFetchWrap.hidden = true;
  });

  els.acmSave.addEventListener('click', function () {
    var providerKey = els.acmProvider.value;
    var modelKey = els.acmKey.value.trim();
    var endpoint = els.acmEndpoint.value.trim();
    var apiKey = els.acmApiKey.value.trim();
    if (!modelKey) { showToast('请填写模型标识', 'error'); return; }
    var preset = state.providers.filter(function (x) { return x.provider_key === providerKey; })[0];
    var name = preset ? preset.name : (modelKey.split('/').pop() || modelKey);
    api('/ai-chat/api/models', {
      name: name,
      model_key: modelKey,
      provider: providerKey || 'custom',
      api_endpoint: endpoint,
      api_key: apiKey,
      is_default: els.acmDefault.checked ? 1 : 0
    }).then(function () {
      showToast('模型已添加', 'success');
      resetAddModelForm();
      loadBootstrap({ autoSelect: false });
    }).catch(function (err) { showToast(err.message, 'error'); });
  });

  // ============ 提示词库选择 ============
  if (canPickPrompt && els.acPickPrompt) {
    els.acPickPrompt.style.display = '';
  }
  if (els.acPickPrompt) {
    els.acPickPrompt.addEventListener('click', openPromptPicker);
  }
  if (els.acPromptSearch) {
    els.acPromptSearch.addEventListener('input', function () {
      promptFilter = els.acPromptSearch.value;
      renderPromptList(false);
    });
  }
  if (els.acPromptMore) {
    els.acPromptMore.addEventListener('click', function () { renderPromptList(true); });
  }
  if (els.acPromptList) {
    els.acPromptList.addEventListener('click', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.ac-prompt-item') : null;
      if (!item) return;
      var id = parseInt(item.getAttribute('data-id'), 10);
      var found = null;
      prompts.forEach(function (p) { if (p.id === id) found = p; });
      if (found) {
        els.acInput.value = found.excerpt || found.title;
        els.acInput.focus();
        showToast('已填充提示词，可编辑后发送', 'success');
      }
      hideModal('acPromptModal');
    });
  }

  // ============ 会话分享链接 ============
  if (els.acShareBtn) {
    els.acShareBtn.addEventListener('click', openShareModal);
  }
  if (els.acShareCopy) {
    els.acShareCopy.addEventListener('click', function () {
      copyToClipboard(els.acShareUrl.value, '分享链接已复制');
    });
  }
  if (els.acShareToggle) {
    els.acShareToggle.addEventListener('click', toggleShare);
  }

  // ============ 全屏聊天模式 ============
  var fullscreenState = false;

  function toggleFullscreen() {
    fullscreenState = !fullscreenState;
    var app = els.acApp || document.getElementById('acApp');
    if (!app) return;
    app.classList.toggle('fullscreen', fullscreenState);
    els.acFullscreenBtn.innerHTML = fullscreenState ? '⛶ <span>退出</span>' : '⛶ <span>全屏</span>';
    els.acFullscreenBtn.title = fullscreenState ? '退出全屏' : '全屏聊天';
    try { localStorage.setItem('ac_fullscreen', fullscreenState ? '1' : '0'); } catch (e) { /* ignore */ }
    if (fullscreenState) {
      scrollToBottom(true);
      els.acInput && els.acInput.focus();
    }
  }

  // 恢复上次全屏状态
  try {
    if (localStorage.getItem('ac_fullscreen') === '1') {
      fullscreenState = false;
      toggleFullscreen();
    }
  } catch (e) { /* ignore */ }

  if (els.acFullscreenBtn) {
    els.acFullscreenBtn.addEventListener('click', toggleFullscreen);
  }

  // ESC 退出全屏
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && fullscreenState) {
      var anyModalOpen = document.querySelector('.ac-modal-overlay:not([hidden])');
      if (!anyModalOpen) {
        toggleFullscreen();
      }
    }
  });

  // ============ TTS 语音朗读 ============
  var tts = {
    synth: window.speechSynthesis || null,
    voices: [],
    currentUtterance: null,
    speakingMsgId: null,
    enabled: false,
    selectedVoice: '',
    rate: 1,
    pitch: 1
  };

  function initTts() {
    if (!tts.synth) return;
    // 恢复 TTS 设置
    try {
      tts.enabled = localStorage.getItem('ac_tts_enabled') === '1';
      tts.selectedVoice = localStorage.getItem('ac_tts_voice') || '';
      tts.rate = parseFloat(localStorage.getItem('ac_tts_rate')) || 1;
      tts.pitch = parseFloat(localStorage.getItem('ac_tts_pitch')) || 1;
    } catch (e) { /* ignore */ }

    function loadVoices() {
      tts.voices = tts.synth.getVoices();
      if (!tts.voices.length) return;
      renderVoiceSelect();
      // 恢复设置值
      if (tts.rate !== 1) {
        els.acTtsRate.value = tts.rate;
        els.acTtsRateVal.textContent = tts.rate.toFixed(1);
      }
      if (tts.pitch !== 1) {
        els.acTtsPitch.value = tts.pitch;
        els.acTtsPitchVal.textContent = tts.pitch.toFixed(1);
      }
      if (tts.selectedVoice) {
        els.acTtsVoice.value = tts.selectedVoice;
      }
      if (tts.enabled) {
        els.acTtsSettings.style.display = '';
      }
    }

    loadVoices();
    if (tts.synth.onvoiceschanged !== undefined) {
      tts.synth.onvoiceschanged = loadVoices;
    }
  }

  function renderVoiceSelect() {
    if (!els.acTtsVoice) return;
    els.acTtsVoice.innerHTML = '';
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '默认';
    els.acTtsVoice.appendChild(defaultOpt);

    var zhVoices = tts.voices.filter(function (v) { return /zh|cmn|中文|普通话|国语/i.test(v.lang + ' ' + v.name); });
    var otherVoices = tts.voices.filter(function (v) { return !/zh|cmn|中文|普通话|国语/i.test(v.lang + ' ' + v.name); });

    function addVoiceOption(parent, v) {
      var opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name + ' (' + v.lang + ')';
      parent.appendChild(opt);
    }

    if (zhVoices.length) {
      var grp = document.createElement('optgroup');
      grp.label = '中文';
      zhVoices.forEach(function (v) { addVoiceOption(grp, v); });
      els.acTtsVoice.appendChild(grp);
    }
    if (otherVoices.length) {
      var grp2 = document.createElement('optgroup');
      grp2.label = '其他语言';
      otherVoices.forEach(function (v) { addVoiceOption(grp2, v); });
      els.acTtsVoice.appendChild(grp2);
    }
  }

  function saveTtsSettings() {
    try {
      localStorage.setItem('ac_tts_enabled', tts.enabled ? '1' : '0');
      localStorage.setItem('ac_tts_voice', tts.selectedVoice);
      localStorage.setItem('ac_tts_rate', String(tts.rate));
      localStorage.setItem('ac_tts_pitch', String(tts.pitch));
    } catch (e) { /* ignore */ }
  }

  function toggleTtsEnabled() {
    tts.enabled = !tts.enabled;
    els.acTtsSettings.style.display = tts.enabled ? '' : 'none';
    if (!tts.enabled) {
      stopSpeaking();
    }
    saveTtsSettings();
  }

  function speakMessage(msgId, text) {
    if (!tts.synth || !tts.enabled) return;
    // 如果正在朗读同一条消息，停止
    if (tts.speakingMsgId === msgId) {
      stopSpeaking();
      return;
    }
    // 停止当前朗读
    stopSpeaking();

    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = tts.rate;
    utterance.pitch = tts.pitch;
    if (tts.selectedVoice) {
      var voice = tts.voices.filter(function (v) { return v.name === tts.selectedVoice; })[0];
      if (voice) utterance.voice = voice;
    }
    utterance.onend = function () {
      tts.speakingMsgId = null;
      updateTtsButton(msgId, false);
    };
    utterance.onerror = function () {
      tts.speakingMsgId = null;
      updateTtsButton(msgId, false);
    };

    tts.currentUtterance = utterance;
    tts.speakingMsgId = msgId;
    updateTtsButton(msgId, true);
    tts.synth.speak(utterance);
  }

  function stopSpeaking() {
    if (tts.synth) {
      tts.synth.cancel();
    }
    if (tts.speakingMsgId) {
      updateTtsButton(tts.speakingMsgId, false);
      tts.speakingMsgId = null;
    }
    tts.currentUtterance = null;
  }

  function updateTtsButton(msgId, speaking) {
    var btn = document.querySelector('.ac-tts-btn[data-msg-id="' + msgId + '"]');
    if (btn) {
      btn.classList.toggle('speaking', speaking);
      btn.textContent = speaking ? '⏹' : '🔊';
      btn.title = speaking ? '停止朗读' : '朗读消息';
    }
  }

  // TTS 事件绑定
  if (els.acTtsVoice) {
    els.acTtsVoice.addEventListener('change', function () {
      tts.selectedVoice = els.acTtsVoice.value;
      saveTtsSettings();
    });
  }
  if (els.acTtsRate) {
    els.acTtsRate.addEventListener('input', function () {
      tts.rate = parseFloat(els.acTtsRate.value);
      els.acTtsRateVal.textContent = tts.rate.toFixed(1);
      saveTtsSettings();
    });
  }
  if (els.acTtsPitch) {
    els.acTtsPitch.addEventListener('input', function () {
      tts.pitch = parseFloat(els.acTtsPitch.value);
      els.acTtsPitchVal.textContent = tts.pitch.toFixed(1);
      saveTtsSettings();
    });
  }
  if (els.acTtsToggle) {
    els.acTtsToggle.addEventListener('click', function () {
      if (!tts.synth) {
        showToast('当前浏览器不支持语音朗读', 'error');
        return;
      }
      toggleTtsEnabled();
      els.acTtsToggle.classList.toggle('active', tts.enabled);
      els.acTtsToggle.innerHTML = tts.enabled ? '🔊 <span>朗读中</span>' : '🔊 <span>朗读</span>';
      // 重新渲染消息以显示/隐藏 TTS 按钮
      if (state.messages.length) {
        renderMessages();
      }
      showToast(tts.enabled ? '语音朗读已开启' : '语音朗读已关闭', 'success');
    });
    // 恢复 TTS 按钮状态
    if (tts.enabled) {
      els.acTtsToggle.classList.add('active');
      els.acTtsToggle.innerHTML = '🔊 <span>朗读中</span>';
    }
  }

  // 初始化 TTS
  initTts();

  // 初始化
  loadBootstrap().catch(function (err) {
    showToast(err.message, 'error');
  });
})();
