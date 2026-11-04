/**
 * 在线表格只读 HTML 渲染层（分享页 / 后台预览用，不依赖 Univer）
 *
 * 为什么单独写一层：分享页对公网开放，此前直接加载 Univer 引擎（约 14MB）把整份可编辑快照
 * 交给访客，只靠 setEditable(false) 约束。这一层改为服务端把快照排成静态表格 HTML，
 * 访客拿不到编辑器、也拿不到可编辑数据。
 *
 * 覆盖范围（只读预览需要的部分）：
 *   值 / 富文本段落、合并单元格、隐藏行列、列宽行高、字体（粗细下划删除线、字号、颜色、背景）、
 *   水平垂直对齐、自动换行、边框、数字格式（常用 pattern）。
 * 不覆盖：公式实时计算（用已保存的 v）、条件格式、数据验证、图表、图片、冻结窗格。
 */

const MAX_RENDER_ROWS = 3000;
const MAX_RENDER_COLS = 200;
const DEFAULT_COL_WIDTH = 88;
const DEFAULT_ROW_HEIGHT = 24;

// Univer 对齐枚举
const H_ALIGN = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify' };
const V_ALIGN = { 1: 'top', 2: 'middle', 3: 'bottom' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 颜色安全闸：只放行十六进制 / rgb(a) / 纯色名，避免把内容里的字符串当 CSS 值拼进 style */
function safeColor(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^rgba?\(\s*[\d.]+\s*(?:,\s*[\d.]+\s*){2,3}\s*\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return '';
}

/** 字体名安全闸：允许中文、字母、数字、空格与连字符；纯数字（Univer 的字体枚举 id）不当作字体名 */
function safeFont(value) {
  const v = String(value == null ? '' : value).trim();
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(v)) return '';
  return /^[\w -]{1,60}$/.test(v) ? v.replace(/\s+/g, ' ') : '';
}

/** 颜色：Univer 用 { rgb: '#RRGGBB' } 或 { rawCol: '1,2,3' } 包装 */
function colorOf(c) {
  if (!c) return '';
  if (typeof c === 'string') return safeColor(c);
  if (typeof c.rgb === 'string') return safeColor(c.rgb);
  if (typeof c.rawCol !== 'undefined') {
    const raw = String(c.rawCol);
    // rawCol 可能是 "1,2,3" 形式的十进制色值
    if (/^\d{1,3}(,\s*\d{1,3}){2}$/.test(raw)) return safeColor('rgb(' + raw + ')');
    return safeColor(raw);
  }
  return '';
}

/**
 * 数字格式：只做 Univer/xlsx 常见 pattern 的等价显示，识别不了就原样输出值
 * 支持：0 / 0.00 / #,##0(.00) / 百分比 / ¥$€ 前缀 / 日期占位（已是字符串则不动）
 */
function formatNumber(value, pattern) {
  if (value === '' || value === null || typeof value === 'undefined') return '';
  const num = Number(value);
  if (!isFinite(num)) return String(value);
  if (!pattern || pattern === 'General') return String(value);
  const p = String(pattern);
  const percent = p.includes('%');
  const prefixMatch = p.match(/^(?:_\("([^"]+)"\)|([¥$€£]))/);
  const prefix = prefixMatch ? (prefixMatch[1] || prefixMatch[2] || '') : '';
  let out;
  const decimalMatch = p.match(/\.(0+)/);
  const digits = decimalMatch ? decimalMatch[1].length : (percent ? 2 : 0);
  const grouped = /#,##0/.test(p);
  const base = percent ? num * 100 : num;
  out = base.toFixed(digits);
  if (grouped) {
    const parts = out.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    out = parts.join('.');
  }
  if (percent) out += '%';
  return prefix ? prefix + out : out;
}

/** 富文本段落 p.body → 纯文本（分享页只展示内容，不还原段内样式） */
function richText(body) {
  const runs = (body && body.textRuns) || [];
  return runs.map(r => String(r && r.text ? r.text : '')).join('');
}

/** 单元格显示值：优先富文本，其次 v（按数字格式渲染），公式没有已保存结果时留空 */
function cellValue(cell, styles) {
  if (!cell) return '';
  if (cell.p && cell.p.body) {
    const rt = richText(cell.p.body);
    if (rt) return rt;
  }
  if (cell.v === undefined || cell.v === null) return '';
  const style = resolveStyle(cell, styles);
  const pattern = style && style.n ? style.n.pattern : '';
  return formatNumber(cell.v, pattern);
}

/** 单元格样式：s 可以是样式 id（查 doc.styles）或直接内联对象 */
function resolveStyle(cell, styles) {
  const s = cell && cell.s;
  if (!s) return null;
  if (typeof s === 'string') return (styles && styles[s]) || null;
  if (typeof s === 'object') {
    // 内联样式可能按样式 id 分组（{ [id]: style }）
    const keys = Object.keys(s);
    if (keys.length === 1 && styles && styles[keys[0]]) return styles[keys[0]];
    return s;
  }
  return null;
}

/** 样式对象 → 内联 CSS */
function styleToCss(style) {
  if (!style) return '';
  const css = [];
  if (style.bl) css.push('font-weight:700');
  if (style.it) css.push('font-style:italic');
  const deco = [];
  if (style.ul && style.ul.u) deco.push('underline');
  if (style.st && style.st.s) deco.push('line-through');
  if (deco.length) css.push('text-decoration:' + deco.join(' '));
  if (style.fs) {
    const fs = Number(style.fs);
    if (isFinite(fs) && fs > 4 && fs <= 120) css.push('font-size:' + Math.round(fs * 1.34) + 'px');
  }
  const ff = safeFont(style.ff);
  if (ff) css.push('font-family:' + ff);
  const cl = colorOf(style.cl);
  if (cl) css.push('color:' + cl);
  const bg = colorOf(style.bg);
  if (bg) css.push('background-color:' + bg);
  const ht = H_ALIGN[style.ht];
  if (ht) css.push('text-align:' + ht);
  const vt = V_ALIGN[style.vt];
  if (vt) css.push('vertical-align:' + (vt === 'middle' ? 'middle' : vt));
  if (style.tb === 2) css.push('white-space:pre-wrap');
  else if (style.tb === 3) css.push('overflow:hidden');
  const bd = style.bd || {};
  [['t', 'top'], ['b', 'bottom'], ['l', 'left'], ['r', 'right']].forEach(pair => {
    const edge = bd[pair[0]];
    if (!edge || !edge.s) return;
    const color = colorOf(edge.c) || '#94a3b8';
    const dashed = edge.s === 3 || edge.s === 4 || edge.s === 6;
    css.push('border-' + pair[1] + ':' + (dashed ? '1px dashed ' : '1px solid ') + color);
  });
  return css.join(';');
}

/**
 * 渲染一个工作表
 * @param {object} sheet Univer worksheet
 * @param {object} styles doc.styles
 */
function renderSheet(sheet, styles) {
  const cellData = sheet.cellData || {};
  const columnData = sheet.columnData || {};
  const rowData = sheet.rowData || {};
  const rowKeys = Object.keys(cellData).map(Number).filter(n => isFinite(n));
  const colKeys = [];
  Object.keys(cellData).forEach(rk => {
    Object.keys(cellData[rk] || {}).forEach(ck => {
      const c = Number(ck);
      if (isFinite(c) && colKeys.indexOf(c) === -1) colKeys.push(c);
    });
  });

  let maxRow = rowKeys.length ? Math.max.apply(null, rowKeys) : -1;
  let maxCol = colKeys.length ? Math.max.apply(null, colKeys) : -1;
  // 显式设置过宽/高的列也要出现在表头里
  Object.keys(columnData).forEach(k => { const c = Number(k); if (isFinite(c) && c > maxCol) maxCol = c; });

  const warnings = [];
  let truncated = '';
  if (maxRow + 1 > MAX_RENDER_ROWS) { maxRow = MAX_RENDER_ROWS - 1; truncated = '行'; }
  if (maxCol + 1 > MAX_RENDER_COLS) { maxCol = MAX_RENDER_COLS - 1; truncated += (truncated ? '和' : '') + '列'; }
  if (truncated) warnings.push(`内容较多，仅显示前 ${truncated}`);

  // 合并：起点 → 跨度；被覆盖的格子跳过
  const mergeStart = {};
  const mergeSkip = {};
  (Array.isArray(sheet.mergeData) ? sheet.mergeData : []).forEach(m => {
    if (!m) return;
    mergeStart[m.startRow + ':' + m.startColumn] = {
      rowSpan: (m.endRow - m.startRow) + 1,
      colSpan: (m.endColumn - m.startColumn) + 1,
    };
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startColumn; c <= m.endColumn; c++) {
        if (r === m.startRow && c === m.startColumn) continue;
        mergeSkip[r + ':' + c] = 1;
      }
    }
  });

  const colWidth = (c) => {
    const entry = columnData[c] || columnData[String(c)] || {};
    if (entry.hd === 1) return 0;
    return Number(entry.w) || Number(sheet.defaultColumnWidth) || DEFAULT_COL_WIDTH;
  };

  let html = '<table class="sh-sheet"><colgroup>';
  for (let c = 0; c <= maxCol; c++) {
    const w = colWidth(c);
    if (!w) continue;
    html += `<col style="width:${Math.round(w)}px">`;
  }
  html += '</colgroup><thead><tr><th class="sh-corner"></th>';
  for (let c = 0; c <= maxCol; c++) {
    if ((columnData[c] || columnData[String(c)] || {}).hd === 1) continue;
    html += `<th class="sh-col">${esc(colName(c))}</th>`;
  }
  html += '</tr></thead><tbody>';

  let visibleRows = 0;
  for (let r = 0; r <= maxRow; r++) {
    const rowEntry = rowData[r] || rowData[String(r)] || {};
    if (rowEntry.hd === 1) continue;
    const h = Number(rowEntry.h) || Number(sheet.defaultRowHeight) || DEFAULT_ROW_HEIGHT;
    html += `<tr style="height:${Math.round(h)}px"><th class="sh-row">${esc(String(r + 1))}</th>`;
    for (let c = 0; c <= maxCol; c++) {
      if ((columnData[c] || columnData[String(c)] || {}).hd === 1) continue;
      const key = r + ':' + c;
      if (mergeSkip[key]) continue;
      const cell = (cellData[r] && cellData[r][c]) || null;
      const span = mergeStart[key];
      const style = resolveStyle(cell, styles);
      const attrs = [];
      if (span && span.colSpan > 1) attrs.push('colspan="' + span.colSpan + '"');
      if (span && span.rowSpan > 1) attrs.push('rowspan="' + span.rowSpan + '"');
      const css = styleToCss(style);
      if (css) attrs.push('style="' + css.replace(/"/g, '&quot;') + '"');
      const text = cellValue(cell, styles);
      html += `<td${attrs.length ? ' ' + attrs.join(' ') : ''}>${esc(text)}</td>`;
    }
    html += '</tr>';
    visibleRows++;
  }
  html += '</tbody></table>';

  if (!visibleRows) {
    return { html: '<p class="sh-empty">这个工作表是空的。</p>', warnings };
  }
  return { html, warnings };
}

/** 0 基列号 → A / B / … / AA */
function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * 渲染整个工作簿（只读）
 * @param {object} doc Univer IWorkbookData
 * @param {object} [options] { sheetId }
 * @returns {{ sheets: Array<{id: string, name: string, html: string}>, warnings: string[] }}
 */
function renderWorkbook(doc, options) {
  const o = options || {};
  if (!doc || !doc.sheets || !Array.isArray(doc.sheetOrder) || !doc.sheetOrder.length) {
    throw new Error('表格数据无效');
  }
  const styles = doc.styles || {};
  const warnings = [];
  const sheets = [];
  doc.sheetOrder.forEach(id => {
    const sheet = doc.sheets[id] || doc.sheets[String(id)];
    if (!sheet) return;
    if (sheet.hidden === 1) return; // 隐藏表不进分享页
    if (o.sheetId && String(id) !== String(o.sheetId)) return;
    const one = renderSheet(sheet, styles);
    (one.warnings || []).forEach(w => { if (warnings.indexOf(w) === -1) warnings.push(w); });
    sheets.push({ id: String(id), name: String(sheet.name || '未命名工作表'), html: one.html });
  });
  if (!sheets.length) throw new Error('没有可显示的工作表');
  return { sheets, warnings };
}

module.exports = { renderWorkbook, colName, formatNumber, styleToCss };
