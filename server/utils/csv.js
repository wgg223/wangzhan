/**
 * CSV 工具：导出序列化与导入解析
 * 处理含逗号、双引号、换行的字段（标准 RFC4180 引号包裹）
 */

const CSV_HEADERS = ['板块', '板块图标', '板块描述', '分类', '分类描述', '标题', '内容', '摘要', '排序', '启用'];

function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsv(rows) {
  return rows.map(function(row) {
    return row.map(csvField).join(',');
  }).join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 去掉全空行
  return rows.filter(function(r) { return r.some(function(c) { return c.trim() !== ''; }); });
}

module.exports = {
  CSV_HEADERS,
  csvField,
  toCsv,
  parseCsv
};
