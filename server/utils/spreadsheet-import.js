/**
 * 在线表格导入共享工具
 * 供前台 server/routes/spreadsheet.js 与后台 server/routes/admin/spreadsheets.js 复用：
 *   - CSV / XLSX 统一解析与表头自动检测
 *   - CSV 中文编码（UTF-8 / GBK）自动识别、分隔符（逗号 / 分号 / Tab）自动检测
 *   - 表头 → field_key 转换、Excel 日期序列号转换
 */
const iconv = require('iconv-lite');
const XLSX = require('xlsx');

// Excel日期序列号转日期字符串（1900日期系统，1900-01-01 对应 1）
function excelDateToString(value) {
  if (typeof value !== 'number' || value < 20000 || value > 80000) return null;
  try {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  } catch (e) {
    return null;
  }
}

// 处理单元格值：日期序列号转日期字符串、其余转字符串
function processCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const dateStr = excelDateToString(value);
    if (dateStr) return dateStr;
  }
  return String(value);
}

// 自动检测表头行：第一行非空列过少时视为标题行，使用第二行
function detectHeaderRow(rows) {
  if (rows.length === 0) return 0;
  const firstRow = rows[0];
  const totalCols = firstRow.length;
  const nonEmptyCols = firstRow.filter(function(c) { return String(c).trim() !== ''; }).length;

  // 条件1：第一行非空列比例很低（<40%），认为是标题行
  if (totalCols >= 2 && nonEmptyCols / totalCols < 0.4 && rows.length > 1) {
    return 1;
  }

  // 条件2：第一行只有1列有值，且第二行有更多列有值，认为是标题行
  if (nonEmptyCols <= 1 && rows.length > 1) {
    const secondRowNonEmpty = rows[1].filter(function(c) { return String(c).trim() !== ''; }).length;
    if (secondRowNonEmpty > nonEmptyCols) {
      return 1;
    }
  }

  return 0;
}

// 将表头转换为合法的 field_key（自动去重）
function toFieldKey(header, existingKeys, idx) {
  let key = String(header).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) {
    key = 'col_' + (idx + 1);
  }
  let finalKey = key;
  let counter = 1;
  while (existingKeys.has(finalKey)) {
    finalKey = key + '_' + counter++;
  }
  existingKeys.add(finalKey);
  return finalKey;
}

// 简易 CSV 解析器（支持引号包裹、自定义分隔符、\r\n / \n 换行）
function parseCSV(text, delimiter) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 移除 BOM
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue;
    }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  // 移除全空行
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// 自动检测 CSV 分隔符：统计前几行中各候选分隔符出现次数，取最多者
function detectDelimiter(text) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  const lines = text.split(/\r?\n/);
  const sampleLines = lines.slice(0, Math.min(lines.length, 4));
  sampleLines.forEach(function(line) {
    candidates.forEach(function(d) {
      const count = line.split(d).length - 1;
      if (count > bestCount) { bestCount = count; best = d; }
    });
  });
  return best;
}

// 解码导入文件缓冲区：UTF-8（含 BOM）优先，GBK 回退（中文 Excel/记事本导出常见编码）
function decodeFileBuffer(buffer) {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { text: buffer.slice(3).toString('utf-8'), encoding: 'utf-8' };
  }
  // 尝试 UTF-8 严格解码：解码后再编码，若字节完全一致则说明是合法 UTF-8
  try {
    const text = iconv.decode(buffer, 'utf-8');
    if (iconv.encode(text, 'utf-8').equals(buffer)) {
      return { text: text, encoding: 'utf-8' };
    }
  } catch (e) { /* 继续走 GBK 回退 */ }
  return { text: iconv.decode(buffer, 'gbk'), encoding: 'gbk' };
}

// 统一解析导入文件，返回 { headers, dataRows, headerRowIdx, encoding, delimiter, format }
function parseImportFile(file) {
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  let rawRows;
  let encoding = 'utf-8';
  let delimiter = ',';
  let format = ext;

  if (ext === 'csv') {
    const decoded = decodeFileBuffer(file.buffer);
    encoding = decoded.encoding;
    delimiter = detectDelimiter(decoded.text);
    rawRows = parseCSV(decoded.text, delimiter);
  } else if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new Error('Excel 文件中没有工作表');
    const worksheet = workbook.Sheets[firstSheetName];
    rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
    format = ext;
  } else {
    throw new Error('不支持的文件格式，请上传 CSV 或 XLSX 文件');
  }

  if (rawRows.length === 0) throw new Error('文件为空');

  // 自动检测表头行
  const headerRowIdx = detectHeaderRow(rawRows);
  const headers = rawRows[headerRowIdx].map(function(h) { return processCellValue(h).trim(); });
  const dataRows = rawRows.slice(headerRowIdx + 1).filter(function(r) {
    return r.some(function(c) { return processCellValue(c).trim() !== ''; });
  });

  return { headers: headers, dataRows: dataRows, headerRowIdx: headerRowIdx, encoding: encoding, delimiter: delimiter, format: format };
}

module.exports = {
  excelDateToString,
  processCellValue,
  detectHeaderRow,
  toFieldKey,
  parseCSV,
  detectDelimiter,
  decodeFileBuffer,
  parseImportFile
};
