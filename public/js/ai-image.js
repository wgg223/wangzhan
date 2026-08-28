/**
 * AI 图片生成页交互
 * 依赖 /js/utils.js（escapeHtml / showToast / getCsrfToken）
 * 数据来自 #ai-image-data JSON（服务端渲染）
 */
(function() {
  var dataEl = document.getElementById('ai-image-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var providers = data.providers || [];
  var prompts = data.prompts || [];
  var stylePresets = data.stylePresets || {};
  var canPickPrompt = !!data.canPickPrompt;
  var canShare = !!data.canShare;
  var currentPage = 1;
  var totalPages = 1;
  var generating = false;
  var currentTask = null;   // 当前异步生成任务 ID
  var pollTimer = null;     // 状态轮询定时器
  var waitShown = false;    // 60 秒继续等待弹窗是否已弹出
  var taskStart = 0;        // 任务开始时间戳

  // ============ 平铺 API Key 行（保存/清除，模板内 onclick 调用） ============
  // 定义在 IIFE 最前：即使下方 providers 为空提前返回，模板 onclick 仍可用
  window.saveKeyLine = function(providerKey) {
    var input = document.getElementById('keyLineInput-' + providerKey);
    if (!input) return;
    var key = (input.value || '').trim();
    if (!key) {
      showToast('请输入 API Key', 'warning');
      input.focus();
      return;
    }
    input.disabled = true;
    csrfFetch('/ai-image/api/keys/save', {
      method: 'POST',
      body: JSON.stringify({ provider_key: providerKey, api_key: key })
    }, 60000).then(function(json) {
      input.disabled = false;
      if (json.success) {
        input.value = '';
        var status = document.getElementById('keyLineStatus-' + providerKey);
        status.textContent = '✓ 已配置';
        status.style.color = '#10b981';
        document.getElementById('keyLineClear-' + providerKey).style.display = '';
        if (json.verified) {
          var modelCount = (json.models && json.models.length) || 0;
          showToast(json.message + (modelCount ? '，自动获取 ' + modelCount + ' 个模型，已合并到模型列表' : ''), 'success');
          // 把 API 获取的模型合并进页面数据，刷新模型下拉
          if (modelCount) {
            providers.forEach(function(p) {
              if (p.provider_key === providerKey) {
                (json.models || []).forEach(function(m) {
                  if (p.models.indexOf(m) === -1) p.models.push(m);
                });
                if (!p.default_model && json.models.length) p.default_model = json.models[0];
              }
            });
            if (typeof renderModels === 'function' && els.provider && els.provider.value === providerKey) {
              renderModels();
            }
          }
        } else {
          showToast(json.message + '；' + (json.verifyError || '该平台暂不支持自动验证'), 'warning');
        }
      } else {
        showToast(json.error || '保存失败', 'error');
      }
    }).catch(function() {
      input.disabled = false;
      showToast('保存请求失败', 'error');
    });
  };

  window.clearKeyLine = function(providerKey) {
    csrfFetch('/ai-image/api/keys/delete', {
      method: 'POST',
      body: JSON.stringify({ provider_key: providerKey })
    }, 20000).then(function(json) {
      if (json.success) {
        var status = document.getElementById('keyLineStatus-' + providerKey);
        status.textContent = '未配置';
        status.style.color = 'var(--text-muted)';
        document.getElementById('keyLineClear-' + providerKey).style.display = 'none';
        showToast(json.message, 'success');
      } else {
        showToast(json.error || '清除失败', 'error');
      }
    }).catch(function() {
      showToast('清除请求失败', 'error');
    });
  };

  // ============ DOM 引用 ============
  var els = {
    provider: document.getElementById('aiimgProvider'),
    model: document.getElementById('aiimgModel'),
    prompt: document.getElementById('aiimgPrompt'),
    promptCount: document.getElementById('aiimgPromptCount'),
    negPrompt: document.getElementById('aiimgNegPrompt'),
    negCount: document.getElementById('aiimgNegCount'),
    negWrap: document.getElementById('aiimgNegWrap'),
    size: document.getElementById('aiimgSize'),
    n: document.getElementById('aiimgN'),
    nWrap: document.getElementById('aiimgNWrap'),
    seed: document.getElementById('aiimgSeed'),
    style: document.getElementById('aiimgStyle'),
    ref: document.getElementById('aiimgRef'),
    refWrap: document.getElementById('aiimgRefWrap'),
    refPreview: document.getElementById('aiimgRefPreview'),
    refPreviewImg: document.getElementById('aiimgRefPreviewImg'),
    refPreviewName: document.getElementById('aiimgRefPreviewName'),
    refRemove: document.getElementById('aiimgRefRemove'),
    refHint: document.getElementById('aiimgRefHint'),
    mode: document.getElementById('aiimgMode'),
    generate: document.getElementById('aiimgGenerate'),
    generateHint: document.getElementById('aiimgGenerateHint'),
    results: document.getElementById('aiimgResults'),
    progress: document.getElementById('aiimgProgress'),
    progressText: document.getElementById('aiimgProgressText'),
    progressFill: document.getElementById('aiimgProgressFill'),
    progressMeta: document.getElementById('aiimgProgressMeta'),
    history: document.getElementById('aiimgHistory'),
    pagination: document.getElementById('aiimgPagination'),
    quota: document.getElementById('aiimgRemain'),
    pick: document.getElementById('aiimgPickPrompt'),
    enhance: document.getElementById('aiimgEnhancePrompt'),
    cancelTask: document.getElementById('aiimgCancelTask'),
    waitMask: document.getElementById('aiimgWaitMask'),
    waitSec: document.getElementById('aiimgWaitSec'),
    waitContinue: document.getElementById('aiimgWaitContinue'),
    waitCancel: document.getElementById('aiimgWaitCancel'),
    modalMask: document.getElementById('aiimgModalMask'),
    modalClose: document.getElementById('aiimgModalClose'),
    promptSearch: document.getElementById('aiimgPromptSearch'),
    promptList: document.getElementById('aiimgPromptList')
  };

  if (!providers.length) {
    if (els.generate) {
      els.generate.disabled = true;
      els.generate.textContent = '暂无可用的生成服务商';
    }
    return;
  }

  // ============ 服务商/模型联动 ============
  function getProvider(key) {
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].provider_key === key) return providers[i];
    }
    return providers[0];
  }

  function renderModels() {
    var p = getProvider(els.provider.value);
    var models = (p.models && p.models.length) ? p.models : (p.default_model ? [p.default_model] : []);
    els.model.innerHTML = '';
    models.forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      els.model.appendChild(opt);
    });
    // 默认模型不在列表时补一个选项
    if (p.default_model && models.indexOf(p.default_model) === -1) {
      var opt = document.createElement('option');
      opt.value = p.default_model;
      opt.textContent = p.default_model;
      els.model.appendChild(opt);
      els.model.value = p.default_model;
    }
    els.negWrap.style.display = p.supports_negative ? '' : 'none';
    els.nWrap.style.display = p.supports_n ? '' : 'none';
    els.ref.value = '';
    els.refPreview.style.display = 'none';
    updateModeUI(p);
  }

  // ============ 生成模式（文生图/图生图） ============
  function updateModeUI(p) {
    if (!els.refWrap) return;
    var mode = els.mode.value;
    if (mode === 'i2i') {
      els.refWrap.style.display = '';
      if (!p.supports_img2img) {
        els.refHint.textContent = '⚠️ 当前服务商不支持图生图，请切换服务商（Stability / 硅基流动 / 通义万相 / Replicate / 豆包 / fal / AIHubMix）或回到文生图模式';
        els.refHint.style.color = '#f59e0b';
      } else {
        els.refHint.textContent = '';
      }
    } else {
      els.refWrap.style.display = 'none';
    }
  }

  if (els.mode) {
    els.mode.addEventListener('change', function() {
      updateModeUI(getProvider(els.provider.value));
    });
  }

  if (els.provider) {
    els.provider.addEventListener('change', renderModels);
    renderModels();
  }

  // ============ 字数统计 ============
  function bindCount(input, counter) {
    if (!input || !counter) return;
    input.addEventListener('input', function() {
      counter.textContent = input.value.length;
    });
  }
  bindCount(els.prompt, els.promptCount);
  bindCount(els.negPrompt, els.negCount);

  // ============ 风格预设 ============
  if (els.style) {
    els.style.addEventListener('change', function() {
      var suffix = stylePresets[els.style.value];
      if (!suffix) return;
      var cur = els.prompt.value.trim();
      if (cur && cur.indexOf(suffix) === -1) {
        els.prompt.value = cur + ', ' + suffix;
        els.promptCount.textContent = els.prompt.value.length;
      }
    });
  }

  // ============ 参考图预览（缩略图 + 文件名 + 移除） ============
  function clearRefPreview() {
    if (els.ref) els.ref.value = '';
    if (els.refPreview) els.refPreview.style.display = 'none';
    if (els.refPreviewImg) els.refPreviewImg.src = '';
    if (els.refPreviewName) els.refPreviewName.textContent = '';
  }

  if (els.ref) {
    els.ref.addEventListener('change', function() {
      var file = els.ref.files && els.ref.files[0];
      if (!file) { clearRefPreview(); return; }
      if (file.size > 5 * 1024 * 1024) {
        showToast('参考图不能超过 5MB', 'error');
        clearRefPreview();
        return;
      }
      if (!file.type.match(/^image\//)) {
        showToast('参考图仅支持图片格式', 'error');
        clearRefPreview();
        return;
      }
      var reader = new FileReader();
      reader.onload = function(e) {
        if (els.refPreviewImg) els.refPreviewImg.src = e.target.result;
        if (els.refPreviewName) els.refPreviewName.textContent = file.name + '（' + Math.round(file.size / 1024) + ' KB）';
        if (els.refPreview) els.refPreview.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    });
  }
  if (els.refRemove) {
    els.refRemove.addEventListener('click', function() {
      clearRefPreview();
      showToast('已移除参考图', 'info');
    });
  }

  // ============ 生成 ============
  function collectFormData() {
    var fd = new FormData();
    fd.append('provider', els.provider.value);
    fd.append('model', els.model.value);
    fd.append('mode', els.mode.value);
    fd.append('prompt', els.prompt.value.trim());
    fd.append('size', els.size.value);
    fd.append('n', els.n.value);
    fd.append('seed', els.seed.value || '');
    fd.append('style', els.style.value);
    if (els.negWrap.style.display !== 'none') {
      fd.append('negative_prompt', els.negPrompt.value.trim());
    }
    if (els.ref.files && els.ref.files[0]) {
      fd.append('reference_image', els.ref.files[0]);
    }
    return fd;
  }

  function setGenerating(on) {
    generating = on;
    els.generate.disabled = on;
    els.generate.textContent = on ? '⏳ 生成中（后台执行，最长约 10 分钟）...' : '✨ 生成图片';
    els.generateHint.style.display = on ? 'none' : els.generateHint.style.display;
    if (els.cancelTask) {
      els.cancelTask.style.display = on ? '' : 'none';
      els.cancelTask.disabled = false;
    }
  }

  // ============ 生成进度（真实耗时，最长约 10 分钟） ============
  var progressTimer = null;

  function startProgress() {
    if (!els.progress) return;
    els.progress.style.display = 'block';
    els.progressFill.style.width = '3%';
    progressTimer = setInterval(function() {
      var sec = Math.round((Date.now() - taskStart) / 1000);
      var pct = Math.min(95, 3 + sec / 600 * 92);
      els.progressFill.style.width = pct.toFixed(1) + '%';
      els.progressText.textContent = sec < 10
        ? '🎨 服务商生成中...'
        : '⏱️ 服务商生成中（已等待 ' + sec + ' 秒，最长约 10 分钟）...';
      if (els.progressMeta) els.progressMeta.textContent = '已用时 ' + sec + ' 秒';
    }, 500);
  }

  function stopProgress(done) {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (!els.progress) return;
    if (done) {
      els.progressFill.style.width = '100%';
      els.progressText.textContent = '✅ 生成完成';
    }
    setTimeout(function() {
      if (els.progress) els.progress.style.display = 'none';
    }, done ? 500 : 0);
  }

  function fmtElapsed(ms) {
    if (!ms) return '';
    return (ms / 1000).toFixed(1) + ' 秒';
  }

  // 校验并执行生成；modelOverride 用于"更换模型重试"时覆盖当前模型
  function doGenerate(modelOverride) {
    if (generating) return;
    var prompt = els.prompt.value.trim();
    if (!prompt) {
      showToast('请先填写提示词', 'warning');
      els.prompt.focus();
      return;
    }
    var p = getProvider(els.provider.value);
    var mode = els.mode.value;
    if (mode === 'i2i') {
      if (!p.supports_img2img) {
        showToast('当前服务商不支持图生图，请切换服务商或回到文生图模式', 'warning');
        return;
      }
      if (!els.ref.files || !els.ref.files[0]) {
        showToast('图生图模式请先上传参考图', 'warning');
        els.ref.focus();
        return;
      }
      if (!els.ref.files[0].type.match(/^image\//)) {
        showToast('参考图格式不正确', 'error');
        return;
      }
    }
    if (modelOverride && els.model.value !== modelOverride) {
      els.model.value = modelOverride;
    }
    setGenerating(true);
    startProgress();
    waitShown = false;
    taskStart = Date.now();

    fetch('/ai-image/api/generate', {
      method: 'POST',
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: collectFormData()
    }).then(function(resp) {
      return resp.json().catch(function() { return { error: '服务返回异常（HTTP ' + resp.status + '）' }; });
    }).then(function(json) {
      if (json.success && json.taskId) {
        refreshQuota();
        pollTask(json.taskId);
      } else {
        setGenerating(false);
        stopProgress(false);
        var msg = json.error || '生成失败';
        renderFailure(msg, json.attempts, json.elapsedMs);
        showToast(msg, 'error');
      }
    }).catch(function() {
      setGenerating(false);
      stopProgress(false);
      var msg = '网络错误，请检查连接后重试';
      renderFailure(msg, null, null);
      showToast(msg, 'error');
    });
  }

  // ============ 异步任务轮询（每 3 秒查状态；60 秒弹窗询问是否继续等待） ============
  function pollTask(taskId) {
    currentTask = taskId;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function() {
      csrfFetch('/ai-image/api/status?task=' + encodeURIComponent(taskId), { method: 'GET' }, 15000).then(function(json) {
        if (!json.success) {
          finishTask(false, json.error || '状态查询失败', null);
          return;
        }
        var d = json.data || {};
        var sec = Math.round((Date.now() - taskStart) / 1000);
        if (els.progressMeta) els.progressMeta.textContent = '已用时 ' + sec + ' 秒';
        if (d.status === 'running') {
          if (sec >= 60 && !waitShown) {
            waitShown = true;
            if (els.waitSec) els.waitSec.textContent = sec;
            if (els.waitMask) els.waitMask.style.display = 'flex';
          }
          return;
        }
        if (d.status === 'success') {
          finishTask(true, null, d.result);
        } else if (d.status === 'cancelled') {
          finishTask(false, '任务已取消', d.result, true);
        } else {
          finishTask(false, (d.result && d.result.error) || d.message || '生成失败', d.result);
        }
      }).catch(function() {
        // 状态查询瞬时失败：继续轮询，不打断生成
      });
    }, 3000);
  }

  function finishTask(ok, error, result, isCancelled) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentTask = null;
    if (els.waitMask) els.waitMask.style.display = 'none';
    setGenerating(false);
    if (ok && result) {
      stopProgress(true);
      renderResults(result);
      if (result.fallbackUsed) {
        els.generateHint.style.display = '';
        els.generateHint.textContent = 'ℹ️ 首选服务商不可用，已自动切换到其他服务商生成（用时 ' + fmtElapsed(result.elapsedMs) + '）';
      }
      loadHistory(1);
    } else {
      stopProgress(false);
      renderFailure(error || '生成失败', result && result.attempts, result && result.elapsedMs);
      showToast(error || '生成失败', isCancelled ? 'info' : 'error');
    }
  }

  // 取消任务：调用服务端取消接口（尽力调用服务商取消接口，避免远程资源浪费）
  function cancelCurrentTask() {
    if (!currentTask) return;
    if (els.waitMask) els.waitMask.style.display = 'none';
    if (els.cancelTask) els.cancelTask.disabled = true;
    csrfFetch('/ai-image/api/cancel', {
      method: 'POST',
      body: JSON.stringify({ task: currentTask })
    }, 15000).then(function(json) {
      if (json.success) {
        showToast('已发送取消请求，正在停止任务...', 'info');
      } else {
        if (els.cancelTask) els.cancelTask.disabled = false;
        showToast(json.error || '取消失败', 'error');
      }
    }).catch(function() {
      if (els.cancelTask) els.cancelTask.disabled = false;
      showToast('取消请求失败，请重试', 'error');
    });
  }

  if (els.cancelTask) {
    els.cancelTask.addEventListener('click', cancelCurrentTask);
  }
  if (els.waitContinue) {
    els.waitContinue.addEventListener('click', function() {
      if (els.waitMask) els.waitMask.style.display = 'none';
    });
  }
  if (els.waitCancel) {
    els.waitCancel.addEventListener('click', cancelCurrentTask);
  }

  // 生成失败：结果区展示失败原因 + 尝试明细 + 提供"更换模型重试"
  function renderFailure(error, attempts, elapsedMs) {
    var p = getProvider(els.provider.value);
    var models = (p.models && p.models.length) ? p.models : (p.default_model ? [p.default_model] : []);
    var hasOtherModel = models.length > 1;
    var attemptHtml = '';
    if (attempts && attempts.length) {
      var rows = '';
      attempts.forEach(function(a) {
        var name = a.provider || '';
        providers.forEach(function(pp) { if (pp.provider_key === a.provider) name = pp.name; });
        rows += '<div class="aiimg-fail-attempt"><b>' + escapeHtml(name) + '</b>' +
          (a.model ? '（' + escapeHtml(a.model) + '）' : '') +
          ' — ' + escapeHtml(a.error || '未知错误') +
          (a.elapsedMs ? '（' + fmtElapsed(a.elapsedMs) + '）' : '') + '</div>';
      });
      attemptHtml = '<div class="aiimg-fail-attempts">' +
        '<div class="aiimg-fail-attempts-title">已尝试 ' + attempts.length + ' 个服务商，均失败：</div>' + rows + '</div>';
    }
    var timeHtml = elapsedMs ? '<div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:10px;">总耗时 ' + fmtElapsed(elapsedMs) + '</div>' : '';
    var html = '<div class="aiimg-fail-card">' +
      '<div class="aiimg-fail-title">⚠️ 生成失败</div>' +
      '<div class="aiimg-fail-meta">服务商：' + escapeHtml(p.name) + ' · 模型：' + escapeHtml(els.model.value || '默认') + '</div>' +
      '<div class="aiimg-fail-msg">' + escapeHtml(error || '未知错误') + '</div>' +
      timeHtml +
      attemptHtml +
      (hasOtherModel ? '<button type="button" class="aiimg-btn aiimg-btn-sm aiimg-btn-primary" id="aiimgRetryModel">🔄 更换模型重试</button>' : '') +
      '</div>';
    els.results.innerHTML = html;
    var btn = document.getElementById('aiimgRetryModel');
    if (btn) {
      btn.addEventListener('click', function() {
        var next = nextModel();
        if (!next) {
          showToast('没有其他模型可更换', 'warning');
          return;
        }
        showToast('已切换到模型：' + next + '，正在重试...', 'info');
        doGenerate(next);
      });
    }
  }

  // 取当前服务商模型列表中"当前模型的下一个"（循环）
  function nextModel() {
    var p = getProvider(els.provider.value);
    var models = (p.models && p.models.length) ? p.models : (p.default_model ? [p.default_model] : []);
    if (models.length < 2) return null;
    var cur = els.model.value;
    var idx = models.indexOf(cur);
    return models[(idx + 1) % models.length];
  }

  if (els.generate) {
    els.generate.addEventListener('click', function() {
      doGenerate();
    });
  }

  function renderResults(d) {
    var images = d.images || [];
    if (!images.length) {
      els.results.innerHTML = '<div class="aiimg-empty">未生成图片</div>';
      return;
    }
    var timeHtml = d.elapsedMs
      ? '<div class="aiimg-result-time">✅ 生成完成，用时 ' + fmtElapsed(d.elapsedMs) + '（服务商：' + escapeHtml(d.provider || '') + '）</div>'
      : '';
    var html = timeHtml + '<div class="aiimg-result-grid">';
    images.forEach(function(img) {
      html += '<div class="aiimg-result-item">' +
        '<img src="' + escapeHtml(img.url) + '" alt="生成图片" loading="lazy">' +
        '<div class="aiimg-result-actions">' +
        '<a class="aiimg-btn aiimg-btn-sm" href="' + escapeHtml(img.url) + '" download target="_blank" rel="noopener">⬇️ 下载</a>' +
        (canShare ? '<button type="button" class="aiimg-btn aiimg-btn-sm aiimg-share" data-url="' + escapeHtml(img.url) + '">📤 分享</button>' : '') +
        '</div></div>';
    });
    html += '</div>';
    els.results.innerHTML = html;
    els.results.querySelectorAll('.aiimg-share').forEach(function(btn) {
      btn.addEventListener('click', function() {
        shareImage(btn.getAttribute('data-url'));
      });
    });
  }

  // ============ 分享到图片分享 ============
  function shareImage(imageUrl) {
    var recordId = null;
    // 从结果图反查记录：按 url 在历史中找
    findRecordByImage(imageUrl, function(rec) {
      if (!rec) {
        showToast('未找到对应生成记录', 'warning');
        return;
      }
      if (rec.shared) {
        showToast('该图片已分享过', 'warning');
        return;
      }
      csrfFetch('/ai-image/api/share', {
        method: 'POST',
        body: JSON.stringify({ record_id: rec.id })
      }, 20000).then(function(json) {
        if (json.success) {
          showToast(json.message, 'success');
          loadHistory(currentPage);
        } else {
          showToast(json.error || '分享失败', 'error');
        }
      }).catch(function() {
        showToast('分享请求失败', 'error');
      });
    });
  }

  function findRecordByImage(imageUrl, cb) {
    csrfFetch('/ai-image/api/history?page=1&pageSize=50', { method: 'GET' }, 15000).then(function(json) {
      if (!json.success) return cb(null);
      var rec = null;
      (json.data.records || []).forEach(function(r) {
        if (r.image_path === imageUrl && !rec) rec = r;
      });
      cb(rec);
    }).catch(function() {
      cb(null);
    });
  }

  // ============ 历史记录 ============
  function loadHistory(page) {
    currentPage = page;
    csrfFetch('/ai-image/api/history?page=' + page + '&pageSize=12', { method: 'GET' }, 15000).then(function(json) {
      if (!json.success) {
        els.history.innerHTML = '<div class="aiimg-empty">加载失败</div>';
        return;
      }
      var d = json.data;
      var records = d.records || [];
      if (!records.length) {
        els.history.innerHTML = '<div class="aiimg-empty">暂无记录</div>';
        els.pagination.style.display = 'none';
        return;
      }
      var html = '';
      records.forEach(function(r) {
        var thumb = r.image_path
          ? '<img class="aiimg-history-thumb" src="' + escapeHtml(r.image_path) + '" alt="" loading="lazy">'
          : '<div class="aiimg-history-thumb"></div>';
        var statusHtml = r.status === 'success'
          ? '<span style="color:#10b981;">✓ 成功</span>'
          : '<span style="color:#ef4444;">✗ 失败</span>';
        var actions = '';
        if (r.status === 'success' && r.image_path) {
          actions = '<div class="aiimg-history-actions">' +
            '<a class="aiimg-btn aiimg-btn-sm" href="' + escapeHtml(r.image_path) + '" download target="_blank" rel="noopener">下载</a>' +
            (r.shared || !canShare ? '' : '<button type="button" class="aiimg-btn aiimg-btn-sm aiimg-history-share" data-id="' + r.id + '">分享</button>') +
            '</div>';
        }
        html += '<div class="aiimg-history-item">' + thumb +
          '<div class="aiimg-history-info">' +
          '<div class="aiimg-history-prompt">' + escapeHtml(r.prompt || '') + '</div>' +
          '<div class="aiimg-history-meta">' + escapeHtml(r.provider || '') + ' · ' + escapeHtml(r.model || '-') +
          ' · ' + escapeHtml(r.size || '-') + ' · ' + escapeHtml(r.created_at || '') + ' · ' + statusHtml + '</div>' +
          (r.status === 'failed' && r.error ? '<div class="aiimg-history-error">' + escapeHtml(r.error) + '</div>' : '') +
          '</div>' + actions + '</div>';
      });
      els.history.innerHTML = html;
      els.history.querySelectorAll('.aiimg-history-share').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var id = parseInt(btn.getAttribute('data-id'), 10);
          csrfFetch('/ai-image/api/share', {
            method: 'POST',
            body: JSON.stringify({ record_id: id })
          }, 20000).then(function(json) {
            if (json.success) {
              showToast(json.message, 'success');
              loadHistory(currentPage);
            } else {
              showToast(json.error || '分享失败', 'error');
            }
          }).catch(function() {
            showToast('分享请求失败', 'error');
          });
        });
      });
      // 分页
      totalPages = Math.max(Math.ceil(d.total / d.pageSize), 1);
      if (totalPages > 1) {
        var ph = '';
        for (var i = 1; i <= totalPages; i++) {
          ph += '<button type="button" class="aiimg-btn aiimg-btn-sm' + (i === page ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        }
        els.pagination.innerHTML = ph;
        els.pagination.style.display = 'flex';
        els.pagination.querySelectorAll('button').forEach(function(b) {
          b.addEventListener('click', function() {
            loadHistory(parseInt(b.getAttribute('data-page'), 10));
          });
        });
      } else {
        els.pagination.style.display = 'none';
      }
    }).catch(function() {
      els.history.innerHTML = '<div class="aiimg-empty">加载失败</div>';
    });
  }

  function refreshQuota() {
    if (els.quota) {
      var remain = parseInt(els.quota.textContent, 10);
      els.quota.textContent = Math.max(0, remain - 1);
    }
  }

  // ============ 提示词库选择弹窗 ============
  function renderPromptList(filter) {
    if (!els.promptList) return;
    filter = (filter || '').toLowerCase();
    var list = prompts.filter(function(p) {
      return !filter || (p.title || '').toLowerCase().indexOf(filter) !== -1 ||
        (p.excerpt || '').toLowerCase().indexOf(filter) !== -1;
    });
    if (!list.length) {
      els.promptList.innerHTML = '<div class="aiimg-empty">未找到匹配的提示词</div>';
      return;
    }
    var html = '';
    list.slice(0, 50).forEach(function(p) {
      html += '<div class="aiimg-prompt-item" data-id="' + p.id + '">' +
        '<div class="aiimg-prompt-item-title">' + escapeHtml(p.title) + '</div>' +
        (p.excerpt ? '<div class="aiimg-prompt-item-excerpt">' + escapeHtml(p.excerpt) + '</div>' : '') +
        '</div>';
    });
    els.promptList.innerHTML = html;
    els.promptList.querySelectorAll('.aiimg-prompt-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var id = parseInt(item.getAttribute('data-id'), 10);
        var found = null;
        prompts.forEach(function(p) { if (p.id === id) found = p; });
        if (found) {
          els.prompt.value = found.excerpt || found.title;
          els.promptCount.textContent = els.prompt.value.length;
          showToast('已填充提示词，可编辑后生成', 'success');
        }
        closeModal();
      });
    });
  }

  function openModal() {
    els.modalMask.style.display = 'flex';
    els.promptSearch.value = '';
    renderPromptList('');
    els.promptSearch.focus();
  }

  function closeModal() {
    els.modalMask.style.display = 'none';
  }

  if (els.pick) {
    els.pick.addEventListener('click', openModal);
  }

  // ============ 提示词优化 ============
  if (els.enhance) {
    els.enhance.addEventListener('click', function() {
      if (els.enhance.disabled) return;
      var src = els.prompt.value.trim();
      if (!src) {
        showToast('请先输入想优化的画面描述', 'warning');
        els.prompt.focus();
        return;
      }
      var originalText = els.enhance.textContent;
      els.enhance.disabled = true;
      els.enhance.textContent = '⏳ 优化中...';
      csrfFetch('/ai-image/api/enhance-prompt', {
        method: 'POST',
        body: JSON.stringify({ prompt: src })
      }, 90000).then(function(json) {
        els.enhance.disabled = false;
        els.enhance.textContent = originalText;
        if (json.success && json.enhanced) {
          els.prompt.value = json.enhanced;
          els.promptCount.textContent = els.prompt.value.length;
          if (json.source === 'local') {
            showToast('已用内置基础模式优化（免费接口暂不可用，站长可配置 LLM Key 提升效果）', 'warning');
          } else if (json.source === 'free') {
            showToast('提示词已优化（免费接口），可继续编辑', 'success');
          } else {
            showToast('提示词已优化，可继续编辑', 'success');
          }
        } else {
          showToast(json.error || '优化失败', 'error');
        }
      }).catch(function() {
        els.enhance.disabled = false;
        els.enhance.textContent = originalText;
        showToast('优化请求失败，请稍后重试', 'error');
      });
    });
  }
  if (els.modalClose) {
    els.modalClose.addEventListener('click', closeModal);
  }
  if (els.modalMask) {
    els.modalMask.addEventListener('click', function(e) {
      if (e.target === els.modalMask) closeModal();
    });
  }
  if (els.promptSearch) {
    els.promptSearch.addEventListener('input', function() {
      renderPromptList(els.promptSearch.value);
    });
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeModal();
    }
  });

  // ============ 初始化 ============
  loadHistory(1);
})();
