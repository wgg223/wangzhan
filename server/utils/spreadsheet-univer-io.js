/**
 * Univer 文档导入/导出工具
 * - importBufferToUniverDoc(buffer, filename, docName) —— .xlsx/.csv 文件 → Univer IWorkbookData
 * - exportUniverDoc(univerDoc, format, options) —— Univer IWorkbookData → xlsx buffer / csv 字符串
 * 说明：xlsx 社区版不读写单元格样式，导入导出保留 值/公式/合并/列宽/行高/数字格式。
 */
'use strict';
const XLSX = require('xlsx');
const { decodeFileBuffer, parseCSV, detectDelimiter } = require('./spreadsheet-import');

const CellValueType = { STRING: 1, NUMBER: 2, BOOLEAN: 3 };

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date → 'YYYY-MM-DD HH:mm:ss'（无时间部分仅日期） */
function dateToString(d) {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return date;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function newSheetBase(sheetId, name) {
  return {
    id: sheetId,
    name: String(name || `Sheet${sheetId}`).slice(0, 100),
    tabColor: '',
    hidden: 0,
    freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
    rowCount: 100,
    columnCount: 20,
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
}

// ============ 导入 ============

/**
 * xlsx worksheet 对象 → Univer worksheet 数据
 * @param {object} worksheet xlsx 工作表对象
 * @param {string} name 工作表名称（来自 SheetNames）
 */
function xlsxSheetToUniver(worksheet, name) {
  const sheet = newSheetBase('sheet-1', name || 'Sheet1');
  if (!worksheet['!ref']) return sheet;

  const range = XLSX.utils.decode_range(worksheet['!ref']);
  let maxRow = -1;
  let maxCol = -1;
  const cellData = {};
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[addr];
      if (!cell || cell.v === undefined || cell.v === null) continue;
      const out = {};
      if (typeof cell.f === 'string' && cell.f) {
        out.f = `=${cell.f.replace(/^=/, '')}`;
      }
      if (cell.t === 'n') {
        out.t = CellValueType.NUMBER;
        out.v = Number(cell.v);
      } else if (cell.t === 'b') {
        out.t = CellValueType.BOOLEAN;
        out.v = Boolean(cell.v);
      } else if (cell.v instanceof Date) {
        out.t = CellValueType.STRING;
        out.v = dateToString(cell.v);
      } else {
        out.t = CellValueType.STRING;
        out.v = String(cell.v);
      }
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = out;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
  }
  sheet.cellData = cellData;
  sheet.rowCount = Math.min(20000, Math.max(maxRow + 10, 100));
  sheet.columnCount = Math.min(1000, Math.max(maxCol + 10, 20));

  // 合并单元格
  if (Array.isArray(worksheet['!merges'])) {
    sheet.mergeData = worksheet['!merges'].map(m => ({
      startRow: m.s.r, endRow: m.e.r,
      startColumn: m.s.c, endColumn: m.e.c,
    }));
  }
  // 列宽 / 行高 / 隐藏（xlsx 读回可能给出 wpx/wch/width、hpx/hpt，做全量回退）
  if (Array.isArray(worksheet['!cols'])) {
    const columnData = {};
    worksheet['!cols'].forEach((col, i) => {
      if (!col) return;
      let w;
      if (typeof col.wpx === 'number' && col.wpx > 0) w = col.wpx;
      else if (typeof col.wch === 'number' && col.wch > 0) w = col.wch * 8;
      else if (typeof col.width === 'number' && col.width > 0) w = col.width * 8;
      const entry = {};
      if (w) entry.w = Math.round(w);
      if (col.hidden) entry.hd = 1;
      if (Object.keys(entry).length) columnData[i] = entry;
    });
    sheet.columnData = columnData;
  }
  if (Array.isArray(worksheet['!rows'])) {
    const rowData = {};
    worksheet['!rows'].forEach((row, i) => {
      if (!row) return;
      let h;
      if (typeof row.hpx === 'number' && row.hpx > 0) h = row.hpx;
      else if (typeof row.hpt === 'number' && row.hpt > 0) h = row.hpt * 4 / 3;
      const entry = {};
      if (h) entry.h = Math.round(h);
      if (row.hidden) entry.hd = 1;
      if (Object.keys(entry).length) rowData[i] = entry;
    });
    sheet.rowData = rowData;
  }
  return sheet;
}

/**
 * CSV 二维数组（字符串）→ Univer worksheet 数据（数字/布尔自动推断）
 */
function csvRowsToUniver(rows, sheetName) {
  const sheet = newSheetBase('sheet-1', sheetName || 'Sheet1');
  const cellData = {};
  let maxRow = -1;
  let maxCol = -1;
  rows.forEach((row, r) => {
    row.forEach((raw, c) => {
      const s = String(raw).trim();
      if (s === '') return;
      let cell;
      if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) {
        cell = { t: CellValueType.NUMBER, v: Number(s) };
      } else if (/^(true|false)$/i.test(s)) {
        cell = { t: CellValueType.BOOLEAN, v: s.toLowerCase() === 'true' };
      } else {
        cell = { t: CellValueType.STRING, v: s };
      }
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = cell;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    });
  });
  sheet.cellData = cellData;
  sheet.rowCount = Math.min(20000, Math.max(maxRow + 10, 100));
  sheet.columnCount = Math.min(1000, Math.max(maxCol + 10, 20));
  return sheet;
}

/**
 * 导入文件 → Univer 文档
 * @param {Buffer} buffer 文件缓冲
 * @param {string} filename 原始文件名（取扩展名）
 * @param {string} docName 文档名称
 * @returns {{ workbook: object, stats: { sheets: number, cells: number } }}
 */
function importBufferToUniverDoc(buffer, filename, docName) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
  const sheets = {};
  const sheetOrder = [];
  let cells = 0;

  if (ext === 'csv') {
    const decoded = decodeFileBuffer(buffer);
    const delimiter = detectDelimiter(decoded.text);
    const rows = parseCSV(decoded.text, delimiter);
    if (rows.length === 0) throw new Error('文件为空');
    const sheet = csvRowsToUniver(rows, 'Sheet1');
    sheets['sheet-1'] = sheet;
    sheetOrder.push('sheet-1');
    for (const rowKey of Object.keys(sheet.cellData)) {
      cells += Object.keys(sheet.cellData[rowKey]).length;
    }
  } else if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: true, cellStyles: true });
    if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('Excel 文件中没有工作表');
    wb.SheetNames.forEach((name, i) => {
      const sheetId = `sheet-${i + 1}`;
      const sheet = xlsxSheetToUniver(wb.Sheets[name], name);
      sheet.id = sheetId;
      sheets[sheetId] = sheet;
      sheetOrder.push(sheetId);
      for (const rowKey of Object.keys(sheet.cellData)) {
        cells += Object.keys(sheet.cellData[rowKey]).length;
      }
    });
  } else {
    throw new Error('不支持的文件格式，请上传 .xlsx 或 .csv 文件');
  }

  return {
    workbook: {
      id: `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      rev: 1,
      name: docName || '导入的表格',
      appVersion: '1.0.0',
      locale: 'zhCN',
      styles: {},
      sheetOrder,
      sheets,
    },
    stats: { sheets: sheetOrder.length, cells },
  };
}

// ============ 导出 ============

/**
 * Univer worksheet → xlsx worksheet（值 + 公式 + 合并 + 列宽 + 行高 + 数字格式）
 */
function univerSheetToXlsx(univerSheet, styles) {
  const cellData = univerSheet.cellData || {};
  let maxRow = -1;
  let maxCol = -1;
  const formulas = {};
  const numfmts = {};
  const aoa = [];

  const rowKeys = Object.keys(cellData);
  for (const rk of rowKeys) {
    const r = Number(rk);
    for (const ck of Object.keys(cellData[rk])) {
      const c = Number(ck);
      const cell = cellData[rk][ck];
      if (!cell) continue;
      let value;
      if (typeof cell.v !== 'undefined' && cell.v !== null) {
        value = cell.v;
      } else if (cell.f) {
        value = 0; // 公式占位，避免空引用
      } else {
        continue;
      }
      if (!aoa[r]) aoa[r] = [];
      aoa[r][c] = value;
      if (typeof cell.f === 'string' && cell.f) {
        formulas[XLSX.utils.encode_cell({ r, c })] = cell.f.replace(/^=/, '');
      }
      // 数字格式（跳过 General）
      const styleId = typeof cell.s === 'string' ? cell.s : null;
      const style = styleId && styles ? styles[styleId] : null;
      if (style && style.n && style.n.pattern && style.n.pattern !== 'General') {
        numfmts[XLSX.utils.encode_cell({ r, c })] = style.n.pattern;
      }
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['']]);
  for (const addr of Object.keys(formulas)) {
    if (ws[addr]) ws[addr].f = formulas[addr];
  }
  for (const addr of Object.keys(numfmts)) {
    if (ws[addr]) ws[addr].z = numfmts[addr];
  }

  // 合并
  if (Array.isArray(univerSheet.mergeData) && univerSheet.mergeData.length) {
    ws['!merges'] = univerSheet.mergeData.map(m => ({
      s: { r: m.startRow, c: m.startColumn },
      e: { r: m.endRow, c: m.endColumn },
    }));
  }
  // 列宽 / 行高
  const columnData = univerSheet.columnData || {};
  const colKeys = Object.keys(columnData);
  if (colKeys.length) {
    const maxC = colKeys.reduce((m, k) => Math.max(m, Number(k)), 0);
    ws['!cols'] = [];
    for (let i = 0; i <= maxC; i++) {
      const col = columnData[i] || columnData[String(i)];
      ws['!cols'][i] = col && col.w ? { wpx: col.w } : { wpx: 88 };
    }
  }
  const rowData = univerSheet.rowData || {};
  const rowKeys2 = Object.keys(rowData);
  if (rowKeys2.length) {
    const maxR = rowKeys2.reduce((m, k) => Math.max(m, Number(k)), 0);
    ws['!rows'] = [];
    for (let i = 0; i <= maxR; i++) {
      const row = rowData[i] || rowData[String(i)];
      ws['!rows'][i] = row && row.h ? { hpx: row.h } : { hpx: 24 };
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxRow, 0), c: Math.max(maxCol, 0) } });
  return ws;
}

/**
 * 导出 Univer 文档
 * @param {object} univerDoc IWorkbookData
 * @param {'xlsx'|'csv'} format
 * @param {{ sheetId?: string }} options csv 时可指定 sheet（默认第一个）
 * @returns {{ buffer: Buffer|string, mime: string, ext: string, sheetCount: number, sheetId?: string }}
 */
function exportUniverDoc(univerDoc, format, options = {}) {
  if (!univerDoc || !univerDoc.sheets || !Array.isArray(univerDoc.sheetOrder) || univerDoc.sheetOrder.length === 0) {
    throw new Error('文档数据无效');
  }
  const styles = univerDoc.styles || {};

  if (format === 'csv') {
    const sheetId = options.sheetId && univerDoc.sheets[options.sheetId]
      ? options.sheetId
      : univerDoc.sheetOrder[0];
    const ws = univerSheetToXlsx(univerDoc.sheets[sheetId], styles);
    const csv = XLSX.utils.sheet_to_csv(ws);
    return { buffer: '\uFEFF' + csv, mime: 'text/csv; charset=utf-8', ext: 'csv', sheetId };
  }

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const usedNames = new Set();
    univerDoc.sheetOrder.forEach((sheetId) => {
      const sheet = univerDoc.sheets[sheetId];
      if (!sheet) return;
      const ws = univerSheetToXlsx(sheet, styles);
      let name = String(sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
      let n = 1;
      while (usedNames.has(name)) {
        name = `${String(sheet.name || 'Sheet').slice(0, 28)}_${n}`;
        n += 1;
      }
      usedNames.add(name);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', compression: true });
    return { buffer, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', sheetCount: wb.SheetNames.length };
  }

  throw new Error('不支持的导出格式');
}

module.exports = { importBufferToUniverDoc, exportUniverDoc };
