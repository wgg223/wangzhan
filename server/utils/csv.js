/**
 * CSV 工具：导出序列化与导入解析
 * 作用：提供提示词库等数据的 CSV 导入/导出能力。
 * 遵循 RFC4180 标准处理含逗号、双引号、换行的字段：
 *   - 字段含特殊字符时用双引号包裹
 *   - 字段内的双引号用两个双引号转义（""）
 */

// 导出文件的固定表头（与提示词库结构对应）
const CSV_HEADERS = ['板块', '板块图标', '板块描述', '分类', '分类描述', '标题', '内容', '摘要', '排序', '启用'];

/**
 * 单个字段的 CSV 序列化
 * @param {*} value - 任意字段值
 * @returns {string} 安全的 CSV 字段文本
 * 规则：null/undefined 转空串；含逗号、双引号、换行的字段
 *       用双引号包裹，且内部双引号翻倍转义。
 */
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * 行数组 → CSV 文本
 * @param {Array<Array>} rows - 二维数组（每行是一组字段）
 * @returns {string} CSV 字符串（\r\n 换行，符合 Windows/Excel 习惯）
 */
function toCsv(rows) {
  return rows.map(function(row) {
    return row.map(csvField).join(',');   // 每行：字段逐个转义后用逗号连接
  }).join('\r\n');                        // 行与行之间用 CRLF 分隔
}

/**
 * CSV 文本 → 行数组（手工实现的解析器，无需第三方库）
 * @param {string} text - CSV 原文
 * @returns {Array<Array<string>>} 解析后的二维数组
 * 状态机说明：
 *   - inQuotes=true  表示当前处于引号包裹的字段内，只识别 "" 转义和收尾引号
 *   - inQuotes=false 表示字段外，遇到逗号切字段、换行切行、引号进入包裹态
 *   - \r\n 与 \n 均视为换行，\r\n 连续出现时只算一次
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {                       // 在引号包裹区内
      if (ch === '"') {
        if (text[i + 1] === '"') {        // "" 是转义的引号字符
          field += '"';
          i++;                            // 跳过下一个引号
        } else {
          inQuotes = false;               // 单个引号 = 包裹区结束
        }
      } else {
        field += ch;                      // 普通字符原样累积
      }
    } else if (ch === '"') {
      inQuotes = true;                    // 字段开头引号，进入包裹态
    } else if (ch === ',') {
      row.push(field);                    // 逗号结束一个字段
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;  // 跳过 CRLF 中的 LF
      row.push(field);                    // 换行结束当前行
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;                        // 普通字符
    }
  }
  // 处理最后一行（无换行结尾的情况）
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 去掉全空行（所有单元格都是空白的行）
  return rows.filter(function(r) { return r.some(function(c) { return c.trim() !== ''; }); });
}

// 导出 CSV 相关常量与函数
module.exports = {
  CSV_HEADERS,
  csvField,
  toCsv,
  parseCsv
};
