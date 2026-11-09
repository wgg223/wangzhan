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
  var canExport = !!page.canExport;
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
    convSearch: '',
    presets: [],
    promptTemplates: []
  };

  var els = {};
  ['acConvList', 'acConvSearch', 'acNewChat', 'acQuotaBadge', 'acConvTitle', 'acMessages', 'acEmpty',
    'acInput', 'acSend', 'acStop', 'acRoleBtn', 'acRoleLabel',
    'acModelBtn', 'acModelLabel', 'acModelModal', 'acModelList',
    'acRoleModal', 'acRoleList', 'acRoleCreate', 'acRoleCreateModal', 'acNewRoleName', 'acNewRolePrompt', 'acNewRoleGreeting', 'acNewRoleDesc', 'acNewRolePersonality', 'acNewRoleScenario', 'acNewRoleExamples', 'acRoleSave',
    'acWorldList', 'acWorldAdd', 'acWorldImport', 'acWorldEditModal', 'acWorldEditTitle', 'acWorldKey', 'acWorldPos',
    'acWorldContent', 'acWorldConstant', 'acWorldSave', 'acWorldDelete', 'acWorldSecondary', 'acWorldSelective', 'acWorldProbability', 'acWorldDepth', 'acWorldSelectiveWrap', 'acWorldDepthWrap',
    'acMemoryEnabled', 'acRagEnabled', 'acMemoryMode', 'acMemorySave', 'acMemoryRefresh',
    'acAutoCompress', 'acCompressKeep', 'acCompressKeepVal', 'acCompressNow',
    'acMemoryBackfill', 'acMemoryBackfillModal', 'acBackfillStatus', 'acBackfillEmbWarn',
    'acBackfillProgress', 'acBackfillPhase', 'acBackfillBar', 'acBackfillMeta',
    'acBackfillCancel', 'acBackfillSummaries', 'acBackfillVectors', 'acBackfillGroups', 'acBackfillAll',
    'acImageGenBtn', 'acPredictBtn', 'acSuggestions',
    'acBranchList', 'acMenuBtn', 'acSidebar',
    'acModelsToggle', 'acModelsBody', 'acMyModels', 'acGlobalModels', 'acModelAddBtn', 'acModelAddRow',
    'acmProvider', 'acmKey', 'acmEndpoint', 'acmApiKey', 'acmDefault', 'acmSave', 'acmCancel', 'acmGetWrap', 'acmGetLink',
    'acmFetch', 'acmFetchWrap', 'acmFetchList', 'acmFetchUse', 'acmFetchTip',
    'acShareBtn', 'acShareModal', 'acShareUrl', 'acShareCopy', 'acShareToggle',
    'acPickPrompt', 'acPromptModal', 'acPromptSearch', 'acPromptList', 'acPromptCount', 'acPromptMore',
    'acFullscreenBtn', 'acApp', 'acThemeBtn',
    'acTtsVoice', 'acTtsRate', 'acTtsRateVal', 'acTtsPitch', 'acTtsPitchVal', 'acTtsToggle',
    'acRoleImport', 'acRoleExport', 'acRoleFileInput',
    'acRoleImportUrl', 'acRoleUrlModal', 'acRoleUrlInput', 'acRoleUrlFetch',
    'acRoleSearch', 'acRoleFilter', 'acChatExport', 'acChatImport', 'acChatFileInput',
    'acNewRoleAvatar', 'acNewRoleAvatarFile', 'acNewRoleAvatarBtn', 'acNewRoleAvatarPreview',
    'acWorldSearch', 'acWorldCount', 'acWorldEnableAll', 'acWorldDisableAll', 'acWorldDeleteAll',
    'acWorldFileImport', 'acWorldFileInput',
    'acInputTokens',
    'acPanel', 'acPanelToggle', 'acPanelRoleAvatar', 'acPanelRoleName', 'acPanelRoleDesc', 'acPanelRoleSwitch', 'acPanelBranchList',
    'acPresetSelect', 'acPresetSave', 'acPresetDelete',
    'acGenTemp', 'acGenTempVal', 'acGenTopP', 'acGenTopPVal', 'acGenTopK', 'acGenTopKVal',
    'acGenFreq', 'acGenFreqVal', 'acGenPres', 'acGenPresVal', 'acGenMax', 'acGenMaxVal', 'acGenSave',
    'acAuthorNote', 'acAuthorNoteDepth', 'acAuthorNoteDepthVal',
    'acPromptTemplate', 'acPromptTemplateManage',
    'acContextPreview', 'acContinueBtn', 'acImpersonateBtn',
    'acTemplateModal', 'acTemplateList', 'acTemplateName', 'acTemplateContent', 'acTemplateSave',
    'acPresetSaveModal', 'acPresetName', 'acPresetDefault', 'acPresetSaveConfirm',
    'acContextModal', 'acContextInfo', 'acContextMessages',
    'acBranchModal',
    'acNewGroup', 'acGroupBar', 'acGroupMembers', 'acGroupEdit',
    'acGroupModal', 'acGroupModalTitle', 'acGroupName', 'acGroupMode', 'acGroupMemberList', 'acGroupSave',
    'acConvTokens']
    .forEach(function (id) { els[id] = document.getElementById(id); });

  // ============ 通用请求 ============

  function api(url, data, timeout) {
    return csrfFetch(url, {
      method: 'POST',
      body: JSON.stringify(data || {})
    }, timeout || 20000).catch(function (err) {
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
          predictEnabled: !!d.predictEnabled,
          predictCount: d.predictCount || 3,
          defaultModelIsOwn: !!d.defaultModelIsOwn,
          memoryDefaults: d.memoryDefaults || {}
        };
        applyPredictAvailability();
        state.quota = d.quota || null;
        state.quotaUnlimited = !!d.quotaUnlimited;
        canExport = !!d.canExport;
        applyExportVisibility();
        state.presets = d.presets || [];
        state.promptTemplates = d.promptTemplates || [];
        renderConversations();
        renderQuota();
        renderMyModels();
        renderProviderOptions();
        renderPresetSelect();
        renderPromptTemplateSelect();
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

  function renameConversation(c) {
    var title = window.prompt('重命名会话', c.title || '');
    if (title && title.trim() && title.trim() !== c.title) {
      api('/ai-chat/api/conversations/rename', { id: c.id, title: title.trim() }).then(function () {
        c.title = title.trim();
        if (state.currentConv && state.currentConv.id === c.id) els.acConvTitle.textContent = c.title;
        renderConversations();
      }).catch(function (err) { showToast(err.message, 'error'); });
    }
  }

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
      item.innerHTML = '<span class="ac-conv-title-sm"></span><button type="button" class="ac-conv-rename" title="重命名">✎</button><button type="button" class="ac-conv-del" title="删除会话">✕</button>';
      item.querySelector('.ac-conv-title-sm').textContent = (c.is_group ? '👥 ' : '') + (c.title || '新对话');
      item.addEventListener('click', function (e) {
        if (e.target.classList.contains('ac-conv-del') || e.target.classList.contains('ac-conv-rename')) return;
        selectConversation(c.id);
      });
      item.querySelector('.ac-conv-rename').addEventListener('click', function (e) {
        e.stopPropagation();
        renameConversation(c);
      });
      item.addEventListener('dblclick', function () { renameConversation(c); });
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
    // 当前会话走用户自己的 API：不受站内配额/条数限制
    if (convUsesOwnModel(state.currentConv)) {
      els.acQuotaBadge.textContent = '自有 API · 不限量';
      els.acQuotaBadge.className = 'ac-quota-badge own';
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
    clearSuggestions();
    state.currentConv = conv;
    renderConversations();
    els.acConvTitle.textContent = conv.title || '新对话';
    updateRoleLabel();
    updateModelLabel();
    renderQuota();
    updateShareBtn();
    renderGroupBar();
    closeAllModals();
    fetch('/ai-chat/api/conversations/' + conv.id + '/messages', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '加载失败');
        state.messages = (json.data.messages || []).map(function (m) {
          if (m.is_image) { m.isImage = true; m.imageUrl = m.image_url; m.imagePrompt = m.content; }
          return m;
        });
        state.branches = json.data.branches || [];
        state.worldBook = json.data.worldBook || [];
        state.summaries = json.data.summaries || [];
        renderMessages();
        populatePanel();
        checkAutoCompress();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  function updateRoleLabel() {
    if (state.currentConv && state.currentConv.is_group) {
      els.acRoleLabel.textContent = '群聊';
      els.acRoleBtn.classList.add('active');
      return;
    }
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
        renderQuota();
        hideModal('acModelModal');
        showToast(modelKey ? '模型已切换' : '已切换为自动选择', 'success');
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ============ 消息渲染 ============

  function updateConvTokens() {
    if (!els.acConvTokens) return;
    var total = state.messages.reduce(function (sum, m) { return sum + (m.tokens || 0); }, 0);
    var totalInput = state.messages.reduce(function (sum, m) { return sum + (m.input_tokens || 0); }, 0);
    var totalOutput = state.messages.reduce(function (sum, m) { return sum + (m.output_tokens || 0); }, 0);
    if (total > 0) {
      if (totalInput > 0 || totalOutput > 0) {
        els.acConvTokens.textContent = '本会话 ↑' + totalInput + ' ↓' + totalOutput + ' (共 ' + total + ' tokens)';
        els.acConvTokens.title = '输入 ' + totalInput + ' + 输出 ' + totalOutput + ' = ' + total + ' tokens';
      } else {
        els.acConvTokens.textContent = '本会话 ≈ ' + total + ' tokens';
        els.acConvTokens.title = '';
      }
    } else {
      els.acConvTokens.textContent = '';
      els.acConvTokens.title = '';
    }
  }

  function renderMessages() {
    els.acMessages.innerHTML = '';
    els.acEmpty.style.display = state.messages.length ? 'none' : 'block';
    if (!state.messages.length) {
      renderEmptyHint();
      updateConvTokens();
      return;
    }
    state.messages.forEach(function (m) {
      appendMessageEl(m, false);
    });
    updateConvTokens();
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

    var speaker = m.speaker_role_id ? state.roles.filter(function (r) { return r.id === m.speaker_role_id; })[0] : null;
    var avatarSrc = speaker ? speaker.avatar : (m.speaker_avatar || '');
    var avatar = document.createElement('div');
    avatar.className = 'ac-msg-avatar';
    if (m.role === 'user') {
      avatar.textContent = '🧑';
    } else if (avatarSrc) {
      var avImg = document.createElement('img');
      avImg.src = avatarSrc;
      avImg.alt = '';
      avImg.onerror = function () { avatar.textContent = '🎭'; };
      avatar.appendChild(avImg);
    } else {
      avatar.textContent = (speaker || m.speaker_name) ? '🎭' : '🤖';
    }

    var body = document.createElement('div');
    body.className = 'ac-msg-body';

    var meta = document.createElement('div');
    meta.className = 'ac-msg-meta';
    var name = document.createElement('span');
    name.textContent = m.role === 'user' ? '我' : (speaker ? speaker.name : (m.speaker_name || getCurrentRoleName() || 'AI'));
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
      var gi = m.genInfo || (m.gen_info ? tryParseJson(m.gen_info) : null);
      if (gi) {
        var parts = [];
        if (gi.finish_reason) parts.push('结束：' + gi.finish_reason);
        if (gi.continued) parts.push('自动续写 ' + gi.continued + ' 次');
        if (gi.temperature != null) parts.push('temp ' + gi.temperature);
        if (gi.max_tokens != null) parts.push('max ' + gi.max_tokens);
        if (parts.length) mtag.title = parts.join(' · ');
      }
      meta.appendChild(mtag);
    }
    if (m.tokens != null && m.tokens > 0) {
      var ttag = document.createElement('span');
      ttag.className = 'ac-msg-token-tag';
      if (m.input_tokens > 0 || m.output_tokens > 0) {
        ttag.textContent = '↑' + m.input_tokens + ' ↓' + m.output_tokens;
        ttag.title = '输入 ' + m.input_tokens + ' + 输出 ' + m.output_tokens + ' = ' + m.tokens + ' tokens';
      } else {
        ttag.textContent = m.tokens + ' tokens';
      }
      meta.appendChild(ttag);
    }
    var actions = document.createElement('span');
    actions.className = 'ac-msg-actions';
    buildMsgActions(actions, m);
    meta.appendChild(actions);
    body.appendChild(meta);

    var content = document.createElement('div');
    content.className = 'ac-msg-content';
    // 持久化的思维链：折叠展示（默认收起）
    if (m.role === 'assistant' && m.reasoning && !streaming) {
      var rbox = document.createElement('div');
      rbox.className = 'ac-msg-reasoning collapsed';
      var rhead = document.createElement('div');
      rhead.className = 'ac-reasoning-head';
      var rlabel = document.createElement('span');
      rlabel.className = 'ac-reasoning-label';
      rlabel.textContent = '已深度思考';
      var rtgl = document.createElement('button');
      rtgl.type = 'button';
      rtgl.className = 'ac-reasoning-toggle';
      rtgl.textContent = '展开';
      rtgl.addEventListener('click', function (e) {
        e.stopPropagation();
        rbox.classList.toggle('collapsed');
        rtgl.textContent = rbox.classList.contains('collapsed') ? '展开' : '收起';
      });
      rhead.appendChild(rlabel);
      rhead.appendChild(rtgl);
      var rbody = document.createElement('div');
      rbody.className = 'ac-reasoning-body';
      rbody.textContent = m.reasoning;
      rbox.appendChild(rhead);
      rbox.appendChild(rbody);
      body.appendChild(rbox);
    }
    if (m.isImage && m.imageUrl) {
      // 图片消息：显示图片
      var img = document.createElement('img');
      img.src = m.imageUrl;
      img.alt = m.imagePrompt || '生成的图片';
      img.style.cssText = 'max-width:100%;border-radius:8px;cursor:pointer;';
      img.onclick = function () { window.open(m.imageUrl, '_blank'); };
      content.appendChild(img);
      if (m.imagePrompt) {
        var caption = document.createElement('div');
        caption.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:6px;';
        caption.textContent = '🎨 ' + m.imagePrompt;
        content.appendChild(caption);
      }
    } else if (m.isImage && m.status === 'generating') {
      // 生成中占位
      content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);"><div class="ac-loading"></div>正在生成场景图片…</div>';
    } else {
      content.textContent = m.content || '';
    }
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

  function tryParseJson(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  function renderMarkdown(el) {
    if (!window.marked || !window.DOMPurify) return;
    try {
      var raw = marked.parse(el.textContent);
      el.innerHTML = DOMPurify.sanitize(raw);
      el.classList.add('markdown');
      // 代码块添加复制按钮 + 语法高亮
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
        if (window.hljs) {
          var codeEl = pre.querySelector('code');
          try { if (codeEl) window.hljs.highlightElement(codeEl); } catch (e) { /* 忽略高亮失败 */ }
        }
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
      addAction(container, '滑动', function (e) { e.stopPropagation(); showSwipeUI(m, container); });
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

  // 判断会话是否走「用户自己的 API」（自填模型）——与后端 resolveModel 优先级一致：
  // 显式 conv.model 命中自有模型即自有；命中站内全局模型即站内；为空或未匹配时回落到后端默认解析结果。
  function convUsesOwnModel(conv) {
    var ownKeys = (state.models || []).map(function (m) { return m.model_key; });
    var globalKeys = (state.globalModels || []).map(function (m) { return m.model_key; });
    var key = (conv && conv.model) ? String(conv.model) : '';
    if (key) {
      if (ownKeys.indexOf(key) !== -1) return true;
      if (globalKeys.indexOf(key) !== -1) return false;
    }
    return !!(state.settings && state.settings.defaultModelIsOwn);
  }

  function send() {
    if (state.streaming) return;
    var content = els.acInput.value.trim();
    if (!content) return;
    if (!state.settings.aiEnabled) {
      showToast('AI 聊天功能暂未开放', 'error');
      return;
    }
    // 站内 API 才受配额/条数限制；用户自己的 API 不限制
    if (state.quota && !state.quotaUnlimited && !convUsesOwnModel(state.currentConv) && state.quota.remaining <= 0) {
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
      updateTokenEstimate();
      clearSuggestions();
      // 用户消息立即上屏
      var userMsg = { id: 'u' + Date.now(), role: 'user', content: content, branch_id: conv.current_branch_id || 0 };
      state.messages.push(userMsg);
      els.acEmpty.style.display = 'none';
      appendMessageEl(userMsg, false);
      scrollToBottom(true);

      // AI 回复占位气泡：流式增量写入此条，避免 AI 内容追加到用户消息里
      // 群聊手动模式仅落用户消息，由成员芯片触发回复，不建占位气泡
      var assistantMsg = null;
      if (!(conv.is_group && conv.group_mode === 'manual')) {
        assistantMsg = { id: 'a' + Date.now(), role: 'assistant', content: '', status: 'streaming', branch_id: conv.current_branch_id || 0 };
        state.messages.push(assistantMsg);
        appendMessageEl(assistantMsg, true);
        scrollToBottom(true);
      }

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

  function showSwipeUI(m, container) {
    fetch('/ai-chat/api/messages/' + m.id + '/alternates', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '加载失败');
        var alts = json.data || [];
        if (alts.length <= 1) {
          showToast('暂无备选回复，可点「重生成」创建', 'info');
          return;
        }
        var activeIdx = 0;
        alts.forEach(function (a, i) { if (a.is_active) activeIdx = i; });
        var existing = container.querySelector('.ac-msg-swipe');
        if (existing) existing.remove();
        var swipe = document.createElement('span');
        swipe.className = 'ac-msg-swipe';
        var prev = document.createElement('button');
        prev.textContent = '◀';
        var count = document.createElement('span');
        count.className = 'ac-swipe-count';
        count.textContent = (activeIdx + 1) + '/' + alts.length;
        var next = document.createElement('button');
        next.textContent = '▶';
        var regen = document.createElement('button');
        regen.textContent = '＋';
        regen.title = '生成新备选';
        function navigate(idx) {
          if (idx < 0 || idx >= alts.length) return;
          api('/ai-chat/api/messages/swipe', { message_id: m.id, target_id: alts[idx].id }).then(function () {
            activeIdx = idx;
            count.textContent = (idx + 1) + '/' + alts.length;
            selectConversation(state.currentConv.id);
          }).catch(function (err) { showToast(err.message, 'error'); });
        }
        prev.addEventListener('click', function (e) { e.stopPropagation(); navigate(activeIdx - 1); });
        next.addEventListener('click', function (e) { e.stopPropagation(); navigate(activeIdx + 1); });
        regen.addEventListener('click', function (e) {
          e.stopPropagation();
          if (state.streaming) return;
          var placeholder = { id: 'sw' + Date.now(), role: 'assistant', content: '', status: 'streaming', branch_id: m.branch_id || 0 };
          state.messages.push(placeholder);
          appendMessageEl(placeholder, true);
          scrollToBottom(true);
          startStream('/ai-chat/api/messages/swipe-regenerate', { conversation_id: state.currentConv.id, message_id: m.id }, placeholder);
        });
        swipe.appendChild(prev);
        swipe.appendChild(count);
        swipe.appendChild(next);
        swipe.appendChild(regen);
        container.appendChild(swipe);
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // 流式发送核心：管理中止、增量渲染、结束落库；群聊支持多说话人顺序切换
  function startStream(url, body, placeholderMsg) {
    state.streaming = true;
    els.acSend.style.display = 'none';
    els.acStop.style.display = 'inline-block';
    var controller = new AbortController();
    state.abortController = controller;

    var currentMsg = placeholderMsg;
    var lastEl = placeholderMsg ? els.acMessages.lastElementChild : null;
    var typingEl = appendTypingDots();
    var noReply = false;

    function updateContent(text) {
      var contentEl = lastEl && lastEl.querySelector('.ac-msg-content');
      if (contentEl) {
        contentEl.textContent = text;
        contentEl.classList.add('streaming');
        scrollToBottom();
      }
    }

    // 思维链（reasoning_content）流式渲染：折叠盒展示，默认展开、生成结束后收起
    function updateReasoning(text) {
      if (!lastEl) return;
      var body = lastEl.querySelector('.ac-msg-body');
      if (!body) return;
      var box = body.querySelector('.ac-msg-reasoning');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ac-msg-reasoning streaming';
        box.innerHTML = '<div class="ac-reasoning-head"><span class="ac-reasoning-dot"></span><span class="ac-reasoning-label">思考中…</span><button type="button" class="ac-reasoning-toggle">收起</button></div><div class="ac-reasoning-body"></div>';
        var contentEl = body.querySelector('.ac-msg-content');
        if (contentEl) body.insertBefore(box, contentEl); else body.appendChild(box);
        var tgl = box.querySelector('.ac-reasoning-toggle');
        tgl.addEventListener('click', function () {
          box.classList.toggle('collapsed');
          tgl.textContent = box.classList.contains('collapsed') ? '展开' : '收起';
        });
      }
      box.querySelector('.ac-reasoning-body').textContent = text;
      scrollToBottom();
    }

    function finishReasoning() {
      if (!lastEl) return;
      var box = lastEl.querySelector('.ac-msg-reasoning');
      if (!box) return;
      box.classList.remove('streaming');
      box.classList.add('collapsed');
      var label = box.querySelector('.ac-reasoning-label');
      if (label) label.textContent = '已深度思考';
      var tgl = box.querySelector('.ac-reasoning-toggle');
      if (tgl) tgl.textContent = '展开';
    }

    // 截断续写提示（防截断自动续写）
    function showContinue(pass) {
      if (!lastEl) return;
      var body = lastEl.querySelector('.ac-msg-body');
      if (!body) return;
      var tip = body.querySelector('.ac-msg-continue');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'ac-msg-continue';
        body.appendChild(tip);
      }
      tip.textContent = '✍️ 内容被截断，正在自动续写（第 ' + pass + ' 次）…';
      scrollToBottom();
    }

    // 说话人切换时把上一条占位气泡就地定稿
    function settleCurrent() {
      if (!currentMsg) return;
      if (currentMsg.content) {
        currentMsg.status = currentMsg.status === 'error' ? 'error' : 'done';
        if (lastEl && lastEl.parentNode) lastEl.remove();
        appendMessageEl(currentMsg, false);
      } else {
        if (lastEl && lastEl.parentNode) lastEl.remove();
        state.messages = state.messages.filter(function (x) { return x !== currentMsg; });
      }
      currentMsg = null;
      lastEl = null;
    }

    streamFetch(url, body, function (event, data) {
      if (event === 'speaker') {
        settleCurrent();
        if (typingEl) { typingEl.remove(); typingEl = null; }
        currentMsg = {
          id: 'g' + Date.now(), role: 'assistant', content: '', status: 'streaming',
          speaker_role_id: data.role_id, speaker_name: data.name, speaker_avatar: data.avatar,
          branch_id: state.currentConv ? (state.currentConv.current_branch_id || 0) : 0
        };
        state.messages.push(currentMsg);
        lastEl = appendMessageEl(currentMsg, true);
        typingEl = appendTypingDots();
        scrollToBottom(true);
      } else if (event === 'delta') {
        if (!currentMsg) return;
        currentMsg.content = (currentMsg.content || '') + (data.delta || '');
        updateContent(currentMsg.content);
      } else if (event === 'reasoning') {
        if (!currentMsg) return;
        currentMsg.reasoning = (currentMsg.reasoning || '') + (data.delta || '');
        updateReasoning(currentMsg.reasoning);
      } else if (event === 'continue') {
        if (!currentMsg) return;
        showContinue(data.pass || 1);
      } else if (event === 'message') {
        if (!currentMsg) return;
        currentMsg.id = data.id;
        currentMsg.content = data.content || currentMsg.content;
        currentMsg.tokens = data.tokens;
        currentMsg.inputTokens = data.inputTokens;
        currentMsg.outputTokens = data.outputTokens;
        if (data.reasoning != null) currentMsg.reasoning = data.reasoning;
        if (data.gen_info) currentMsg.genInfo = data.gen_info;
        if (data.model) currentMsg.model = data.model;
        if (data.speaker_role_id) currentMsg.speaker_role_id = data.speaker_role_id;
        if (data.speaker_name) currentMsg.speaker_name = data.speaker_name;
        if (data.quota) state.quota = data.quota;
        renderQuota();
      } else if (event === 'error') {
        if (!currentMsg) return;
        currentMsg.status = 'error';
        currentMsg.content = data.message || '生成失败';
        if (data.messageId) currentMsg.id = data.messageId;
      } else if (event === 'done') {
        noReply = !!data.noReply;
        finishReasoning();
        if (currentMsg) currentMsg.status = currentMsg.status === 'error' ? 'error' : (data.aborted ? 'stopped' : 'done');
      }
    }, controller.signal)
      .catch(function (err) {
        if (!currentMsg) return;
        if (err && err.name === 'AbortError') {
          currentMsg.status = 'stopped';
        } else {
          currentMsg.status = 'error';
          currentMsg.content = (err && err.message) || '网络请求失败';
        }
      })
      .then(function () {
        state.streaming = false;
        els.acSend.style.display = '';
        els.acStop.style.display = 'none';
        if (typingEl) typingEl.remove();
        if (noReply) {
          if (lastEl && lastEl.parentNode) lastEl.remove();
          state.messages = state.messages.filter(function (x) { return x !== currentMsg; });
          if (state.currentConv) selectConversation(state.currentConv.id);
          return;
        }
        if (!currentMsg) {
          if (state.currentConv) selectConversation(state.currentConv.id);
          return;
        }
        finalizeMessage(currentMsg, lastEl);
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
    updateConvTokens();
    // 刷新会话列表（标题/计数可能变化）与配额，保持当前会话选中
    var convId = state.currentConv ? state.currentConv.id : null;
    loadBootstrap({ autoSelect: false })
      .then(function () {
        if (convId) {
          state.currentConv = state.conversations.filter(function (c) { return c.id === convId; })[0] || state.currentConv;
          renderConversations();
          updateModelLabel();
        }
        fetchPredictions();
      })
      .catch(function () { /* ignore */ });
    scrollToBottom();
  }

  function stopStream() {
    if (!state.streaming || !state.abortController) return;
    state.abortController.abort();
  }

  // ============ 群聊（SillyTavern Group Chats） ============

  var groupEditId = null;

  function groupMemberIds(conv) {
    try {
      var ids = JSON.parse(conv.group_members || '[]');
      return Array.isArray(ids) ? ids : [];
    } catch (e) { return []; }
  }

  function renderGroupBar() {
    if (!els.acGroupBar) return;
    var conv = state.currentConv;
    if (!conv || !conv.is_group) {
      els.acGroupBar.hidden = true;
      return;
    }
    els.acGroupBar.hidden = false;
    els.acGroupMembers.innerHTML = '';
    var ids = groupMemberIds(conv);
    ids.forEach(function (id) {
      var role = state.roles.filter(function (r) { return r.id === id; })[0];
      if (!role) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ac-group-chip';
      chip.title = '让「' + role.name + '」回复';
      if (role.avatar) {
        var img = document.createElement('img');
        img.src = role.avatar;
        img.alt = '';
        img.onerror = function () { chip.textContent = '🎭 ' + role.name; };
        chip.appendChild(img);
      }
      chip.appendChild(document.createTextNode(role.name));
      chip.addEventListener('click', function () { groupReplyAs(role); });
      els.acGroupMembers.appendChild(chip);
    });
    var modeTag = document.createElement('span');
    modeTag.className = 'ac-group-mode';
    modeTag.textContent = conv.group_mode === 'manual' ? '手动' : '轮流';
    els.acGroupMembers.appendChild(modeTag);
  }

  function groupReplyAs(role) {
    if (state.streaming) return;
    if (!state.currentConv || !state.currentConv.is_group) return;
    var placeholder = {
      id: 'gr' + Date.now(), role: 'assistant', content: '', status: 'streaming',
      speaker_role_id: role.id, speaker_name: role.name, speaker_avatar: role.avatar || '',
      branch_id: state.currentConv.current_branch_id || 0
    };
    state.messages.push(placeholder);
    els.acEmpty.style.display = 'none';
    appendMessageEl(placeholder, true);
    scrollToBottom(true);
    startStream('/ai-chat/api/group/reply', { conversation_id: state.currentConv.id, role_id: role.id }, placeholder);
  }

  function openGroupModal(conv) {
    groupEditId = conv ? conv.id : null;
    els.acGroupModalTitle.textContent = conv ? '管理群聊' : '创建群聊';
    els.acGroupSave.textContent = conv ? '保存' : '创建';
    els.acGroupName.value = conv ? (conv.title || '') : '';
    els.acGroupMode.value = conv && conv.group_mode === 'manual' ? 'manual' : 'round';
    var selected = conv ? groupMemberIds(conv) : [];
    els.acGroupMemberList.innerHTML = '';
    state.roles.forEach(function (r) {
      var label = document.createElement('label');
      label.className = 'ac-group-member-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = r.id;
      cb.checked = selected.indexOf(r.id) !== -1;
      label.appendChild(cb);
      label.appendChild(document.createTextNode((r.is_official ? '🎭 ' : '👤 ') + r.name));
      els.acGroupMemberList.appendChild(label);
    });
    showModal('acGroupModal');
  }

  function saveGroup() {
    var members = [];
    els.acGroupMemberList.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      members.push(parseInt(cb.value, 10));
    });
    if (members.length < 2) { showToast('群聊至少需要 2 个角色', 'error'); return; }
    if (members.length > 16) { showToast('群聊最多 16 个角色', 'error'); return; }
    var payload = {
      title: els.acGroupName.value.trim() || (groupEditId ? undefined : '新群聊'),
      members: members,
      mode: els.acGroupMode.value
    };
    var promise;
    if (groupEditId) {
      payload.id = groupEditId;
      promise = api('/ai-chat/api/conversations/group', payload);
    } else {
      promise = api('/ai-chat/api/conversations', {
        is_group: 1, group_members: members, group_mode: els.acGroupMode.value,
        title: els.acGroupName.value.trim() || '新群聊'
      });
    }
    promise.then(function (json) {
      if (!json.success) { showToast(json.error || '操作失败', 'error'); return; }
      closeAllModals();
      showToast(groupEditId ? '群聊已更新' : '群聊已创建', 'success');
      var id = json.data.id;
      loadBootstrap({ autoSelect: false }).then(function () {
        selectConversation(id);
      });
    }).catch(function (err) { showToast(err.message || '操作失败', 'error'); });
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
      if (!json.success || !json.data) { showToast(json.error || '角色创建失败', 'error'); return; }
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

  // 导出为独立高危权限（aichat.export），无权限隐藏入口
  function applyExportVisibility() {
    if (els.acChatExport) els.acChatExport.style.display = canExport ? '' : 'none';
    if (els.acRoleExport) els.acRoleExport.style.display = canExport ? '' : 'none';
  }
  applyExportVisibility();

  // 导出当前会话角色为 JSON（兼容 SillyTavern V2 格式）
  function exportCurrentRole() {
    if (!canExport) { showToast('无导出权限，请先申请 AI聊天导出 权限', 'error'); return; }
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
              var utf8Bytes = new Uint8Array(binary.length);
              for (var m = 0; m < binary.length; m++) {
                utf8Bytes[m] = binary.charCodeAt(m);
              }
              return new TextDecoder('utf-8').decode(utf8Bytes);
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
      if (!json.success || !json.data) { showToast(json.error || '角色导入失败', 'error'); return; }
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
              if (!createJson.success || !createJson.data) { showToast(createJson.error || '角色创建失败', 'error'); return; }
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
    if (!canExport) { showToast('无导出权限，请先申请 AI聊天导出 权限', 'error'); return; }
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
        var text = e.target.result;
        var data = null;
        try { data = JSON.parse(text); } catch (ex) { data = null; }
        if (data && data.chat_export && Array.isArray(data.messages)) {
          postChatImport(data);
          return;
        }
        // SillyTavern 聊天记录：JSONL（每行一条 mes/is_user）或对象数组
        var lines = Array.isArray(data) ? data : String(text).split(/\r?\n/);
        var msgs = [];
        var charName = '';
        lines.forEach(function (ln) {
          var obj = ln;
          if (typeof ln === 'string') {
            if (!ln.trim()) return;
            try { obj = JSON.parse(ln); } catch (ex2) { return; }
          }
          if (!obj || typeof obj !== 'object') return;
          var content = String(obj.mes || obj.content || '').trim();
          if (!content) return;
          if (!charName && obj.character_name) charName = String(obj.character_name);
          msgs.push({ role: obj.is_user ? 'user' : (obj.is_system ? 'system' : 'assistant'), content: content });
        });
        if (!msgs.length) {
          showToast('无效的聊天记录文件（支持本站 JSON 与 SillyTavern JSONL）', 'error');
          return;
        }
        postChatImport({
          chat_export: true,
          title: file.name.replace(/\.(jsonl|json)$/i, ''),
          character: charName ? { name: charName } : null,
          messages: msgs
        });
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  function postChatImport(data) {
    api('/ai-chat/api/conversations/import', data).then(function (json) {
      if (json.success && json.data) {
        showToast('聊天记录已导入（' + data.messages.length + ' 条消息）', 'success');
        loadBootstrap({ autoSelect: false }).then(function () {
          var newConv = state.conversations.filter(function (c) { return c.id === json.data.id; })[0];
          if (newConv) selectConversation(newConv.id);
        });
      } else {
        showToast(json.error || '导入失败', 'error');
      }
    }).catch(function (err) { showToast(err.message || '导入失败', 'error'); });
  }

  // ============ 世界书 ============

  function openWorldModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    renderWorldList();
    switchPanelTab('worldbook');
    showPanel();
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
      if (w.selective && w.secondary_keys) {
        var stag = document.createElement('span');
        stag.className = 'ac-world-pos ac-world-sel';
        stag.textContent = '二级键';
        stag.title = '需同时命中：' + w.secondary_keys;
        item.appendChild(stag);
      }
      var prob = w.probability == null ? 100 : Number(w.probability);
      if (prob < 100) {
        var ptag = document.createElement('span');
        ptag.className = 'ac-world-pos ac-world-prob';
        ptag.textContent = prob + '%';
        ptag.title = '触发概率 ' + prob + '%';
        item.appendChild(ptag);
      }
      if (w.position === 'in_chat') {
        var dtag = document.createElement('span');
        dtag.className = 'ac-world-pos ac-world-depth';
        dtag.textContent = '深度' + (w.depth == null ? 4 : w.depth);
        dtag.title = '插入到倒数第 N 条消息之前';
        item.appendChild(dtag);
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

  // 构造世界书条目完整写入负载（保留所有字段，避免部分更新丢字段）
  function worldPayload(w, enabled) {
    return {
      conversation_id: state.currentConv.id,
      id: w.id,
      key: w.key || '',
      content: w.content || '',
      position: w.position || 'before_char',
      enabled: enabled,
      constant: w.constant ? 1 : 0,
      secondary_keys: w.secondary_keys || '',
      selective: w.selective ? 1 : 0,
      probability: w.probability == null ? 100 : w.probability,
      depth: w.depth == null ? 4 : w.depth
    };
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
      constant: w.constant ? 1 : 0,
      secondary_keys: w.secondary_keys || '',
      selective: w.selective ? 1 : 0,
      probability: w.probability == null ? 100 : w.probability,
      depth: w.depth == null ? 4 : w.depth
    }).then(function () {
      w.enabled = w.enabled ? 0 : 1;
      renderWorldList();
      showToast(w.enabled ? '条目已启用' : '条目已停用', 'success');
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  function positionLabel(pos) {
    var map = { system_top: '系统前', before_char: '角色前', after_char: '角色后', user_top: '消息尾', assistant_top: 'AI前', in_chat: '按深度插入' };
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

  // 世界书文件导入：SillyTavern lorebook JSON（entries 对象/数组）或 Markdown（按标题拆条目）
  function parseWorldJson(data) {
    var raw = [];
    if (Array.isArray(data)) raw = data;
    else if (data && typeof data === 'object') {
      if (Array.isArray(data.entries)) raw = data.entries;
      else if (data.entries && typeof data.entries === 'object') raw = Object.keys(data.entries).map(function (k) { return data.entries[k]; });
      else if (data.content) raw = [data];
    }
    // SillyTavern position 数值 → 本站位置（0=beforeCharDefs 前, 1=afterCharDefs 前, 2=@Depth, 3=before EM, 4=after EM, 5=before AN, 6=after AN）
    var posMap = { 0: 'before_char', 1: 'after_char', 2: 'in_chat', 3: 'system_top', 4: 'system_top', 5: 'user_top', 6: 'assistant_top' };
    var posStrMap = { beforeChar: 'before_char', afterChar: 'after_char', beforeEM: 'system_top', afterEM: 'system_top', beforeAN: 'user_top', afterAN: 'assistant_top', atDepth: 'in_chat' };
    var positions = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'in_chat'];
    function normKeys(v) {
      if (Array.isArray(v)) return v.map(function (k) { return String(k).trim(); }).filter(Boolean);
      return String(v || '').split(/[,，]/).map(function (k) { return k.trim(); }).filter(Boolean);
    }
    var out = [];
    raw.forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var key = normKeys(e.key || e.keys).join(',');
      if (!key && e.comment) key = String(e.comment).trim();
      if (!key && e.name) key = String(e.name).trim();
      var secondary = normKeys(e.key_secondary || e.secondary_keys).join(',');
      var content = String(e.content || '').trim();
      if (!content) return;
      var pos;
      if (positions.indexOf(e.position) !== -1) pos = e.position;
      else if (posStrMap[e.position]) pos = posStrMap[e.position];
      else if (e.injection_position === 2 || Number(e.position) === 2) pos = 'in_chat';
      else pos = posMap[Number(e.position)] || 'before_char';
      var selective = (e.selective === true || e.selective === 1) ? 1 : (secondary ? 1 : 0);
      var prob = e.probability == null ? 100 : parseInt(e.probability, 10);
      if (isNaN(prob)) prob = 100;
      var depth = e.depth != null ? parseInt(e.depth, 10) : (e.injection_depth != null ? parseInt(e.injection_depth, 10) : 4);
      if (isNaN(depth)) depth = 4;
      out.push({
        key: key,
        content: content,
        position: pos,
        enabled: (e.disable === true || e.enabled === false || e.enabled === 0) ? 0 : 1,
        constant: (e.constant === true || e.constant === 1) ? 1 : 0,
        secondary_keys: secondary,
        selective: selective,
        probability: prob,
        depth: depth,
        sort_order: parseInt(e.insertion_order, 10) || parseInt(e.order, 10) || parseInt(e.sort_order, 10) || i
      });
    });
    return out;
  }

  function parseWorldMarkdown(text, fileName) {
    var parts = String(text).split(/^#{1,3}[ \t]+(.+)$/m);
    var base = String(fileName || '').replace(/\.(md|markdown)$/i, '');
    var out = [];
    if (parts[0] && parts[0].trim()) out.push({ key: base, content: parts[0].trim() });
    for (var i = 1; i + 1 < parts.length; i += 2) {
      var body = (parts[i + 1] || '').trim();
      if (body) out.push({ key: parts[i].trim(), content: body });
    }
    if (!out.length && String(text).trim()) out.push({ key: base, content: String(text).trim() });
    return out;
  }

  function importWorldFile(file) {
    if (!file) return;
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = String(e.target.result);
      var entries;
      if (/\.(md|markdown)$/i.test(file.name)) {
        entries = parseWorldMarkdown(text, file.name);
      } else {
        var data;
        try { data = JSON.parse(text); } catch (err) { showToast('JSON 解析失败：' + err.message, 'error'); return; }
        entries = parseWorldJson(data);
      }
      if (!entries.length) { showToast('未找到可导入的世界书条目', 'error'); return; }
      api('/ai-chat/api/world-book/import', { conversation_id: state.currentConv.id, entries: entries }).then(function (json) {
        if (json.success) {
          showToast('世界书已导入 ' + json.data.imported + ' 条' + (json.data.skipped ? '，跳过 ' + json.data.skipped + ' 条' : ''), 'success');
          return fetch('/ai-chat/api/world-book?conversation_id=' + state.currentConv.id, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j.success) { state.worldBook = j.data || []; renderWorldList(); } });
        }
        showToast(json.error || '导入失败', 'error');
      }).catch(function (err) { showToast(err.message || '导入失败', 'error'); });
    };
    reader.readAsText(file, 'UTF-8');
  }

  function openWorldEdit(w) {
    els.acWorldEditTitle.textContent = w ? '编辑条目' : '添加条目';
    els.acWorldKey.value = w ? (w.key || '') : '';
    els.acWorldPos.value = w ? (w.position || 'before_char') : 'before_char';
    els.acWorldConstant.checked = Boolean(w && w.constant);
    els.acWorldContent.value = w ? (w.content || '') : '';
    if (els.acWorldSecondary) els.acWorldSecondary.value = w ? (w.secondary_keys || '') : '';
    if (els.acWorldSelective) els.acWorldSelective.checked = Boolean(w && w.selective);
    if (els.acWorldProbability) els.acWorldProbability.value = w && w.probability != null ? w.probability : 100;
    if (els.acWorldDepth) els.acWorldDepth.value = w && w.depth != null ? w.depth : 4;
    els.acWorldDelete.style.display = w ? 'inline-block' : 'none';
    els.acWorldEditModal.dataset.id = w ? w.id : '';
    updateWorldAdvancedVisibility();
    showModal('acWorldEditModal');
  }

  // 依据「位置/选择性」联动显示二级键、深度输入
  function updateWorldAdvancedVisibility() {
    if (els.acWorldDepthWrap) {
      els.acWorldDepthWrap.style.display = (els.acWorldPos && els.acWorldPos.value === 'in_chat') ? '' : 'none';
    }
    if (els.acWorldSelectiveWrap) {
      var on = els.acWorldSelective && els.acWorldSelective.checked;
      els.acWorldSecondary && (els.acWorldSecondary.disabled = !on);
    }
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
      constant: els.acWorldConstant.checked ? 1 : 0,
      secondary_keys: els.acWorldSecondary ? els.acWorldSecondary.value : '',
      selective: els.acWorldSelective && els.acWorldSelective.checked ? 1 : 0,
      probability: els.acWorldProbability ? parseInt(els.acWorldProbability.value, 10) : 100,
      depth: els.acWorldDepth ? parseInt(els.acWorldDepth.value, 10) : 4
    };
    if (isNaN(payload.probability)) payload.probability = 100;
    if (isNaN(payload.depth)) payload.depth = 4;
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
        return api('/ai-chat/api/world-book', worldPayload(w, 1)).then(function () { w.enabled = 1; });
      } else if (action === 'disableAll' && w.enabled) {
        return api('/ai-chat/api/world-book', worldPayload(w, 0)).then(function () { w.enabled = 0; });
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
    switchPanelTab('memory');
    showPanel();
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

  // ============ 记忆补录 ============

  var backfillTimer = null;
  var BACKFILL_PHASE_NAMES = { summaries: '逐轮总结', vectors: '向量坐标', groups: '二次压缩' };

  function backfillGet(url) {
    return fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '请求失败');
        return json.data;
      });
  }

  function fmtEta(ms) {
    if (ms == null || isNaN(ms)) return '计算中…';
    if (ms < 1000) return '即将完成';
    var s = Math.round(ms / 1000);
    if (s < 60) return '约 ' + s + ' 秒';
    var m = Math.round(s / 60);
    if (m < 60) return '约 ' + m + ' 分钟';
    return '约 ' + Math.round(m / 60) + ' 小时';
  }

  function renderBackfillStatus(d) {
    if (!els.acBackfillStatus) return;
    var lines = [];
    lines.push('总轮次：<b>' + d.totalRounds + '</b>（空轮 ' + d.emptyRounds + ' 个跳过）· 模式：' + escapeHtml(d.mode || 'summary'));
    lines.push('逐轮总结：已完成 <b>' + d.summariesDone + '</b> · 失败 <b>' + (d.summariesFailed || 0) + '</b> · 待补 <b>' + d.summariesMissing + '</b>');
    var vecLine = '向量坐标：已完成 <b>' + d.vectorsDone + '</b> · 过期 <b>' + (d.vectorsStale || 0) + '</b> · 待补 <b>' + d.vectorsMissing + '</b>';
    lines.push(vecLine);
    lines.push('二次压缩：已完成 <b>' + d.groupsDone + '</b> / 预计 <b>' + d.groupsExpected + '</b> 组');
    lines.push('向量模型：' + (d.hasEmbeddings ? escapeHtml(d.embModel || '已配置') : '<span style="color:#e0a800;">未配置</span>'));
    els.acBackfillStatus.innerHTML = lines.join('<br>');

    // 向量模型未配置 / 更换后需重新补录的提示
    var warn = '';
    if (!d.hasEmbeddings) {
      warn = '增强（向量）补录需要先在后台配置向量模型，否则「向量坐标」阶段无法执行。';
    } else if (d.vectorsStale > 0) {
      warn = '检测到 ' + d.vectorsStale + ' 条向量坐标来自旧的向量模型，已过期。请重新补录「向量坐标」以使用当前模型 ' + escapeHtml(d.embModel || '') + '。';
    }
    if (els.acBackfillEmbWarn) {
      els.acBackfillEmbWarn.textContent = warn;
      els.acBackfillEmbWarn.style.display = warn ? 'block' : 'none';
    }
    // 未配置向量模型时禁用向量按钮
    if (els.acBackfillVectors) els.acBackfillVectors.disabled = !d.hasEmbeddings;
  }

  function setBackfillButtonsDisabled(disabled) {
    ['acBackfillSummaries', 'acBackfillVectors', 'acBackfillGroups', 'acBackfillAll'].forEach(function (id) {
      if (els[id]) els[id].disabled = disabled || (id === 'acBackfillVectors' && !state.backfillHasEmb);
    });
    if (els.acBackfillCancel) els.acBackfillCancel.style.display = disabled ? 'inline-block' : 'none';
  }

  function renderBackfillProgress(job) {
    if (!els.acBackfillProgress) return;
    if (!job || (!job.running && !job.finished)) {
      els.acBackfillProgress.style.display = 'none';
      return;
    }
    els.acBackfillProgress.style.display = 'block';
    var phaseName = BACKFILL_PHASE_NAMES[job.phase] || job.phase || '';
    var pct = job.total > 0 ? Math.round(job.done / job.total * 100) : 0;
    if (els.acBackfillBar) els.acBackfillBar.style.width = pct + '%';
    if (job.finished) {
      els.acBackfillPhase.textContent = job.error ? '补录失败' : '补录完成';
      els.acBackfillMeta.textContent = job.error ? job.error : '全部阶段已处理完毕。';
      if (els.acBackfillBar) els.acBackfillBar.style.width = '100%';
      return;
    }
    els.acBackfillPhase.textContent = (job.waiting ? '⏳ 等待当前回复结束… ' : '▶ ') + phaseName;
    var meta = job.done + ' / ' + job.total + '（' + pct + '%）';
    if (!job.waiting) meta += ' · 预计剩余 ' + fmtEta(job.etaMs);
    els.acBackfillMeta.textContent = meta;
  }

  function stopBackfillPolling() {
    if (backfillTimer) { clearTimeout(backfillTimer); backfillTimer = null; }
  }

  function pollBackfillProgress() {
    if (!state.currentConv) { stopBackfillPolling(); return; }
    backfillGet('/ai-chat/api/memory/backfill/progress?conversation_id=' + state.currentConv.id)
      .then(function (job) {
        renderBackfillProgress(job);
        if (job && job.running) {
          backfillTimer = setTimeout(pollBackfillProgress, 1200);
        } else {
          stopBackfillPolling();
          setBackfillButtonsDisabled(false);
          // 补录结束后刷新状态统计
          loadBackfillStatus();
        }
      })
      .catch(function () { stopBackfillPolling(); setBackfillButtonsDisabled(false); });
  }

  function loadBackfillStatus() {
    if (!state.currentConv) return Promise.resolve();
    return backfillGet('/ai-chat/api/memory/status?conversation_id=' + state.currentConv.id)
      .then(function (d) {
        state.backfillHasEmb = !!d.hasEmbeddings;
        renderBackfillStatus(d);
      })
      .catch(function (err) {
        if (els.acBackfillStatus) els.acBackfillStatus.textContent = err.message;
      });
  }

  function openMemoryBackfill() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    showModal('acMemoryBackfillModal');
    if (els.acBackfillStatus) els.acBackfillStatus.textContent = '加载中…';
    loadBackfillStatus();
    // 若已有任务在跑，立即恢复轮询
    backfillGet('/ai-chat/api/memory/backfill/progress?conversation_id=' + state.currentConv.id)
      .then(function (job) {
        if (job && job.running) {
          setBackfillButtonsDisabled(true);
          renderBackfillProgress(job);
          stopBackfillPolling();
          backfillTimer = setTimeout(pollBackfillProgress, 1200);
        } else {
          renderBackfillProgress(job);
        }
      })
      .catch(function () { /* ignore */ });
  }

  function startMemoryBackfill(phases) {
    if (!state.currentConv) return;
    setBackfillButtonsDisabled(true);
    api('/ai-chat/api/memory/backfill', { conversation_id: state.currentConv.id, phases: phases })
      .then(function () {
        showToast('补录已开始（后台进行，可关闭弹窗）', 'info');
        renderBackfillProgress({ running: true, phase: phases[0], done: 0, total: 0, waiting: false });
        els.acBackfillProgress.style.display = 'block';
        stopBackfillPolling();
        backfillTimer = setTimeout(pollBackfillProgress, 800);
      })
      .catch(function (err) {
        setBackfillButtonsDisabled(false);
        showToast(err.message, 'error');
      });
  }

  function cancelMemoryBackfill() {
    if (!state.currentConv) return;
    api('/ai-chat/api/memory/backfill/cancel', { conversation_id: state.currentConv.id })
      .then(function () { showToast('已请求取消补录', 'info'); })
      .catch(function (err) { showToast(err.message, 'error'); });
  }


  // ============ 对话压缩 ============

  function compressConversation() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    var keepRecent = els.acCompressKeep ? parseInt(els.acCompressKeep.value, 10) || 10 : 10;
    if (!confirm('将压缩 ' + state.messages.length + ' 条消息中的旧消息，保留最近 ' + keepRecent + ' 条。确定继续？')) return;

    showToast('正在压缩对话…', 'info');
    api('/ai-chat/api/conversations/compress', {
      id: state.currentConv.id,
      keep_recent: keepRecent
    }, 60000).then(function (res) {
      if (res.success) {
        showToast('压缩完成：' + res.compressed + ' 条消息已摘要', 'success');
        selectConversation(state.currentConv.id);
      } else {
        showToast(res.error || '压缩失败', 'error');
      }
    }).catch(function (err) {
      showToast(err.message || '压缩失败', 'error');
    });
  }

  // 自动压缩检查（消息过多时提示）
  function checkAutoCompress() {
    if (!els.acAutoCompress || !els.acAutoCompress.checked) return;
    if (!state.currentConv || !state.messages) return;
    var threshold = els.acCompressKeep ? (parseInt(els.acCompressKeep.value, 10) || 10) * 3 : 30;
    if (state.messages.length > threshold) {
      showToast('对话较长（' + state.messages.length + ' 条），建议点击 📦 压缩历史消息', 'info', 5000);
    }
  }

  // ============ 场景图片生成 ============

  function generateSceneImage() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    if (state.streaming) { showToast('请等待当前消息生成完成', 'error'); return; }

    showToast('正在根据对话场景生成图片描述…', 'info');

    // 添加一个占位消息
    var placeholder = {
      id: 'img_' + Date.now(),
      role: 'system',
      content: '🎨 正在生成场景图片…',
      status: 'generating',
      isImage: true
    };
    state.messages.push(placeholder);
    appendMessageEl(placeholder, true);
    scrollToBottom(true);

    api('/ai-chat/api/image/generate', {
      conversation_id: state.currentConv.id
    }, 120000).then(function (res) {
      if (res.success && res.data && res.data.taskId) {
        // 开始轮询任务状态
        pollImageTask(res.data.taskId, placeholder, res.data.prompt);
      } else {
        // 移除占位消息
        var idx = state.messages.indexOf(placeholder);
        if (idx >= 0) state.messages.splice(idx, 1);
        renderMessages();
        showToast(res.error || '图片生成失败', 'error');
      }
    }).catch(function (err) {
      // 移除占位消息
      var idx = state.messages.indexOf(placeholder);
      if (idx >= 0) state.messages.splice(idx, 1);
      renderMessages();
      showToast(err.message || '图片生成失败', 'error');
    });
  }

  // 轮询图片生成任务状态
  function pollImageTask(taskId, placeholder, prompt) {
    var pollCount = 0;
    var maxPolls = 60; // 最多轮询 60 次（约 2 分钟）
    var pollInterval = 2000; // 每 2 秒轮询一次

    function poll() {
      pollCount++;
      fetch('/ai-image/api/status?task=' + encodeURIComponent(taskId), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.success) {
            if (pollCount >= maxPolls) {
              updateImagePlaceholder(placeholder, null, '图片生成超时');
              return;
            }
            setTimeout(poll, pollInterval);
            return;
          }

          var task = res.data;
          if (task.status === 'running' || task.status === 'pending') {
            // 继续轮询
            if (pollCount >= maxPolls) {
              updateImagePlaceholder(placeholder, null, '图片生成超时');
              return;
            }
            setTimeout(poll, pollInterval);
          } else if (task.status === 'success') {
            // 生成成功：images 为 [{ path, url }] 对象数组
            var first = task.result && task.result.images && task.result.images[0];
            var imageUrl = first ? (first.url || first.path) : null;
            updateImagePlaceholder(placeholder, imageUrl, prompt);
            showToast('场景图片已生成', 'success');
            // 持久化图片消息到会话
            if (imageUrl && state.currentConv) {
              var oldId = placeholder.id;
              api('/ai-chat/api/image/save', {
                conversation_id: state.currentConv.id,
                image_url: imageUrl,
                prompt: prompt || ''
              }, 15000).then(function (saveRes) {
                if (saveRes.success && saveRes.data && saveRes.data.id) {
                  placeholder.id = saveRes.data.id;
                  var msgEl = document.querySelector('.ac-msg[data-id="' + oldId + '"]');
                  if (msgEl) msgEl.setAttribute('data-id', saveRes.data.id);
                }
              }).catch(function () { /* 保存失败不影响展示 */ });
            }
          } else if (task.status === 'failed' || task.status === 'cancelled') {
            updateImagePlaceholder(placeholder, null, task.error || '图片生成失败');
          }
        })
        .catch(function (err) {
          if (pollCount < maxPolls) {
            setTimeout(poll, pollInterval);
          } else {
            updateImagePlaceholder(placeholder, null, '轮询失败：' + err.message);
          }
        });
    }

    poll();
  }

  // 更新图片占位消息
  function updateImagePlaceholder(placeholder, imageUrl, promptOrError) {
    var idx = state.messages.indexOf(placeholder);
    if (idx < 0) return;

    if (imageUrl) {
      placeholder.status = 'done';
      placeholder.imageUrl = imageUrl;
      placeholder.imagePrompt = promptOrError;
      placeholder.content = '🎨 ' + (promptOrError || '场景图片');
    } else {
      placeholder.status = 'error';
      placeholder.content = '❌ ' + (promptOrError || '图片生成失败');
      placeholder.isImage = false;
    }

    // 重新渲染该消息
    var el = document.querySelector('.ac-msg[data-id="' + placeholder.id + '"]');
    if (el) {
      var content = el.querySelector('.ac-msg-content');
      if (content) {
        content.innerHTML = '';
        if (imageUrl) {
          var img = document.createElement('img');
          img.src = imageUrl;
          img.alt = promptOrError || '生成的图片';
          img.style.cssText = 'max-width:100%;border-radius:8px;cursor:pointer;';
          img.onclick = function () { window.open(imageUrl, '_blank'); };
          content.appendChild(img);
          if (promptOrError) {
            var caption = document.createElement('div');
            caption.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:6px;';
            caption.textContent = '🎨 ' + promptOrError;
            content.appendChild(caption);
          }
        } else {
          content.textContent = placeholder.content;
          content.classList.add('error');
        }
      }
    }
    scrollToBottom(true);
  }

  // ============ 分支 ============

  function openBranchModal() {
    if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
    renderBranchList();
    switchPanelTab('character');
    showPanel();
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
    ['acRoleModal', 'acRoleCreateModal', 'acRoleUrlModal', 'acWorldEditModal', 'acBranchModal',
      'acShareModal', 'acPromptModal', 'acModelModal', 'acTemplateModal', 'acPresetSaveModal', 'acContextModal']
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

  els.acNewGroup.addEventListener('click', function () {
    if (state.streaming) return;
    openGroupModal(null);
  });
  els.acGroupEdit.addEventListener('click', function () {
    if (state.currentConv && state.currentConv.is_group) openGroupModal(state.currentConv);
  });
  els.acGroupSave.addEventListener('click', saveGroup);

  els.acConvSearch.addEventListener('input', function () {
    // 浏览器自动填充用户名时也会触发 input 事件，但输入框不会获得焦点；此时清空，避免列表被过滤为空
    if (els.acConvSearch.value && document.activeElement !== els.acConvSearch) {
      els.acConvSearch.value = '';
    }
    state.convSearch = els.acConvSearch.value;
    renderConversations();
  });

  // 浏览器可能把用户名自动填充进搜索框（页面存在 password 输入），导致列表被过滤为空；加载后清空非用户输入的值
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (els.acConvSearch && els.acConvSearch.value && document.activeElement !== els.acConvSearch) {
        els.acConvSearch.value = '';
        state.convSearch = '';
        renderConversations();
      }
    }, 300);
  });

  els.acSend.addEventListener('click', send);
  els.acStop.addEventListener('click', stopStream);
  els.acInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 输入框自适应高度 + token 估算
  function autoResizeInput() {
    els.acInput.style.height = 'auto';
    els.acInput.style.height = Math.min(els.acInput.scrollHeight, 180) + 'px';
    updateTokenEstimate();
  }
  function updateTokenEstimate() {
    if (!els.acInputTokens) return;
    var text = els.acInput.value || '';
    if (!text.trim()) { els.acInputTokens.textContent = ''; return; }
    var tokens = estimateTokens(text);
    els.acInputTokens.textContent = '≈ ' + tokens + ' tokens';
    els.acInputTokens.classList.remove('warn', 'over');
    if (tokens > 4000) els.acInputTokens.classList.add('over');
    else if (tokens > 2000) els.acInputTokens.classList.add('warn');
  }
  // 粗略 token 估算（与服务端同算法：CJK ≈ 1 token/字，其他 ≈ 4 字符/token）
  function estimateTokens(text) {
    if (!text) return 0;
    var str = String(text);
    var cjk = (str.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    return Math.ceil(cjk + (str.length - cjk) / 4);
  }
  els.acInput.addEventListener('input', autoResizeInput);

  els.acRoleBtn.addEventListener('click', function () {
    if (state.currentConv && state.currentConv.is_group) openGroupModal(state.currentConv);
    else openRoleModal();
  });
  els.acModelBtn.addEventListener('click', openModelModal);
  els.acRoleCreate.addEventListener('click', function () { showModal('acRoleCreateModal'); });
  els.acRoleSave.addEventListener('click', createRole);

  els.acWorldAdd.addEventListener('click', function () { openWorldEdit(null); });
  els.acWorldImport.addEventListener('click', importDefaultWorldBook);
  if (els.acWorldFileImport) {
    els.acWorldFileImport.addEventListener('click', function () { if (els.acWorldFileInput) els.acWorldFileInput.click(); });
  }
  if (els.acWorldFileInput) {
    els.acWorldFileInput.addEventListener('change', function () {
      var f = els.acWorldFileInput.files && els.acWorldFileInput.files[0];
      els.acWorldFileInput.value = '';
      importWorldFile(f);
    });
  }
  els.acWorldSave.addEventListener('click', saveWorldEntry);
  els.acWorldDelete.addEventListener('click', deleteWorldEntry);
  if (els.acWorldPos) els.acWorldPos.addEventListener('change', updateWorldAdvancedVisibility);
  if (els.acWorldSelective) els.acWorldSelective.addEventListener('change', updateWorldAdvancedVisibility);

  els.acMemorySave.addEventListener('click', saveMemorySettings);
  els.acMemoryRefresh.addEventListener('click', refreshMemory);

  // 记忆补录
  if (els.acMemoryBackfill) els.acMemoryBackfill.addEventListener('click', openMemoryBackfill);
  if (els.acBackfillSummaries) els.acBackfillSummaries.addEventListener('click', function () { startMemoryBackfill(['summaries']); });
  if (els.acBackfillVectors) els.acBackfillVectors.addEventListener('click', function () { startMemoryBackfill(['vectors']); });
  if (els.acBackfillGroups) els.acBackfillGroups.addEventListener('click', function () { startMemoryBackfill(['groups']); });
  if (els.acBackfillAll) els.acBackfillAll.addEventListener('click', function () {
    var phases = ['summaries', 'groups'];
    if (state.backfillHasEmb) phases.splice(1, 0, 'vectors');
    startMemoryBackfill(phases);
  });
  if (els.acBackfillCancel) els.acBackfillCancel.addEventListener('click', cancelMemoryBackfill);

  // 对话压缩
  if (els.acCompressKeep) {
    els.acCompressKeep.addEventListener('input', function () {
      if (els.acCompressKeepVal) els.acCompressKeepVal.textContent = this.value;
      try { localStorage.setItem('ac_compress_keep', this.value); } catch (e) { /* ignore */ }
    });
    // 恢复设置
    try {
      var savedKeep = localStorage.getItem('ac_compress_keep');
      if (savedKeep) {
        els.acCompressKeep.value = savedKeep;
        if (els.acCompressKeepVal) els.acCompressKeepVal.textContent = savedKeep;
      }
      var autoCompress = localStorage.getItem('ac_auto_compress') === '1';
      if (els.acAutoCompress) els.acAutoCompress.checked = autoCompress;
    } catch (e) { /* ignore */ }
  }
  if (els.acAutoCompress) {
    els.acAutoCompress.addEventListener('change', function () {
      try { localStorage.setItem('ac_auto_compress', this.checked ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }
  if (els.acCompressNow) {
    els.acCompressNow.addEventListener('click', compressConversation);
  }

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

  // ============ 深色/浅色主题切换（持久化到 localStorage） ============
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    if (els.acThemeBtn) {
      els.acThemeBtn.innerHTML = theme === 'dark' ? '☀️ <span>日间</span>' : '🌙 <span>夜间</span>';
      els.acThemeBtn.title = theme === 'dark' ? '切换到浅色' : '切换到深色';
    }
    try { localStorage.setItem('ac_theme', theme); } catch (e) { /* 忽略存储失败 */ }
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('ac_theme'); } catch (e) { /* 忽略 */ }
    if (!saved) {
      saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    applyTheme(saved);
  }
  if (els.acThemeBtn) {
    els.acThemeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
  initTheme();

  // ============ 智能预测（推荐用户可能发送的下一条消息） ============
  var predictOn = false;
  var predictInFlight = false;

  function applyPredictAvailability() {
    // 管理员总开关关闭时，彻底隐藏按钮与建议区
    var allowed = !!(state.settings && state.settings.predictEnabled);
    if (els.acPredictBtn) els.acPredictBtn.style.display = allowed ? '' : 'none';
    if (!allowed) { clearSuggestions(); }
  }

  function applyPredict(on) {
    predictOn = !!on;
    if (els.acPredictBtn) {
      els.acPredictBtn.classList.toggle('active', predictOn);
      els.acPredictBtn.title = predictOn ? '智能预测：已开启（点击关闭）' : '智能预测：已关闭（点击开启）';
    }
    try { localStorage.setItem('ac_predict_on', predictOn ? '1' : '0'); } catch (e) { /* 忽略存储失败 */ }
    if (!predictOn) clearSuggestions();
  }

  function initPredict() {
    var saved = null;
    try { saved = localStorage.getItem('ac_predict_on'); } catch (e) { /* 忽略 */ }
    applyPredict(saved === '1'); // 默认关闭，由用户主动开启
  }

  function clearSuggestions() {
    if (els.acSuggestions) { els.acSuggestions.innerHTML = ''; els.acSuggestions.hidden = true; }
  }

  function renderSuggestions(list) {
    if (!els.acSuggestions) return;
    els.acSuggestions.innerHTML = '';
    if (!list || !list.length) { els.acSuggestions.hidden = true; return; }
    var label = document.createElement('span');
    label.className = 'ac-suggestions-label';
    label.textContent = '💡 你可能想说';
    els.acSuggestions.appendChild(label);
    list.forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ac-suggestion-chip';
      chip.textContent = text;
      chip.title = '点击填入输入框';
      chip.addEventListener('click', function () {
        els.acInput.value = text;
        clearSuggestions();
        els.acInput.focus();
        updateTokenEstimate();
        autoResizeInput();
      });
      els.acSuggestions.appendChild(chip);
    });
    els.acSuggestions.hidden = false;
  }

  function fetchPredictions() {
    if (!predictOn || predictInFlight) return;
    if (state.streaming || !state.currentConv) return;
    if (state.settings && !state.settings.predictEnabled) return;
    if (state.quota && !state.quotaUnlimited && !convUsesOwnModel(state.currentConv) && state.quota.remaining <= 0) return;
    var convId = state.currentConv.id;
    predictInFlight = true;
    if (els.acPredictBtn) els.acPredictBtn.classList.add('loading');
    api('/ai-chat/api/predict', { conversation_id: convId })
      .then(function (json) {
        // 期间用户可能已切换会话，丢弃过期结果
        if (!state.currentConv || state.currentConv.id !== convId) return;
        if (json && json.success) renderSuggestions(json.suggestions || []);
      })
      .catch(function () { /* 静默失败，不打扰对话 */ })
      .then(function () {
        predictInFlight = false;
        if (els.acPredictBtn) els.acPredictBtn.classList.remove('loading');
      });
  }

  if (els.acPredictBtn) {
    els.acPredictBtn.addEventListener('click', function () {
      applyPredict(!predictOn);
      if (predictOn) fetchPredictions();
    });
  }
  initPredict();

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
        els.acTtsToggle.classList.add('active');
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

  // ============ 右侧设置面板 ============

  function showPanel() {
    if (els.acPanel) els.acPanel.classList.remove('collapsed');
    if (els.acPanelToggle) els.acPanelToggle.classList.add('active');
  }
  function hidePanel() {
    if (els.acPanel) els.acPanel.classList.add('collapsed');
    if (els.acPanelToggle) els.acPanelToggle.classList.remove('active');
  }
  function switchPanelTab(name) {
    document.querySelectorAll('.ac-panel-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-panel') === name);
    });
    document.querySelectorAll('.ac-panel-page').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    if (name === 'worldbook') renderWorldList();
    if (name === 'character') renderPanelBranches();
  }

  if (els.acPanelToggle) {
    els.acPanelToggle.addEventListener('click', function () {
      if (els.acPanel.classList.contains('collapsed')) { showPanel(); } else { hidePanel(); }
    });
  }
  document.querySelectorAll('.ac-panel-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { switchPanelTab(tab.getAttribute('data-panel')); });
  });

  // 面板默认折叠（移动端）
  if (window.innerWidth <= 820) hidePanel();

  function populatePanel() {
    var conv = state.currentConv;
    if (!conv) return;
    // 角色信息
    var role = conv.role_id ? state.roles.filter(function (r) { return r.id === conv.role_id; })[0] : null;
    if (els.acPanelRoleName) els.acPanelRoleName.textContent = role ? role.name : '未选择角色';
    if (els.acPanelRoleDesc) els.acPanelRoleDesc.textContent = role ? (role.description || role.system_prompt || '').slice(0, 80) : '选择角色开始对话';
    if (els.acPanelRoleAvatar) {
      if (role && role.avatar) {
        els.acPanelRoleAvatar.innerHTML = '<img src="' + escapeHtml(role.avatar) + '" alt="">';
      } else {
        els.acPanelRoleAvatar.textContent = '🎭';
      }
    }
    // 生成参数
    setSlider('acGenTemp', 'acGenTempVal', conv.gen_temperature != null ? conv.gen_temperature : 0.7);
    setSlider('acGenTopP', 'acGenTopPVal', conv.gen_top_p != null ? conv.gen_top_p : 1);
    setSlider('acGenTopK', 'acGenTopKVal', conv.gen_top_k != null ? conv.gen_top_k : 0);
    setSlider('acGenFreq', 'acGenFreqVal', conv.gen_frequency_penalty != null ? conv.gen_frequency_penalty : 0);
    setSlider('acGenPres', 'acGenPresVal', conv.gen_presence_penalty != null ? conv.gen_presence_penalty : 0);
    setSlider('acGenMax', 'acGenMaxVal', conv.gen_max_tokens != null ? conv.gen_max_tokens : 4096);
    // 作者注释
    if (els.acAuthorNote) els.acAuthorNote.value = conv.author_note || '';
    setSlider('acAuthorNoteDepth', 'acAuthorNoteDepthVal', conv.author_note_depth != null ? conv.author_note_depth : 4);
    // 模板
    if (els.acPromptTemplate) els.acPromptTemplate.value = conv.prompt_template_id || '';
    // 记忆
    if (els.acMemoryEnabled) els.acMemoryEnabled.checked = conv.memory_enabled !== 0;
    if (els.acRagEnabled) els.acRagEnabled.checked = conv.rag_enabled !== 0;
    if (els.acMemoryMode) els.acMemoryMode.value = conv.memory_mode || 'summary';
    // 分支
    renderPanelBranches();
    // 世界书
    renderWorldList();
  }

  function setSlider(inputId, valId, value) {
    if (els[inputId]) els[inputId].value = value;
    if (els[valId]) els[valId].textContent = value;
  }

  function renderPanelBranches() {
    if (!els.acPanelBranchList || !state.currentConv) return;
    els.acPanelBranchList.innerHTML = '';
    var main = document.createElement('div');
    main.className = 'ac-branch-item' + ((state.currentConv.current_branch_id || 0) === 0 ? ' active' : '');
    main.innerHTML = '<span class="ac-branch-name">主分支</span>';
    main.addEventListener('click', function () { switchBranch(0); });
    els.acPanelBranchList.appendChild(main);
    state.branches.forEach(function (b) {
      var item = document.createElement('div');
      item.className = 'ac-branch-item' + (state.currentConv.current_branch_id === b.id ? ' active' : '');
      item.innerHTML = '<span class="ac-branch-name">' + escapeHtml(b.name) + '（#' + b.id + '）</span>';
      item.addEventListener('click', function () { switchBranch(b.id); });
      els.acPanelBranchList.appendChild(item);
    });
  }

  if (els.acPanelRoleSwitch) {
    els.acPanelRoleSwitch.addEventListener('click', openRoleModal);
  }

  // ============ 生成参数滑块 ============

  var genSliders = [
    ['acGenTemp', 'acGenTempVal'], ['acGenTopP', 'acGenTopPVal'], ['acGenTopK', 'acGenTopKVal'],
    ['acGenFreq', 'acGenFreqVal'], ['acGenPres', 'acGenPresVal'], ['acGenMax', 'acGenMaxVal'],
    ['acAuthorNoteDepth', 'acAuthorNoteDepthVal']
  ];
  genSliders.forEach(function (pair) {
    if (els[pair[0]]) {
      els[pair[0]].addEventListener('input', function () {
        if (els[pair[1]]) els[pair[1]].textContent = els[pair[0]].value;
      });
    }
  });

  if (els.acGenSave) {
    els.acGenSave.addEventListener('click', function () {
      if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
      api('/ai-chat/api/conversations/gen-settings', {
        conversation_id: state.currentConv.id,
        gen_temperature: parseFloat(els.acGenTemp.value),
        gen_top_p: parseFloat(els.acGenTopP.value),
        gen_top_k: parseInt(els.acGenTopK.value, 10),
        gen_frequency_penalty: parseFloat(els.acGenFreq.value),
        gen_presence_penalty: parseFloat(els.acGenPres.value),
        gen_max_tokens: parseInt(els.acGenMax.value, 10),
        author_note: els.acAuthorNote ? els.acAuthorNote.value : '',
        author_note_depth: parseInt(els.acAuthorNoteDepth.value, 10),
        prompt_template_id: els.acPromptTemplate ? (parseInt(els.acPromptTemplate.value, 10) || null) : null
      }).then(function () {
        var conv = state.currentConv;
        conv.gen_temperature = parseFloat(els.acGenTemp.value);
        conv.gen_top_p = parseFloat(els.acGenTopP.value);
        conv.gen_top_k = parseInt(els.acGenTopK.value, 10);
        conv.gen_frequency_penalty = parseFloat(els.acGenFreq.value);
        conv.gen_presence_penalty = parseFloat(els.acGenPres.value);
        conv.gen_max_tokens = parseInt(els.acGenMax.value, 10);
        conv.author_note = els.acAuthorNote ? els.acAuthorNote.value : '';
        conv.author_note_depth = parseInt(els.acAuthorNoteDepth.value, 10);
        conv.prompt_template_id = els.acPromptTemplate ? (parseInt(els.acPromptTemplate.value, 10) || null) : null;
        showToast('参数已保存到会话', 'success');
      }).catch(function (err) { showToast(err.message, 'error'); });
    });
  }

  // ============ 预设管理 ============

  function renderPresetSelect() {
    if (!els.acPresetSelect) return;
    var cur = els.acPresetSelect.value;
    els.acPresetSelect.innerHTML = '<option value="">自定义</option>';
    state.presets.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.is_global ? '🌐 ' : '') + p.name + (p.is_default ? ' ★' : '');
      els.acPresetSelect.appendChild(opt);
    });
    if (cur) els.acPresetSelect.value = cur;
  }

  if (els.acPresetSelect) {
    els.acPresetSelect.addEventListener('change', function () {
      var id = parseInt(els.acPresetSelect.value, 10);
      if (!id) return;
      var p = state.presets.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      setSlider('acGenTemp', 'acGenTempVal', p.temperature);
      setSlider('acGenTopP', 'acGenTopPVal', p.top_p);
      setSlider('acGenTopK', 'acGenTopKVal', p.top_k);
      setSlider('acGenFreq', 'acGenFreqVal', p.frequency_penalty);
      setSlider('acGenPres', 'acGenPresVal', p.presence_penalty);
      setSlider('acGenMax', 'acGenMaxVal', p.max_tokens);
      showToast('已加载预设：' + p.name, 'success');
    });
  }
  if (els.acPresetSave) {
    els.acPresetSave.addEventListener('click', function () {
      if (els.acPresetName) els.acPresetName.value = '';
      if (els.acPresetDefault) els.acPresetDefault.checked = false;
      showModal('acPresetSaveModal');
    });
  }
  if (els.acPresetSaveConfirm) {
    els.acPresetSaveConfirm.addEventListener('click', function () {
      var name = (els.acPresetName.value || '').trim();
      if (!name) { showToast('请输入预设名称', 'error'); return; }
      api('/ai-chat/api/presets', {
        name: name,
        temperature: parseFloat(els.acGenTemp.value),
        top_p: parseFloat(els.acGenTopP.value),
        top_k: parseInt(els.acGenTopK.value, 10),
        frequency_penalty: parseFloat(els.acGenFreq.value),
        presence_penalty: parseFloat(els.acGenPres.value),
        max_tokens: parseInt(els.acGenMax.value, 10),
        is_default: els.acPresetDefault.checked ? 1 : 0
      }).then(function () {
        hideModal('acPresetSaveModal');
        showToast('预设已保存', 'success');
        return fetch('/ai-chat/api/presets', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(function (r) { return r.json(); });
      }).then(function (json) {
        if (json.success) { state.presets = json.data || []; renderPresetSelect(); }
      }).catch(function (err) { showToast(err.message, 'error'); });
    });
  }
  if (els.acPresetDelete) {
    els.acPresetDelete.addEventListener('click', function () {
      var id = parseInt(els.acPresetSelect.value, 10);
      if (!id) { showToast('请先选择一个预设', 'error'); return; }
      if (!window.confirm('删除该预设？')) return;
      api('/ai-chat/api/presets/delete', { id: id }).then(function () {
        showToast('预设已删除', 'success');
        state.presets = state.presets.filter(function (p) { return p.id !== id; });
        renderPresetSelect();
      }).catch(function (err) { showToast(err.message, 'error'); });
    });
  }

  // ============ 提示词模板管理 ============

  function renderPromptTemplateSelect() {
    if (!els.acPromptTemplate) return;
    var cur = els.acPromptTemplate.value;
    els.acPromptTemplate.innerHTML = '<option value="">无模板</option>';
    state.promptTemplates.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.is_global ? '🌐 ' : '') + t.name;
      els.acPromptTemplate.appendChild(opt);
    });
    if (cur) els.acPromptTemplate.value = cur;
  }

  function renderTemplateList() {
    if (!els.acTemplateList) return;
    els.acTemplateList.innerHTML = '';
    if (!state.promptTemplates.length) {
      els.acTemplateList.innerHTML = '<p style="font-size:12px;color:var(--text-muted);">暂无模板</p>';
      return;
    }
    state.promptTemplates.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'ac-prompt-item';
      item.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = '<div class="ac-prompt-item-title">' + escapeHtml(t.name) + (t.is_global ? ' 🌐' : '') + '</div>' +
        '<div class="ac-prompt-item-excerpt">' + escapeHtml((t.content || '').slice(0, 100)) + '</div>';
      item.appendChild(info);
      if (!t.is_global) {
        var del = document.createElement('button');
        del.className = 'ac-btn ac-btn-danger ac-btn-sm';
        del.textContent = '删除';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!window.confirm('删除模板「' + t.name + '」？')) return;
          api('/ai-chat/api/prompt-templates/delete', { id: t.id }).then(function () {
            state.promptTemplates = state.promptTemplates.filter(function (x) { return x.id !== t.id; });
            renderTemplateList();
            renderPromptTemplateSelect();
            showToast('已删除', 'success');
          }).catch(function (err) { showToast(err.message, 'error'); });
        });
        item.appendChild(del);
      }
      els.acTemplateList.appendChild(item);
    });
  }

  if (els.acPromptTemplateManage) {
    els.acPromptTemplateManage.addEventListener('click', function () {
      renderTemplateList();
      showModal('acTemplateModal');
    });
  }
  if (els.acTemplateSave) {
    els.acTemplateSave.addEventListener('click', function () {
      var name = (els.acTemplateName.value || '').trim();
      var content = (els.acTemplateContent.value || '').trim();
      if (!name || !content) { showToast('请填写名称和内容', 'error'); return; }
      api('/ai-chat/api/prompt-templates', { name: name, content: content }).then(function () {
        els.acTemplateName.value = '';
        els.acTemplateContent.value = '';
        showToast('模板已保存', 'success');
        return fetch('/ai-chat/api/prompt-templates', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(function (r) { return r.json(); });
      }).then(function (json) {
        if (json.success) { state.promptTemplates = json.data || []; renderTemplateList(); renderPromptTemplateSelect(); }
      }).catch(function (err) { showToast(err.message, 'error'); });
    });
  }

  // ============ 上下文预览 ============

  if (els.acContextPreview) {
    els.acContextPreview.addEventListener('click', function () {
      if (!state.currentConv) { showToast('请先创建会话', 'error'); return; }
      els.acContextInfo.textContent = '加载中…';
      els.acContextMessages.innerHTML = '';
      showModal('acContextModal');
      fetch('/ai-chat/api/conversations/' + state.currentConv.id + '/context-preview', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          if (!json.success) throw new Error(json.error || '加载失败');
          var d = json.data;
          els.acContextInfo.textContent = '共 ' + (d.messages || []).length + ' 条消息 · 估算 ' + (d.totalTokens || 0) + ' tokens';
          els.acContextMessages.innerHTML = '';
          (d.messages || []).forEach(function (m) {
            var div = document.createElement('div');
            div.className = 'ac-context-msg ' + (m.role || 'system');
            div.innerHTML = '<div class="ac-context-msg-role">' + escapeHtml(m.role || 'system') + '</div>' +
              '<div class="ac-context-msg-content">' + escapeHtml(m.content || '') + '</div>';
            els.acContextMessages.appendChild(div);
          });
        })
        .catch(function (err) { els.acContextInfo.textContent = err.message; });
    });
  }

  // ============ 继续生成 / 模仿用户 ============

  if (els.acContinueBtn) {
    els.acContinueBtn.addEventListener('click', function () {
      if (!state.currentConv || state.streaming) return;
      var lastAssistant = null;
      for (var i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'assistant') { lastAssistant = state.messages[i]; break; }
      }
      if (!lastAssistant) { showToast('没有可继续的 AI 消息', 'error'); return; }
      var placeholder = { id: lastAssistant.id, role: 'assistant', content: lastAssistant.content || '', status: 'streaming', branch_id: lastAssistant.branch_id || 0 };
      startStream('/ai-chat/api/messages/continue', { conversation_id: state.currentConv.id }, placeholder);
    });
  }
  if (els.acImpersonateBtn) {
    els.acImpersonateBtn.addEventListener('click', function () {
      if (!state.currentConv || state.streaming) return;
      var placeholder = { id: 'imp' + Date.now(), role: 'user', content: '', status: 'streaming', branch_id: state.currentConv.current_branch_id || 0 };
      state.messages.push(placeholder);
      appendMessageEl(placeholder, true);
      scrollToBottom(true);
      startStream('/ai-chat/api/messages/impersonate', { conversation_id: state.currentConv.id }, placeholder);
    });
  }

  // 压缩对话按钮（工具栏）
  var acCompressBtn = document.getElementById('acCompressBtn');
  if (acCompressBtn) {
    acCompressBtn.addEventListener('click', compressConversation);
  }

  // 生成场景图片按钮（工具栏）
  if (els.acImageGenBtn) {
    els.acImageGenBtn.addEventListener('click', generateSceneImage);
  }

  // 初始化 TTS
  initTts();

  // 初始化
  loadBootstrap().catch(function (err) {
    showToast(err.message, 'error');
  });
})();
