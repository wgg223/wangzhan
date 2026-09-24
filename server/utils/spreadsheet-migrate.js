/**
 * Luckysheet → Univer 数据迁移工具
 * 将旧版 Luckysheet JSON 转换为 Univer IWorkbookData 快照。
 * 枚举数值与 @univerjs/core 1.0.0 保持一致：
 *   CellValueType: STRING=1 NUMBER=2 BOOLEAN=3 FORCE_STRING=4
 *   HorizontalAlign: LEFT=1 CENTER=2 RIGHT=3
 *   VerticalAlign: TOP=1 MIDDLE=2 BOTTOM=3
 *   WrapStrategy: OVERFLOW=1 CLIP=2 WRAP=3
 *   BorderStyleTypes: 与 Luckysheet 边框 style 数值一致（THIN=1 ... THICK=13）
 */
'use strict';

const CellValueType = { STRING: 1, NUMBER: 2, BOOLEAN: 3, FORCE_STRING: 4 };
const HorizontalAlign = { LEFT: 1, CENTER: 2, RIGHT: 3 };
const VerticalAlign = { TOP: 1, MIDDLE: 2, BOTTOM: 3 };
const WrapStrategy = { OVERFLOW: 1, CLIP: 2, WRAP: 3 };
const UNIVER_APP_VERSION = '1.0.0';

// Luckysheet → Univer 对齐映射
const HT_MAP = { 0: HorizontalAlign.LEFT, 1: HorizontalAlign.CENTER, 2: HorizontalAlign.RIGHT };
const VT_MAP = { 0: VerticalAlign.MIDDLE, 1: VerticalAlign.TOP, 2: VerticalAlign.BOTTOM };
const TB_MAP = { 0: WrapStrategy.CLIP, 1: WrapStrategy.OVERFLOW, 2: WrapStrategy.WRAP };

// 样式键固定顺序，保证去重稳定
const STYLE_KEY_ORDER = ['ff', 'fs', 'it', 'bl', 'st', 'cl', 'bg', 'bd', 'ht', 'vt', 'tb', 'n'];

function colorStyle(color) {
  if (typeof color !== 'string' || !color.trim()) return undefined;
  const c = color.trim();
  return { rgb: c };
}

function normalizeStyleKey(style) {
  const parts = [];
  for (const k of STYLE_KEY_ORDER) {
    if (style[k] !== undefined) parts.push(`${k}:${JSON.stringify(style[k])}`);
  }
  return parts.join('|');
}

/** 样式池：收集样式对象 → 去重 → styles 字典 + id 引用 */
class StylePool {
  constructor() {
    this._map = new Map(); // key -> styleId
    this.styles = {};
    this._next = 1;
  }

  register(style) {
    if (!style) return undefined;
    const key = normalizeStyleKey(style);
    if (!key) return undefined;
    let id = this._map.get(key);
    if (!id) {
      id = `s${this._next}`;
      this._next += 1;
      this.styles[id] = style;
      this._map.set(key, id);
    }
    return id;
  }
}

/** Luckysheet 单元格样式 → Univer IStyleData（不含边框，边框单独合并） */
function cellBaseStyle(lc) {
  const style = {};
  if (typeof lc.ff === 'string' && lc.ff) style.ff = lc.ff;
  if (typeof lc.fs === 'number' && lc.fs > 0) style.fs = lc.fs;
  if (Number(lc.it) === 1) style.it = 1;
  if (Number(lc.bl) === 1) style.bl = 1;
  if (Number(lc.cl) === 1) style.st = { s: 1 }; // Luckysheet cl = 删除线
  const cl = colorStyle(lc.fc);
  if (cl) style.cl = cl;
  const bg = colorStyle(lc.bg);
  if (bg) style.bg = bg;
  if (HT_MAP[lc.ht] !== undefined) style.ht = HT_MAP[lc.ht];
  if (VT_MAP[lc.vt] !== undefined) style.vt = VT_MAP[lc.vt];
  if (TB_MAP[lc.tb] !== undefined) style.tb = TB_MAP[lc.tb];
  // 数字格式（跳过 General）
  const fa = lc.ct && lc.ct.fa;
  if (typeof fa === 'string' && fa && fa !== 'General') style.n = { pattern: fa };
  return Object.keys(style).length ? style : undefined;
}

/** Luckysheet 单元格值 → {v, t, f} */
function cellValue(lc) {
  const out = {};
  const typeStr = lc.ct && lc.ct.t;
  let v = lc.v;

  if (typeof lc.f === 'string' && lc.f.trim()) {
    out.f = `=${lc.f.trim().replace(/^=/, '')}`;
  }

  if (v === undefined || v === null || v === '') {
    // 仅公式或仅样式单元格：无值
    return out.f ? out : out;
  }

  if (typeStr === 'b' || (typeStr === undefined && typeof v === 'boolean')) {
    out.t = CellValueType.BOOLEAN;
    out.v = v === true || v === 1 || String(v).toUpperCase() === 'TRUE';
  } else if (typeStr === 'n' || (typeStr === undefined && typeof v === 'number' && isFinite(v))) {
    const n = Number(v);
    out.t = CellValueType.NUMBER;
    out.v = n;
  } else {
    // 's' | 'str' | 'inlineStr' | 'd' | 其他
    out.t = CellValueType.STRING;
    out.v = String(v);
  }
  return out;
}

/** 冻结配置转换 */
function toFreeze(frozen) {
  const f = { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 };
  if (!frozen || !frozen.type || frozen.type === 'default' || frozen.type === 'normal') return f;
  const range = frozen.range || {};
  const rowFocus = Number(range.row_focus) || 0;
  const colFocus = Number(range.column_focus) || 0;
  if (frozen.type === 'row') {
    f.ySplit = 1; f.startRow = 1;
  } else if (frozen.type === 'column') {
    f.xSplit = 1; f.startColumn = 1;
  } else if (frozen.type === 'both') {
    f.ySplit = 1; f.startRow = 1; f.xSplit = 1; f.startColumn = 1;
  } else if (frozen.type === 'range' || frozen.type === 'custom') {
    f.ySplit = Math.max(1, rowFocus + 1); f.startRow = f.ySplit;
    f.xSplit = Math.max(1, colFocus + 1); f.startColumn = f.xSplit;
  }
  return f;
}

/** borderType → 每格需要绘制的边（考虑范围内外缘） */
function borderEdges(borderType, r, c, rs, re, cs, ce) {
  const edges = { t: false, b: false, l: false, r: false };
  const outer = { t: r === rs, b: r === re, l: c === cs, r: c === ce };
  const inner = { t: r > rs, b: r < re, l: c > cs, r: c < ce };
  switch (borderType) {
    case 'border-top': edges.t = true; break;
    case 'border-bottom': edges.b = true; break;
    case 'border-left': edges.l = true; break;
    case 'border-right': edges.r = true; break;
    case 'border-all':
    case 'border-full':
      edges.t = edges.b = edges.l = edges.r = true; break;
    case 'border-outside':
      edges.t = outer.t; edges.b = outer.b; edges.l = outer.l; edges.r = outer.r; break;
    case 'border-inside':
      edges.t = inner.t; edges.b = inner.b; edges.l = inner.l; edges.r = inner.r; break;
    case 'border-none':
    default: break;
  }
  return edges;
}

/**
 * 将 Luckysheet borderInfo 应用到边框收集器。
 * borders: Map "r_c" -> {t|r|b|l: {s, cl:{rgb}}}
 */
function applyBorderInfo(borders, info) {
  if (!info || !info.value) return;
  const val = info.value;
  const borderType = val.borderType || 'border-all';
  const borderStyle = Number(val.style);
  const color = colorStyle(val.color) || { rgb: '#000000' };
  if (!borderStyle) return; // 0 = none

  const setEdge = (r, c, rs, re, cs, ce) => {
    const edges = borderEdges(borderType, r, c, rs, re, cs, ce);
    const key = `${r}_${c}`;
    let bd = borders.get(key);
    if (!bd) { bd = {}; borders.set(key, bd); }
    for (const k of ['t', 'r', 'b', 'l']) {
      if (edges[k]) bd[k] = { s: borderStyle, cl: color };
    }
  };

  if (info.rangeType === 'cell') {
    const r = Number(val.row_index) || 0;
    const c = Number(val.col_index) || 0;
    setEdge(r, c, r, r, c, c);
  } else if (info.rangeType === 'range') {
    const ranges = Array.isArray(val.range) ? val.range : (val.range ? [val.range] : []);
    for (const rg of ranges) {
      let rs, re, cs, ce;
      if (Array.isArray(rg.row) && rg.row.length >= 2) {
        rs = Math.min(rg.row[0], rg.row[1]); re = Math.max(rg.row[0], rg.row[1]);
      } else {
        rs = re = Number(rg.row) || 0;
      }
      if (Array.isArray(rg.column) && rg.column.length >= 2) {
        cs = Math.min(rg.column[0], rg.column[1]); ce = Math.max(rg.column[0], rg.column[1]);
      } else {
        cs = ce = Number(rg.column) || 0;
      }
      for (let r = rs; r <= re; r++) {
        for (let c = cs; c <= ce; c++) setEdge(r, c, rs, re, cs, ce);
      }
    }
  }
}

/**
 * Luckysheet sheet 配置 → Univer IWorksheetData
 */
function toWorksheet(luckysheetSheet, sheetId, stylePool, borders, comments, stats) {
  const config = luckysheetSheet.config || {};
  const cellData = {};
  let maxRow = -1;
  let maxCol = -1;

  // 1. 单元格数据
  const celldata = Array.isArray(luckysheetSheet.celldata) ? luckysheetSheet.celldata : [];
  for (const item of celldata) {
    const r = Number(item.r);
    const c = Number(item.c);
    if (!isFinite(r) || !isFinite(c) || r < 0 || c < 0 || !item.v) continue;
    const lc = item.v;
    const cell = cellValue(lc);
    let style = cellBaseStyle(lc);
    const bd = borders.get(`${r}_${c}`);
    if (bd && Object.keys(bd).length) {
      if (!style) style = {};
      style.bd = bd;
    }
    const styleId = stylePool.register(style);
    const finalCell = {};
    if (cell.v !== undefined) { finalCell.v = cell.v; finalCell.t = cell.t; }
    if (cell.f) finalCell.f = cell.f;
    if (styleId) finalCell.s = styleId;
    if (Object.keys(finalCell).length) {
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = finalCell;
      stats.cells += 1;
    }
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;

    // 批注（Luckysheet ps）→ 待写入 spreadsheet_comments 表
    if (lc.ps && lc.ps.value && typeof lc.ps.value === 'string') {
      comments.push({ row: r, col: c, content: lc.ps.value, sheetName: luckysheetSheet.name });
    }
  }

  // 1b. 仅有边框的空格子：创建纯样式单元格
  for (const [key, bd] of borders) {
    if (!bd || !Object.keys(bd).length) continue;
    const pos = key.split('_');
    const r = Number(pos[0]);
    const c = Number(pos[1]);
    if (!isFinite(r) || !isFinite(c) || r < 0 || c < 0) continue;
    if (cellData[r] && cellData[r][c]) continue;
    const styleId = stylePool.register({ bd });
    if (styleId) {
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = { s: styleId };
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
  }

  // 2. 合并单元格（config.merge 为权威来源，兼容 mc 兜底）
  const mergeData = [];
  const mergeSet = new Set();
  const pushMerge = (r, c, rs, cs) => {
    const key = `${r}_${c}`;
    if (mergeSet.has(key) || rs <= 1 && cs <= 1) return;
    mergeSet.add(key);
    mergeData.push({
      startRow: r, endRow: r + rs - 1,
      startColumn: c, endColumn: c + cs - 1,
    });
  };
  if (config.merge && typeof config.merge === 'object') {
    for (const k of Object.keys(config.merge)) {
      const m = config.merge[k];
      pushMerge(Number(m.r) || 0, Number(m.c) || 0, Number(m.rs) || 1, Number(m.cs) || 1);
    }
  } else {
    for (const item of celldata) {
      const mc = item.v && item.v.mc;
      if (mc) pushMerge(Number(mc.r) || 0, Number(mc.c) || 0, Number(mc.rs) || 1, Number(mc.cs) || 1);
    }
  }

  // 3. 行列尺寸 / 隐藏
  const rowData = {};
  const columnData = {};
  if (config.rowlen && typeof config.rowlen === 'object') {
    for (const k of Object.keys(config.rowlen)) {
      const r = Number(k);
      if (!isFinite(r) || r < 0) continue;
      rowData[r] = { h: Number(config.rowlen[k]) || 24 };
      if (r > maxRow) maxRow = r;
    }
  }
  if (config.columnlen && typeof config.columnlen === 'object') {
    for (const k of Object.keys(config.columnlen)) {
      const c = Number(k);
      if (!isFinite(c) || c < 0) continue;
      columnData[c] = { w: Number(config.columnlen[k]) || 88 };
      if (c > maxCol) maxCol = c;
    }
  }
  if (config.rowhidden && typeof config.rowhidden === 'object') {
    for (const k of Object.keys(config.rowhidden)) {
      const r = Number(k);
      if (!isFinite(r) || r < 0) continue;
      rowData[r] = Object.assign({}, rowData[r], { hd: 1 });
    }
  }
  if (config.colhidden && typeof config.colhidden === 'object') {
    for (const k of Object.keys(config.colhidden)) {
      const c = Number(k);
      if (!isFinite(c) || c < 0) continue;
      columnData[c] = Object.assign({}, columnData[c], { hd: 1 });
    }
  }

  // 4. 尺寸（留余量，上限保护）
  const rowCount = Math.min(20000, Math.max(maxRow + 10, 100));
  const columnCount = Math.min(1000, Math.max(maxCol + 10, 20));

  return {
    id: sheetId,
    name: String(luckysheetSheet.name || 'Sheet').slice(0, 100),
    tabColor: '',
    hidden: Number(luckysheetSheet.hide) === 1 ? 1 : 0,
    freeze: toFreeze(config.frozen),
    rowCount,
    columnCount,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: Number(config.defaultColWidth) || 88,
    defaultRowHeight: Number(config.defaultRowHeight) || 24,
    mergeData,
    cellData,
    rowData,
    columnData,
    rowHeader: { width: 46 },
    columnHeader: { height: 20 },
    showGridlines: 1,
    rightToLeft: 0,
  };
}

/**
 * 主入口：Luckysheet JSON（数组）→ Univer IWorkbookData
 * 返回 { workbook, comments, stats }；解析失败返回 null
 */
function migrateLuckysheetToUniver(luckysheetJson) {
  let sheetsArr = luckysheetJson;
  if (typeof sheetsArr === 'string') {
    try { sheetsArr = JSON.parse(sheetsArr); } catch (e) { return null; }
  }
  if (!Array.isArray(sheetsArr) || sheetsArr.length === 0) return null;

  const stylePool = new StylePool();
  const comments = [];
  const stats = { sheets: 0, cells: 0 };
  const sheets = {};
  const sheetOrder = [];
  let activeSheetId = null;

  const sorted = sheetsArr.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  sorted.forEach((ls, i) => {
    if (!ls || typeof ls !== 'object') return;
    const sheetId = `sheet-${i + 1}`;
    // 边框先收集（可能引用 celldata 之外的格子）
    const borders = new Map();
    const borderInfo = ls.config && Array.isArray(ls.config.borderInfo) ? ls.config.borderInfo : [];
    for (const info of borderInfo) applyBorderInfo(borders, info);

    sheets[sheetId] = toWorksheet(ls, sheetId, stylePool, borders, comments, stats);
    sheetOrder.push(sheetId);
    if (Number(ls.status) === 1) activeSheetId = sheetId;
    stats.sheets += 1;
  });

  if (sheetOrder.length === 0) return null;

  return {
    workbook: {
      id: `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      rev: 1,
      name: 'workbook',
      appVersion: UNIVER_APP_VERSION,
      locale: 'zhCN',
      styles: stylePool.styles,
      sheetOrder,
      sheets,
      custom: activeSheetId ? { activeSheetId } : undefined,
    },
    comments,
    stats,
  };
}

/** 创建空白 Univer 文档 */
function createEmptyUniverDoc(name) {
  const sheet = {
    id: 'sheet-1',
    name: 'Sheet1',
    tabColor: '',
    hidden: 0,
    freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
    rowCount: 200,
    columnCount: 26,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 88,
    defaultRowHeight: 24,
    mergeData: [],
    cellData: {},
    rowData: {},
    columnData: {},
    rowHeader: { width: 46 },
    columnHeader: { height: 20 },
    showGridlines: 1,
    rightToLeft: 0,
  };
  return {
    id: `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    rev: 1,
    name: name || '未命名表格',
    appVersion: UNIVER_APP_VERSION,
    locale: 'zhCN',
    styles: {},
    sheetOrder: ['sheet-1'],
    sheets: { 'sheet-1': sheet },
  };
}

module.exports = { migrateLuckysheetToUniver, createEmptyUniverDoc };
