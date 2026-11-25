/**
 * /ai-canvas 独立画布通道引导脚本
 *
 * 职责：
 *  1. 为画布引擎提供与基础页对齐的生成能力（/ai-canvas/api/*，支持多参考图、自定义宽高）；
 *  2. 服务端项目：切换 / 新建 / 分享 / 成员；
 *  3. 灯箱与简单提示。
 *
 * 引擎（ai-image-canvas.js）通过 window.AI_CANVAS_CONFIG 接入，页面内联脚本先注入静态配置，
 * 本文件负责运行期逻辑，二者都不依赖 /ai-image 的脚本。
 */
(function () {
  'use strict';

  var API = '/ai-canvas/api';
  var pageData = {};
  var dataEl = document.getElementById('ai-canvas-data');
  try {
    pageData = JSON.parse((dataEl && dataEl.textContent) || '{}');
  } catch (err) {
    pageData = {};
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
  }

  function request(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    var token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (json) {
        return { ok: resp.ok, status: resp.status, json: json };
      });
    });
  }

  function toast(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type || 'info');
      return;
    }
    var el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;'
      + 'background:rgba(17,24,39,.92);color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  // ============ 生成适配：与基础页同一套任务模型 ============
  window.aiImageGenerate = function (params) {
    params = params || {};
    var startedAt = Date.now();
    var taskId = '';
    var pollTimer = null;
    var settled = false;
    var resolvePromise;
    var rejectPromise;
    var promise = new Promise(function (resolve, reject) {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    function fail(error) {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      rejectPromise(error instanceof Error ? error : new Error(error || '生成失败'));
    }

    function poll() {
      if (!taskId || settled) return;
      request('/status?task=' + encodeURIComponent(taskId)).then(function (res) {
        if (settled) return;
        var json = res.json || {};
        if (!json.success) return fail(json.error || '状态查询失败');
        var state = json.data || {};
        if (state.status === 'success') {
          settled = true;
          resolvePromise(state.result || { images: [] });
          return;
        }
        if (state.status === 'cancelled') return fail('任务已取消');
        if (state.status === 'failed') {
          return fail((state.result && state.result.error) || state.message || '生成失败');
        }
        if (Date.now() - startedAt > 12 * 60 * 1000) {
          return fail('生成等待超时，请到历史记录查看结果');
        }
        pollTimer = setTimeout(poll, 2000);
      }).catch(function () {
        if (!settled) pollTimer = setTimeout(poll, 3000);
      });
    }

    var form = new FormData();
    form.append('prompt', params.prompt || '');
    form.append('provider', params.provider || '');
    form.append('model', params.model || '');
    form.append('size', params.size || '1024x1024');
    form.append('n', String(params.n || 1));
    if (params.seed !== undefined && params.seed !== null && params.seed !== '') {
      form.append('seed', String(params.seed));
    }
    form.append('style', params.style || '');
    form.append('negative_prompt', params.negativePrompt || '');
    var files = params.referenceFiles || (params.referenceFile ? [params.referenceFile] : []);
    files.forEach(function (file, index) {
      form.append('references', file, file.name || ('reference-' + index + '.png'));
    });

    request('/generate', { method: 'POST', body: form }).then(function (res) {
      var json = res.json || {};
      if (!res.ok || !json.success) return fail(json.error || '生成失败');
      taskId = json.taskId;
      if (json.referencesUsed && files.length > json.referencesUsed) {
        toast('服务商仅使用 ' + json.referencesUsed + ' 张参考图', 'info');
      }
      poll();
    }).catch(function (err) {
      fail(err && err.message ? err.message : '生成请求失败');
    });

    promise.cancel = function () {
      if (!taskId || settled) return Promise.resolve();
      return request('/cancel', { method: 'POST', body: { task: taskId } }).catch(function () { /* 忽略 */ });
    };
    return promise;
  };

  // ============ 提示词优化（与基础页共用后台 LLM 配置） ============
  window.aiImageEnhancePrompt = function (prompt) {
    return request('/enhance-prompt', { method: 'POST', body: { prompt: prompt } }).then(function (res) {
      if (!res.ok || !res.json.success) throw new Error((res.json && res.json.error) || '优化失败');
      return res.json.enhanced || '';
    });
  };

  // ============ 灯箱 ============
  window.aiImageOpenLightbox = function (url, info) {
    if (!url) return;
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.85);'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;';
    var img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'max-width:92vw;max-height:88vh;border-radius:8px;box-shadow:0 10px 50px rgba(0,0,0,.6);';
    var meta = document.createElement('div');
    meta.textContent = [info && info.provider, info && info.model, info && info.size].filter(Boolean).join(' · ');
    meta.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);color:#cbd5e1;font-size:12px;';
    mask.appendChild(img);
    mask.appendChild(meta);
    mask.addEventListener('click', function () { mask.remove(); });
    document.body.appendChild(mask);
  };

  window.aiImageSetMode = function () {
    window.location.href = '/ai-image';
  };

  // ============ 项目切换 / 分享 / 成员 ============
  function bindProjectUI() {
    var select = document.getElementById('canvasProjectSelect');
    var createBtn = document.getElementById('canvasNewProject');
    var shareBtn = document.getElementById('canvasShare');
    var memberBtn = document.getElementById('canvasMembers');
    var keysBtn = document.getElementById('canvasKeys');
    var historyBtn = document.getElementById('canvasHistory');
    var info = document.getElementById('canvasShareInfo');
    var current = window.__AI_CANVAS_PROJECT__ || null;
    var canEdit = !current || current.role !== 'viewer';

    if (keysBtn) {
      keysBtn.addEventListener('click', function () { openKeysDialog(); });
    }
    if (historyBtn) {
      historyBtn.addEventListener('click', function () { openHistoryDialog(); });
    }
    if (select) {
      select.addEventListener('change', function () {
        var id = select.value;
        if (id) window.location.href = '/ai-canvas?project=' + encodeURIComponent(id);
      });
    }
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var name = window.prompt('新画布名称', '未命名画布');
        if (name === null) return;
        request('/projects', { method: 'POST', body: { name: name || '未命名画布' } }).then(function (res) {
          if (res.ok && res.json.success) {
            window.location.href = '/ai-canvas?project=' + res.json.data.id;
          } else {
            toast((res.json && res.json.error) || '新建失败', 'error');
          }
        });
      });
    }
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        if (!current) return toast('画布尚未保存', 'error');
        if (!canEdit) return toast('只读成员不能分享', 'error');
        var enable = window.confirm('开启分享后，任何登录用户都能通过链接以只读方式加入。\n点击“确定”开启，点击“取消”关闭分享。');
        request('/projects/' + current.id + '/share', { method: 'POST', body: { enabled: enable ? '1' : '0' } })
          .then(function (res) {
            if (!res.ok || !res.json.success) return toast((res.json && res.json.error) || '操作失败', 'error');
            var token = res.json.shareToken || '';
            if (token && info) info.textContent = location.origin + '/ai-canvas?share=' + token;
            toast(enable ? '已开启分享（只读加入）' : '已关闭分享', 'success');
          });
      });
    }
    if (memberBtn) {
      memberBtn.addEventListener('click', function () {
        if (!current) return toast('画布尚未保存', 'error');
        if (!canEdit) return toast('只读成员不能邀请', 'error');
        openCollabDialog(current.id);
      });
    }
    if (!canEdit) toast('你是只读成员，画布改动不会被保存', 'info');
  }

  function openCollabDialog(projectId) {
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9997;background:rgba(15,23,42,.6);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'width:420px;max-width:94vw;max-height:80vh;overflow:auto;background:#fff;'
      + 'border-radius:12px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-size:13px;';
    box.innerHTML = '<h3 style="margin:0 0 10px;font-size:15px;">协作成员</h3>'
      + '<div id="canvasMemberList" style="margin-bottom:12px;color:#475569;">加载中…</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<input id="canvasMemberName" placeholder="用户名" style="flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;">'
      + '<select id="canvasMemberRole" style="padding:6px;border:1px solid #cbd5e1;border-radius:6px;">'
      + '<option value="editor">可编辑</option><option value="viewer">只读</option></select>'
      + '<button id="canvasMemberAdd" type="button" style="padding:6px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;">邀请</button>'
      + '</div>'
      + '<div style="margin-top:12px;text-align:right;"><button id="canvasMemberClose" type="button" '
      + 'style="padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">关闭</button></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    mask.addEventListener('click', function (event) { if (event.target === mask) mask.remove(); });
    box.querySelector('#canvasMemberClose').addEventListener('click', function () { mask.remove(); });

    function render() {
      request('/projects/' + projectId + '/members').then(function (res) {
        var list = (res.json && res.json.data) || [];
        var el = box.querySelector('#canvasMemberList');
        el.textContent = '';
        list.forEach(function (member) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eef2f7;';
          row.innerHTML = '<span>' + member.username + '</span><span style="color:#64748b;">'
            + (member.role === 'owner' ? '创建者' : member.role === 'viewer' ? '只读' : '可编辑') + '</span>';
          el.appendChild(row);
        });
        if (!list.length) el.textContent = '暂无成员';
      });
    }
    render();

    box.querySelector('#canvasMemberAdd').addEventListener('click', function () {
      var username = box.querySelector('#canvasMemberName').value.trim();
      var role = box.querySelector('#canvasMemberRole').value;
      if (!username) return toast('请输入用户名', 'warning');
      request('/projects/' + projectId + '/members', { method: 'POST', body: { username: username, role: role } })
        .then(function (res) {
          if (!res.ok || !res.json.success) return toast((res.json && res.json.error) || '邀请失败', 'error');
          toast(res.json.message || '已邀请', 'success');
          box.querySelector('#canvasMemberName').value = '';
          render();
        });
    });
  }

  // ============ API 密钥 / 余额 ============
  // 画布内直接管理各服务商 Key：保存（含模型同步）、查询余额、清除；只显示状态，不回显明文。
  function openKeysDialog() {
    var providers = (pageData.providers || []).filter(function (p) { return p.requires_key; });
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9997;background:rgba(15,23,42,.6);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'width:620px;max-width:96vw;max-height:84vh;overflow:auto;background:#fff;'
      + 'border-radius:12px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-size:13px;color:#1f2937;';
    var title = document.createElement('h3');
    title.textContent = 'API 密钥与余额';
    title.style.cssText = 'margin:0 0 4px;font-size:15px;';
    var tip = document.createElement('div');
    tip.textContent = 'Key 加密保存；查询余额使用你自己的 Key（未填则用后台全局 Key）。';
    tip.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:12px;';
    box.appendChild(title);
    box.appendChild(tip);

    var list = document.createElement('div');
    box.appendChild(list);

    if (!providers.length) {
      var empty = document.createElement('div');
      empty.textContent = '当前没有需要 Key 的服务商';
      empty.style.cssText = 'color:#64748b;padding:10px 0;';
      box.appendChild(empty);
    }

    providers.forEach(function (provider) {
      var row = document.createElement('div');
      row.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-bottom:10px;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
      var name = document.createElement('div');
      name.textContent = provider.name || provider.provider_key;
      name.style.cssText = 'font-weight:600;';
      var state = document.createElement('span');
      state.style.cssText = 'font-size:11px;color:#64748b;';
      function renderState() {
        state.textContent = provider.has_user_key ? '已配置我的 Key'
          : (provider.has_global_key ? '使用后台全局 Key' : '未配置');
        state.style.color = provider.has_user_key || provider.has_global_key ? '#059669' : '#dc2626';
      }
      renderState();
      head.appendChild(name);
      head.appendChild(state);
      row.appendChild(head);

      var inputRow = document.createElement('div');
      inputRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      var input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.placeholder = provider.has_user_key ? '•••••••• 已保存，留空不修改' : '粘贴 API Key';
      input.style.cssText = 'flex:1;min-width:160px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;';
      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';
      saveBtn.style.cssText = 'padding:6px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;';
      var balanceBtn = document.createElement('button');
      balanceBtn.type = 'button';
      balanceBtn.textContent = '查余额';
      balanceBtn.style.cssText = 'padding:6px 12px;border:0;border-radius:6px;background:#059669;color:#fff;cursor:pointer;';
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = '清除';
      clearBtn.style.cssText = 'padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;';
      inputRow.appendChild(input);
      inputRow.appendChild(saveBtn);
      inputRow.appendChild(balanceBtn);
      inputRow.appendChild(clearBtn);
      row.appendChild(inputRow);

      var msg = document.createElement('div');
      msg.style.cssText = 'margin-top:6px;font-size:11px;color:#64748b;min-height:15px;';
      row.appendChild(msg);

      saveBtn.addEventListener('click', function () {
        var key = (input.value || '').trim();
        if (!key) return toast('请先填写 API Key', 'warning');
        saveBtn.disabled = true;
        msg.textContent = '保存并验证中…';
        request('/keys/save', { method: 'POST', body: { provider_key: provider.provider_key, api_key: key } })
          .then(function (res) {
            saveBtn.disabled = false;
            var json = res.json || {};
            if (!res.ok || !json.success) {
              msg.textContent = json.error || '保存失败';
              return;
            }
            input.value = '';
            provider.has_user_key = true;
            renderState();
            var parts = [];
            if (json.verified) parts.push('Key 验证通过');
            if (json.models && json.models.length) {
              parts.push('同步 ' + json.models.length + ' 个模型');
              provider.models = json.models.slice();
              provider.default_model = json.default_model || provider.default_model;
              var canvas = window.aiImageInitCanvas && window.aiImageInitCanvas();
              if (canvas && typeof canvas.syncProviders === 'function') {
                canvas.syncProviders(provider.provider_key, provider.models, provider.default_model);
              }
            }
            if (json.balance && json.balance.label) parts.push('余额 ' + json.balance.label);
            else if (json.balanceError) parts.push('余额：' + json.balanceError);
            msg.textContent = parts.join('；') || '已保存';
            toast('Key 已保存', 'success');
          })
          .catch(function () {
            saveBtn.disabled = false;
            msg.textContent = '保存请求失败';
          });
      });

      balanceBtn.addEventListener('click', function () {
        balanceBtn.disabled = true;
        msg.textContent = '查询余额中…';
        request('/keys/balance', { method: 'POST', body: { provider_key: provider.provider_key } })
          .then(function (res) {
            balanceBtn.disabled = false;
            var json = res.json || {};
            if (json.success && json.balance) {
              msg.textContent = '余额：' + (json.balance.label || json.balance.amount);
              msg.style.color = '#059669';
            } else {
              msg.textContent = json.error || '未获取到余额（该服务商可能未开放余额接口）';
              msg.style.color = '#dc2626';
            }
          })
          .catch(function () {
            balanceBtn.disabled = false;
            msg.textContent = '余额查询请求失败';
          });
      });

      clearBtn.addEventListener('click', function () {
        if (!window.confirm('确定清除「' + (provider.name || provider.provider_key) + '」的 API Key？')) return;
        request('/keys/delete', { method: 'POST', body: { provider_key: provider.provider_key } })
          .then(function (res) {
            if (!res.ok || !res.json.success) return toast((res.json && res.json.error) || '清除失败', 'error');
            provider.has_user_key = false;
            renderState();
            msg.style.color = '#64748b';
            msg.textContent = '已清除我的 Key';
          });
      });

      list.appendChild(row);
    });

    var foot = document.createElement('div');
    foot.style.cssText = 'text-align:right;margin-top:6px;';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = 'padding:6px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;';
    close.addEventListener('click', function () { mask.remove(); });
    foot.appendChild(close);
    box.appendChild(foot);

    mask.appendChild(box);
    document.body.appendChild(mask);
    mask.addEventListener('click', function (event) { if (event.target === mask) mask.remove(); });
  }

  // ============ 生成历史 ============
  // 画布不重复存历史：直接读 /ai-canvas/api/history（与基础页同一张 ai_image_records），
  // 支持插入画布、复制提示词、看大图。
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('提示词已复制', 'success');
      }, function () {
        toast('复制失败，请手动选择文本', 'error');
      });
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('提示词已复制', 'success'); }
    catch (err) { toast('复制失败，请手动选择文本', 'error'); }
    area.remove();
  }

  function openHistoryDialog() {
    var page = 1;
    var pageSize = 9;
    var total = 0;

    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9997;background:rgba(15,23,42,.6);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'width:760px;max-width:96vw;max-height:86vh;overflow:auto;background:#fff;'
      + 'border-radius:12px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-size:13px;color:#1f2937;';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
    var title = document.createElement('h3');
    title.textContent = '生成历史';
    title.style.cssText = 'margin:0;font-size:15px;';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = 'padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;';
    close.addEventListener('click', function () { mask.remove(); });
    head.appendChild(title);
    head.appendChild(close);
    box.appendChild(head);

    var tip = document.createElement('div');
    tip.textContent = '历史与基础生图页共用；可把任意结果直接插回当前画布。';
    tip.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:12px;';
    box.appendChild(tip);

    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;';
    box.appendChild(grid);

    var pager = document.createElement('div');
    pager.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:14px;';
    var prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '上一页';
    prev.style.cssText = 'padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;';
    var pageInfo = document.createElement('span');
    pageInfo.style.cssText = 'font-size:12px;color:#475569;';
    var next = document.createElement('button');
    next.type = 'button';
    next.textContent = '下一页';
    next.style.cssText = 'padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;';
    pager.appendChild(prev);
    pager.appendChild(pageInfo);
    pager.appendChild(next);
    box.appendChild(pager);

    mask.appendChild(box);
    document.body.appendChild(mask);
    mask.addEventListener('click', function (event) { if (event.target === mask) mask.remove(); });

    function canvasInstance() {
      return window.aiImageInitCanvas ? window.aiImageInitCanvas() : null;
    }

    function renderCard(record) {
      var card = document.createElement('div');
      card.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#f8fafc;';

      var thumbWrap = document.createElement('div');
      thumbWrap.style.cssText = 'height:110px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;overflow:hidden;';
      if (record.image_path) {
        var img = document.createElement('img');
        img.src = record.image_path;
        img.loading = 'lazy';
        img.alt = record.prompt || '';
        img.style.cssText = 'width:100%;height:110px;object-fit:cover;cursor:zoom-in;';
        img.addEventListener('click', function () {
          window.aiImageOpenLightbox(record.image_path, {
            prompt: record.prompt, provider: record.provider, model: record.model, size: record.size
          });
        });
        thumbWrap.appendChild(img);
      } else {
        var fail = document.createElement('span');
        fail.textContent = record.status === 'failed' ? '生成失败' : '无图片';
        fail.style.cssText = 'font-size:11px;color:#dc2626;';
        thumbWrap.appendChild(fail);
      }
      card.appendChild(thumbWrap);

      var body = document.createElement('div');
      body.style.cssText = 'padding:8px;';
      var promptEl = document.createElement('div');
      promptEl.textContent = record.prompt || '';
      promptEl.title = record.prompt || '';
      promptEl.style.cssText = 'font-size:11px;color:#334155;line-height:1.4;height:31px;overflow:hidden;';
      body.appendChild(promptEl);

      var meta = document.createElement('div');
      meta.textContent = [record.provider, record.model, record.size].filter(Boolean).join(' · ');
      meta.style.cssText = 'font-size:10px;color:#94a3b8;margin:3px 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      body.appendChild(meta);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:4px;';
      var insert = document.createElement('button');
      insert.type = 'button';
      insert.textContent = '插入画布';
      insert.disabled = !record.image_path;
      insert.style.cssText = 'flex:1;padding:4px 0;border:0;border-radius:5px;background:#2563eb;color:#fff;font-size:11px;cursor:pointer;';
      insert.addEventListener('click', function () {
        var canvas = canvasInstance();
        if (!canvas || typeof canvas.addImageNode !== 'function') return toast('画布尚未就绪', 'error');
        var id = canvas.addImageNode({
          url: record.image_path,
          path: record.image_path,
          prompt: record.prompt,
          provider: record.provider,
          model: record.model,
          size: record.size
        });
        if (id) {
          toast('已插入画布', 'success');
          mask.remove();
        } else {
          toast('插入失败', 'error');
        }
      });
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制词';
      copy.style.cssText = 'padding:4px 8px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;font-size:11px;cursor:pointer;';
      copy.addEventListener('click', function () { copyText(record.prompt || ''); });
      actions.appendChild(insert);
      actions.appendChild(copy);
      body.appendChild(actions);

      card.appendChild(body);
      return card;
    }

    function load() {
      pageInfo.textContent = '加载中…';
      grid.textContent = '';
      request('/history?page=' + page + '&pageSize=' + pageSize).then(function (res) {
        var data = (res.json && res.json.data) || {};
        var records = data.records || [];
        total = data.total || 0;
        grid.textContent = '';
        if (!records.length) {
          var empty = document.createElement('div');
          empty.textContent = '还没有生成记录';
          empty.style.cssText = 'grid-column:1/-1;text-align:center;color:#94a3b8;padding:24px 0;font-size:12px;';
          grid.appendChild(empty);
        }
        records.forEach(function (record) { grid.appendChild(renderCard(record)); });
        var totalPages = Math.max(Math.ceil(total / pageSize), 1);
        pageInfo.textContent = '第 ' + page + ' / ' + totalPages + ' 页 · 共 ' + total + ' 条';
        prev.disabled = page <= 1;
        next.disabled = page >= totalPages;
        prev.style.opacity = prev.disabled ? '.45' : '1';
        next.style.opacity = next.disabled ? '.45' : '1';
        prev.style.cursor = prev.disabled ? 'default' : 'pointer';
        next.style.cursor = next.disabled ? 'default' : 'pointer';
      }).catch(function () {
        pageInfo.textContent = '加载失败，请重试';
      });
    }

    prev.addEventListener('click', function () {
      if (page <= 1) return;
      page--;
      load();
    });
    next.addEventListener('click', function () {
      var totalPages = Math.max(Math.ceil(total / pageSize), 1);
      if (page >= totalPages) return;
      page++;
      load();
    });

    load();
  }

  // ============ 初始化 ============
  function boot() {
    var canvas = null;
    try {
      canvas = window.aiImageInitCanvas ? window.aiImageInitCanvas() : null;
    } catch (err) {
      canvas = null;
    }
    var initial = window.__AI_CANVAS_INITIAL_STATE__;
    if (canvas && initial && typeof canvas.applyState === 'function') {
      canvas.applyState(initial);
    }
    bindProjectUI();
    if (!window.__AI_CANVAS_PROJECT__) {
      toast('还没有画布，点左上角「新建」开始', 'info');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
