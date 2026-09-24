/**
 * 在线表格列表页交互（Univer 版）
 * 功能：搜索 / 权限筛选 / 新建表格 / 导入 .xlsx .csv
 * 依赖：/js/utils.js（layout 引入，提供 csrfFetch / showToast / escapeHtml）
 */

(function () {
  'use strict';

  var modalRoot = document.getElementById('sheetModalRoot');
  var grid = document.getElementById('sheetGrid');
  var searchInput = document.getElementById('sheetSearch');
  var permFilter = document.getElementById('sheetPermFilter');

  // ============ 搜索与筛选 ============

  var searchTimer = null;

  function applyFilters() {
    if (!grid) return;
    var keyword = (searchInput ? searchInput.value : '').trim().toLowerCase();
    // 筛选值：'all' 显示全部（哨兵 -1）；'0'~'4' 精确匹配 data-perm
    var permVal = permFilter ? permFilter.value : 'all';
    var perm = permVal === 'all' ? -1 : parseInt(permVal, 10);
    var visible = 0;
    var cards = grid.querySelectorAll('.sheet-card');
    cards.forEach(function (card) {
      var name = card.getAttribute('data-name') || '';
      var desc = card.getAttribute('data-desc') || '';
      var creator = card.getAttribute('data-creator') || '';
      var cardPerm = parseInt(card.getAttribute('data-perm') || '0', 10);
      var matchKeyword = !keyword || name.indexOf(keyword) !== -1
        || desc.indexOf(keyword) !== -1 || creator.indexOf(keyword) !== -1;
      var matchPerm = perm === -1 || cardPerm === perm;
      var show = matchKeyword && matchPerm;
      card.classList.toggle('is-hidden', !show);
      if (show) visible++;
    });
    var empty = document.getElementById('noSearchResult');
    if (empty) empty.hidden = visible !== 0;
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 200);
    });
  }
  if (permFilter) permFilter.addEventListener('change', applyFilters);

  // ============ 对话框渲染 ============

  function closeModal() {
    if (modalRoot) modalRoot.innerHTML = '';
  }

  function renderModal(html) {
    if (!modalRoot) return;
    modalRoot.innerHTML = html;
    var backdrop = modalRoot.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeModal();
      });
    }
  }

  // ============ 新建表格 ============

  function openCreateModal() {
    renderModal(
      '<div class="modal-backdrop"><div class="modal-box">' +
      '<h3>＋ 新建表格</h3>' +
      '<div class="modal-field"><label>表格名称</label>' +
      '<input type="text" id="newSheetName" maxlength="100" placeholder="例如：2026 年度预算"></div>' +
      '<div class="modal-field"><label>描述（可选）</label>' +
      '<textarea id="newSheetDesc" maxlength="500" placeholder="简要说明用途…"></textarea></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn" data-act="cancel">取消</button>' +
      '<button type="button" class="btn btn-primary" data-act="create">创建</button>' +
      '</div></div></div>'
    );

    var nameInput = document.getElementById('newSheetName');
    if (nameInput) nameInput.focus();

    modalRoot.addEventListener('click', function onCreate(e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'cancel') {
        closeModal();
        modalRoot.removeEventListener('click', onCreate);
      } else if (act === 'create') {
        var name = nameInput ? nameInput.value.trim() : '';
        var desc = document.getElementById('newSheetDesc');
        if (!name) {
          showToast('请输入表格名称', 'warning');
          if (nameInput) nameInput.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = '创建中…';
        csrfFetch('/api/spreadsheet', {
          method: 'POST',
          body: JSON.stringify({ name: name, description: desc ? desc.value.trim() : '' })
        }).then(function (result) {
          if (result && result.success && result.data && result.data.id) {
            window.location.href = '/spreadsheet/' + result.data.id;
          } else {
            showToast((result && result.error) || '创建失败', 'error');
            btn.disabled = false;
            btn.textContent = '创建';
          }
        }).catch(function (err) {
          showToast('网络错误，创建失败：' + (err && err.message ? err.message : ''), 'error');
          btn.disabled = false;
          btn.textContent = '创建';
        });
      }
    });
  }

  // ============ 导入文件 ============

  var pickedFile = null;

  function openImportModal() {
    pickedFile = null;
    renderModal(
      '<div class="modal-backdrop"><div class="modal-box">' +
      '<h3>📥 导入文件</h3>' +
      '<div class="modal-field"><label>选择文件（.xlsx / .csv，最大 10MB）</label>' +
      '<div class="modal-file-drop" id="fileDrop">点击选择文件，或拖拽到此处' +
      '<div class="modal-file-hint" id="fileHint">支持多工作表 / 单元格值 / 公式文本</div></div>' +
      '<input type="file" id="importFileInput" accept=".xlsx,.csv" hidden>' +
      '</div>' +
      '<div class="modal-field"><label>表格名称（默认取文件名）</label>' +
      '<input type="text" id="importSheetName" maxlength="100" placeholder="留空则使用文件名"></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn" data-act="cancel">取消</button>' +
      '<button type="button" class="btn btn-primary" data-act="import">导入</button>' +
      '</div></div></div>'
    );

    var drop = document.getElementById('fileDrop');
    var fileInput = document.getElementById('importFileInput');
    if (!drop || !fileInput) return;

    function setFile(file) {
      if (!file) return;
      var ext = (file.name || '').split('.').pop().toLowerCase();
      if (ext !== 'xlsx' && ext !== 'csv') {
        showToast('仅支持 .xlsx 或 .csv 文件', 'warning');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast('文件超过 10MB 限制', 'warning');
        return;
      }
      pickedFile = file;
      var hint = document.getElementById('fileHint');
      if (hint) hint.textContent = '已选择：' + file.name + '（' + (file.size / 1024).toFixed(1) + ' KB）';
    }

    drop.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { setFile(fileInput.files[0]); });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('is-dragover');
    });
    drop.addEventListener('dragleave', function () { drop.classList.remove('is-dragover'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('is-dragover');
      setFile(e.dataTransfer.files[0]);
    });

    modalRoot.addEventListener('click', function onImport(e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'cancel') {
        closeModal();
        modalRoot.removeEventListener('click', onImport);
      } else if (act === 'import') {
        if (!pickedFile) {
          showToast('请先选择文件', 'warning');
          return;
        }
        var nameInput = document.getElementById('importSheetName');
        var formData = new FormData();
        formData.append('file', pickedFile);
        if (nameInput && nameInput.value.trim()) formData.append('name', nameInput.value.trim());
        btn.disabled = true;
        btn.textContent = '导入中…';
        fetch('/api/spreadsheet/import', {
          method: 'POST',
          headers: { 'X-CSRF-Token': getCsrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
          body: formData
        }).then(function (resp) { return resp.json(); }).then(function (result) {
          if (result && result.success && result.data && result.data.id) {
            window.location.href = '/spreadsheet/' + result.data.id;
          } else {
            showToast((result && result.error) || '导入失败', 'error');
            btn.disabled = false;
            btn.textContent = '导入';
          }
        }).catch(function (err) {
          showToast('网络错误，导入失败：' + (err && err.message ? err.message : ''), 'error');
          btn.disabled = false;
          btn.textContent = '导入';
        });
      }
    });
  }

  // ============ 无权限卡片：申请只读访问 ============

  // 委托点击：按钮嵌在 <a> 卡片内，需阻止跳转
  var applyRoot = grid || document;
  applyRoot.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-apply]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    var sheetId = btn.getAttribute('data-apply');
    btn.disabled = true;
    btn.textContent = '申请中…';
    csrfFetch('/api/spreadsheet/' + sheetId + '/permission/apply', {
      method: 'POST',
      body: JSON.stringify({ perm_type: 'view', reason: '列表页申请只读访问' })
    }).then(function (result) {
      if (result && result.success) {
        btn.textContent = '⏳ 待审批';
        showToast('申请已提交，等待创建者审批', 'success');
      } else {
        showToast((result && result.error) || '申请失败，请稍后重试', 'error');
        btn.disabled = false;
        btn.textContent = '📩 申请访问';
      }
    }).catch(function (err) {
      showToast('网络错误，申请失败：' + (err && err.message ? err.message : ''), 'error');
      btn.disabled = false;
      btn.textContent = '📩 申请访问';
    });
  });

  // ============ 绑定按钮 ============

  var btnCreate = document.getElementById('btnCreateSheet');
  if (btnCreate) btnCreate.addEventListener('click', openCreateModal);
  var btnImport = document.getElementById('btnImportSheet');
  if (btnImport) btnImport.addEventListener('click', openImportModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalRoot && modalRoot.innerHTML) closeModal();
  });
})();
