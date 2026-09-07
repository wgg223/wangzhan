/**
 * 在线表格前端交互逻辑
 * 功能：分页、搜索、排序、行内编辑、添加/删除行、列显示/隐藏、添加列
 */
(function() {
  'use strict';

  var config = window.SPREADSHEET_CONFIG || {};
  var sheetId = config.sheetId;
  var canManage = config.canManage === true;
  var columns = config.columns || [];

  // 状态
  var state = {
    page: 1,
    pageSize: 20,
    search: '',
    sortField: '',
    sortOrder: 'asc',
    rows: [],
    total: 0,
    totalPages: 0,
    editingRowId: null
  };

  var searchTimer = null;

  // ============ 初始化 ============
  function init() {
    bindEvents();
    loadData();
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    // 搜索（防抖）
    var searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadData();
        }, 300);
      });
    }

    // 分页
    document.getElementById('btnFirstPage').addEventListener('click', function() { goToPage(1); });
    document.getElementById('btnPrevPage').addEventListener('click', function() { goToPage(state.page - 1); });
    document.getElementById('btnNextPage').addEventListener('click', function() { goToPage(state.page + 1); });
    document.getElementById('btnLastPage').addEventListener('click', function() { goToPage(state.totalPages); });

    // 每页条数
    document.getElementById('pageSizeSelect').addEventListener('change', function(e) {
      state.pageSize = parseInt(e.target.value, 10);
      state.page = 1;
      loadData();
    });

    // 排序
    document.querySelectorAll('.col-sort-icon').forEach(function(icon) {
      icon.addEventListener('click', function(e) {
        e.stopPropagation();
        var field = this.getAttribute('data-field');
        if (state.sortField === field) {
          state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortField = field;
          state.sortOrder = 'asc';
        }
        updateSortIcons();
        loadData();
      });
    });

    if (canManage) {
      // 添加行
      document.getElementById('btnAddRow').addEventListener('click', addRow);
      // 列显示设置
      document.getElementById('btnColumnSettings').addEventListener('click', openColumnModal);
      // 添加列
      document.getElementById('btnAddColumn').addEventListener('click', openAddColumnModal);
    }
  }

  // ============ 数据加载 ============
  function loadData() {
    var params = new URLSearchParams({
      page: state.page,
      pageSize: state.pageSize
    });
    if (state.search) params.set('search', state.search);
    if (state.sortField) {
      params.set('sortField', state.sortField);
      params.set('sortOrder', state.sortOrder);
    }

    fetch('/api/spreadsheet/' + sheetId + '/data?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.success && res.data) {
          state.rows = res.data.rows;
          state.total = res.data.pagination.total;
          state.totalPages = res.data.pagination.totalPages;
          // 用最新的列配置（可能包含新增列）
          if (res.data.columns && res.data.columns.length > 0) {
            columns = res.data.columns;
          }
          renderTable();
          renderPagination();
        }
      })
      .catch(function(err) {
        console.error('加载数据失败:', err);
        document.getElementById('tableBody').innerHTML = '<tr class="empty-row"><td colspan="100">加载失败，请刷新重试</td></tr>';
      });
  }

  // ============ 渲染表格 ============
  function renderTable() {
    var tbody = document.getElementById('tableBody');
    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="100">暂无数据</td></tr>';
      return;
    }

    var startNum = (state.page - 1) * state.pageSize + 1;
    var html = '';

    state.rows.forEach(function(row, idx) {
      html += '<tr data-row-id="' + row.id + '">';
      html += '<td class="row-num-col">' + (startNum + idx) + '</td>';

      columns.forEach(function(col) {
        var hiddenClass = col.is_visible ? '' : 'hidden-col';
        var value = row.data[col.field_key] || '';
        html += '<td class="' + hiddenClass + '" data-field="' + col.field_key + '">';
        if (canManage) {
          html += '<div class="cell-text" data-row-id="' + row.id + '" data-field="' + col.field_key + '">' + escapeHtml(value) + '</div>';
        } else {
          html += escapeHtml(value);
        }
        html += '</td>';
      });

      if (canManage) {
        html += '<td class="action-col">';
        html += '<div class="row-actions">';
        html += '<button class="row-action-btn edit" onclick="window.__ss.editRow(' + row.id + ')">编辑</button>';
        html += '<button class="row-action-btn delete" onclick="window.__ss.deleteRow(' + row.id + ')">删除</button>';
        html += '</div>';
        html += '</td>';
      }

      html += '</tr>';
    });

    tbody.innerHTML = html;

    // 绑定单元格点击编辑
    if (canManage) {
      tbody.querySelectorAll('.cell-text').forEach(function(cell) {
        cell.addEventListener('click', function() {
          var rowId = parseInt(this.getAttribute('data-row-id'), 10);
          var field = this.getAttribute('data-field');
          startCellEdit(rowId, field, this);
        });
      });
    }
  }

  // ============ 分页渲染 ============
  function renderPagination() {
    document.getElementById('rowCountInfo').textContent = '共 ' + state.total + ' 条';
    document.getElementById('paginationInfo').textContent =
      '第 ' + state.page + ' 页 / 共 ' + state.totalPages + ' 页';

    document.getElementById('btnFirstPage').disabled = state.page <= 1;
    document.getElementById('btnPrevPage').disabled = state.page <= 1;
    document.getElementById('btnNextPage').disabled = state.page >= state.totalPages;
    document.getElementById('btnLastPage').disabled = state.page >= state.totalPages;

    // 页码按钮
    var pageNumbers = document.getElementById('pageNumbers');
    var html = '';
    var maxVisible = 5;
    var start = Math.max(1, state.page - Math.floor(maxVisible / 2));
    var end = Math.min(state.totalPages, start + maxVisible - 1);
    if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

    for (var i = start; i <= end; i++) {
      html += '<button class="page-btn ' + (i === state.page ? 'active' : '') + '" onclick="window.__ss.goToPage(' + i + ')">' + i + '</button>';
    }
    pageNumbers.innerHTML = html;
  }

  function goToPage(page) {
    if (page < 1 || page > state.totalPages || page === state.page) return;
    state.page = page;
    loadData();
  }

  // ============ 排序图标 ============
  function updateSortIcons() {
    document.querySelectorAll('.col-sort-icon').forEach(function(icon) {
      var field = icon.getAttribute('data-field');
      icon.classList.remove('asc', 'desc');
      if (field === state.sortField) {
        icon.classList.add(state.sortOrder);
        icon.textContent = state.sortOrder === 'asc' ? '↑' : '↓';
      } else {
        icon.textContent = '↕';
      }
    });
  }

  // ============ 行内编辑 ============
  function startCellEdit(rowId, field, cellEl) {
    if (state.editingRowId !== null) return; // 同时只编辑一个
    state.editingRowId = rowId;

    var currentValue = '';
    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (row && row.data) currentValue = row.data[field] || '';

    var td = cellEl.parentElement;
    td.classList.add('editing');
    td.innerHTML = '<input type="text" class="cell-input" value="' + escapeAttr(currentValue) + '" />';

    var input = td.querySelector('.cell-input');
    input.focus();
    input.select();

    var save = function() {
      var newValue = input.value;
      saveCellEdit(rowId, field, newValue, td);
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        td.classList.remove('editing');
        td.innerHTML = '<div class="cell-text" data-row-id="' + rowId + '" data-field="' + field + '">' + escapeHtml(currentValue) + '</div>';
        state.editingRowId = null;
        bindCellClick(td.querySelector('.cell-text'));
      }
    });
  }

  function bindCellClick(cellEl) {
    if (!cellEl) return;
    cellEl.addEventListener('click', function() {
      var rowId = parseInt(this.getAttribute('data-row-id'), 10);
      var field = this.getAttribute('data-field');
      startCellEdit(rowId, field, this);
    });
  }

  function saveCellEdit(rowId, field, newValue, td) {
    // 找到当前行数据
    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (!row) { state.editingRowId = null; return; }

    var newData = Object.assign({}, row.data || {});
    newData[field] = newValue;

    fetch('/api/spreadsheet/' + sheetId + '/row/' + rowId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_data: newData })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        row.data = newData;
        td.classList.remove('editing');
        td.innerHTML = '<div class="cell-text" data-row-id="' + rowId + '" data-field="' + field + '">' + escapeHtml(newValue) + '</div>';
        bindCellClick(td.querySelector('.cell-text'));
      } else {
        alert(res.error || '保存失败');
        td.classList.remove('editing');
        var oldVal = row.data[field] || '';
        td.innerHTML = '<div class="cell-text" data-row-id="' + rowId + '" data-field="' + field + '">' + escapeHtml(oldVal) + '</div>';
        bindCellClick(td.querySelector('.cell-text'));
      }
      state.editingRowId = null;
    })
    .catch(function(err) {
      alert('保存失败: ' + err.message);
      state.editingRowId = null;
      loadData();
    });
  }

  // 整行编辑模式（点击"编辑"按钮）
  function editRow(rowId) {
    if (state.editingRowId !== null) { alert('请先完成当前编辑'); return; }
    state.editingRowId = rowId;

    var tr = document.querySelector('tr[data-row-id="' + rowId + '"]');
    if (!tr) return;

    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (!row) return;

    // 将所有可见列转为输入框
    columns.forEach(function(col) {
      if (!col.is_visible) return;
      var td = tr.querySelector('td[data-field="' + col.field_key + '"]');
      if (!td) return;
      var value = row.data[col.field_key] || '';
      td.classList.add('editing');
      td.innerHTML = '<input type="text" class="cell-input" data-field="' + col.field_key + '" value="' + escapeAttr(value) + '" />';
    });

    // 操作列改为保存/取消
    var actionTd = tr.querySelector('.action-col');
    if (actionTd) {
      actionTd.innerHTML = '<div class="row-actions">' +
        '<button class="row-action-btn save" onclick="window.__ss.saveRowEdit(' + rowId + ')">保存</button>' +
        '<button class="row-action-btn cancel" onclick="window.__ss.cancelRowEdit(' + rowId + ')">取消</button>' +
        '</div>';
    }
  }

  function saveRowEdit(rowId) {
    var tr = document.querySelector('tr[data-row-id="' + rowId + '"]');
    if (!tr) return;

    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (!row) return;

    var newData = Object.assign({}, row.data || {});
    tr.querySelectorAll('.cell-input').forEach(function(input) {
      var field = input.getAttribute('data-field');
      newData[field] = input.value;
    });

    fetch('/api/spreadsheet/' + sheetId + '/row/' + rowId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_data: newData })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        row.data = newData;
        state.editingRowId = null;
        loadData();
      } else {
        alert(res.error || '保存失败');
      }
    })
    .catch(function(err) { alert('保存失败: ' + err.message); });
  }

  function cancelRowEdit(rowId) {
    state.editingRowId = null;
    loadData();
  }

  // ============ 添加行 ============
  function addRow() {
    if (state.editingRowId !== null) { alert('请先完成当前编辑'); return; }

    // 创建空行数据
    var emptyData = {};
    columns.forEach(function(col) { emptyData[col.field_key] = ''; });

    fetch('/api/spreadsheet/' + sheetId + '/row', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_data: emptyData })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        // 跳转到最后一页并编辑新行
        state.page = state.totalPages + 1;
        loadData();
        setTimeout(function() {
          editRow(res.data.id);
        }, 300);
      } else {
        alert(res.error || '添加失败');
      }
    })
    .catch(function(err) { alert('添加失败: ' + err.message); });
  }

  // ============ 删除行 ============
  function deleteRow(rowId) {
    if (!confirm('确定要删除这一行吗？')) return;
    fetch('/api/spreadsheet/' + sheetId + '/row/' + rowId, { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.success) {
          // 如果当前页只剩这一行，回到上一页
          if (state.rows.length === 1 && state.page > 1) state.page--;
          loadData();
        } else {
          alert(res.error || '删除失败');
        }
      })
    .catch(function(err) { alert('删除失败: ' + err.message); });
  }

  // ============ 列显示/隐藏 ============
  function openColumnModal() {
    var body = document.getElementById('columnModalBody');
    var html = '';
    columns.forEach(function(col) {
      html += '<div class="col-toggle-item">' +
        '<input type="checkbox" id="col-toggle-' + col.id + '" ' + (col.is_visible ? 'checked' : '') +
        ' onchange="window.__ss.toggleColumn(' + col.id + ', this.checked)" />' +
        '<label for="col-toggle-' + col.id + '">' + escapeHtml(col.name) + '（' + escapeHtml(col.field_key) + '）</label>' +
        '</div>';
    });
    body.innerHTML = html;
    document.getElementById('columnModal').style.display = 'flex';
  }

  function closeColumnModal() {
    document.getElementById('columnModal').style.display = 'none';
  }

  function toggleColumn(colId, visible) {
    fetch('/api/spreadsheet/' + sheetId + '/column/' + colId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_visible: visible ? 1 : 0 })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        var col = columns.find(function(c) { return c.id === colId; });
        if (col) col.is_visible = visible ? 1 : 0;
        // 更新表头和表体的列显示
        document.querySelectorAll('th[data-col-id="' + colId + '"]').forEach(function(th) {
          th.classList.toggle('hidden-col', !visible);
        });
        loadData();
      } else {
        alert(res.error || '操作失败');
      }
    })
    .catch(function(err) { alert('操作失败: ' + err.message); });
  }

  // ============ 添加列 ============
  function openAddColumnModal() {
    document.getElementById('newColName').value = '';
    document.getElementById('newColKey').value = '';
    document.getElementById('newColType').value = 'text';
    document.getElementById('newColWidth').value = '150';
    document.getElementById('addColumnModal').style.display = 'flex';
  }

  function closeAddColumnModal() {
    document.getElementById('addColumnModal').style.display = 'none';
  }

  function submitAddColumn() {
    var name = document.getElementById('newColName').value.trim();
    var fieldKey = document.getElementById('newColKey').value.trim();
    var type = document.getElementById('newColType').value;
    var width = parseInt(document.getElementById('newColWidth').value, 10) || 150;

    if (!name || !fieldKey) { alert('列名称和字段标识不能为空'); return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldKey)) { alert('字段标识只能包含字母、数字和下划线，且不能以数字开头'); return; }

    fetch('/api/spreadsheet/' + sheetId + '/column', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, field_key: fieldKey, type: type, width: width })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        closeAddColumnModal();
        alert('列添加成功');
        // 重新加载页面以更新表头
        location.reload();
      } else {
        alert(res.error || '添加失败');
      }
    })
    .catch(function(err) { alert('添加失败: ' + err.message); });
  }

  // ============ 工具函数 ============
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  function escapeAttr(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 暴露全局方法供内联 onclick 调用
  window.__ss = {
    goToPage: goToPage,
    editRow: editRow,
    saveRowEdit: saveRowEdit,
    cancelRowEdit: cancelRowEdit,
    deleteRow: deleteRow,
    toggleColumn: toggleColumn,
    closeColumnModal: closeColumnModal,
    closeAddColumnModal: closeAddColumnModal,
    submitAddColumn: submitAddColumn
  };

  // DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
