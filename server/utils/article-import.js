/**
 * 文章导入工具：把常见文件 / 在线文档转成文章正文 HTML
 *
 * 支持：
 *  - Markdown（.md/.markdown）：marked 渲染
 *  - 纯文本（.txt/.log）：按空行分段，段内换行转 <br>；自动识别 UTF-8 / GBK
 *  - HTML（.html/.htm）：白名单净化后使用
 *  - Word（.docx）：mammoth 转 HTML
 *  - 表格（.xlsx/.xls/.csv）：前若干行转表格
 *  - JSON（.json）：格式化后放代码块
 *  - 在线文档（Univer document JSON）：走 doc-renderer 的 IR 转标题/段落/列表/表格/图片
 */
'use strict';

const path = require('path');
const iconv = require('iconv-lite');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { marked } = require('marked');
const { sanitize } = require('./html-sanitizer');
const { buildDocumentIR } = require('./doc-renderer');

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_TABLE_ROWS = 300;
const MAX_TABLE_COLS = 30;

const FORMAT_BY_EXT = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.csv': 'csv',
  '.json': 'json'
};

const SUPPORTED_EXTENSIONS = Object.keys(FORMAT_BY_EXT);

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeText(buffer) {
  if (!buffer || !buffer.length) return '';
  // UTF-8 BOM
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  const asUtf8 = buffer.toString('utf8');
  // 含替换字符说明不是合法 UTF-8，按 GBK 再试一次（国内文档常见）
  if (asUtf8.indexOf('\uFFFD') === -1) return asUtf8;
  try {
    const asGbk = iconv.decode(buffer, 'gbk');
    if (asGbk.indexOf('\uFFFD') === -1) return asGbk;
  } catch (err) {
    // ignore
  }
  return asUtf8;
}

function textToHtml(text) {
  const blocks = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return '';
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function sheetToHtml(workbook) {
  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) return '';
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) return '';
  const clipped = rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, MAX_TABLE_COLS));
  const head = clipped[0] || [];
  const body = clipped.slice(1);
  const th = head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
  const tbody = body
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  const note = rows.length > MAX_TABLE_ROWS
    ? `<p><em>（表格共 ${rows.length} 行，已截取前 ${MAX_TABLE_ROWS} 行）</em></p>`
    : '';
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${tbody}\n</tbody></table>${note}`;
}

function jsonToHtml(buffer) {
  const raw = decodeText(buffer);
  let pretty = raw;
  try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch (err) { /* 保留原文 */ }
  return `<pre><code>${escapeHtml(pretty)}</code></pre>`;
}

function titleFromFilename(filename) {
  const base = path.basename(String(filename || ''));
  const name = base.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  return name.slice(0, 100);
}

/**
 * 文件 → { title, html, format }
 * @param {{ buffer: Buffer, filename: string }} file
 */
async function fileToArticle(file) {
  const filename = file && file.filename ? file.filename : '';
  const ext = path.extname(filename).toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    const err = new Error(`不支持的文件格式 ${ext || '（无扩展名）'}；支持：${SUPPORTED_EXTENSIONS.join('、')}`);
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }
  const buffer = file.buffer || Buffer.alloc(0);
  if (!buffer.length) throw new Error('文件内容为空');
  if (buffer.length > MAX_IMPORT_BYTES) throw new Error('文件超过 20MB 限制');

  let html = '';
  if (format === 'markdown') {
    html = sanitize(marked.parse(decodeText(buffer)));
  } else if (format === 'text') {
    html = textToHtml(decodeText(buffer));
  } else if (format === 'html') {
    html = sanitize(decodeText(buffer));
  } else if (format === 'docx') {
    const result = await mammoth.convertToHtml({ buffer });
    html = sanitize(result.value || '');
  } else if (format === 'xlsx') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    html = sanitize(sheetToHtml(workbook));
  } else if (format === 'csv') {
    // CSV 按文本解码（兼容 GBK），再交给 xlsx 解析，避免中文乱码
    const workbook = XLSX.read(decodeText(buffer), { type: 'string' });
    html = sanitize(sheetToHtml(workbook));
  } else if (format === 'json') {
    html = sanitize(jsonToHtml(buffer));
  }

  if (!html || !html.trim()) throw new Error('没有从文件中解析出可用内容');
  return { title: titleFromFilename(filename), html, format };
}

// ============ 在线文档（Univer document JSON）→ HTML ============

function renderRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) return '';
  return runs.map((run) => {
    let text = escapeHtml(run.text);
    const style = run.style || {};
    if (style.bold) text = `<strong>${text}</strong>`;
    if (style.italic) text = `<em>${text}</em>`;
    if (style.underline) text = `<u>${text}</u>`;
    if (style.strikethrough) text = `<s>${text}</s>`;
    return text;
  }).join('');
}

function renderTable(block) {
  const data = block.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) return '';
  const toCellHtml = (cell, tag) => {
    const rowSpan = cell && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
    const colSpan = cell && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
    return `<${tag}${rowSpan}${colSpan}>${escapeHtml(cell && cell.text)}</${tag}>`;
  };
  const head = rows[0] ? `<thead><tr>${(rows[0].cells || []).map((c) => toCellHtml(c, 'th')).join('')}</tr></thead>` : '';
  const body = rows.slice(1)
    .map((row) => `<tr>${(row.cells || []).map((c) => toCellHtml(c, 'td')).join('')}</tr>`)
    .join('\n');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function renderParagraph(block) {
  const style = block.paragraphStyle || {};
  const level = Number(style.headingLevel) || 0;
  const inner = renderRuns(block.runs);
  const text = inner || '';
  if (!text.trim()) return '<p><br></p>';
  if (level >= 1 && level <= 4) return `<h${level}>${text}</h${level}>`;
  if (style.listType) return `<ul><li>${text}</li></ul>`;
  return `<p>${text}</p>`;
}

/**
 * 在线文档 JSON → 文章 HTML
 * @param {object} docJson Univer 文档 JSON（doc_type=document）
 */
function univerDocumentToHtml(docJson) {
  if (!docJson || typeof docJson !== 'object') throw new Error('文档内容为空或格式不正确');
  const ir = buildDocumentIR(docJson);
  const blocks = [];
  (ir.sections || []).forEach((section) => {
    (section.blocks || []).forEach((block) => {
      if (!block) return;
      if (block.type === 'paragraph') {
        blocks.push(renderParagraph(block));
      } else if (block.type === 'table') {
        blocks.push(renderTable(block));
      } else if (block.type === 'image') {
        const src = block.data && block.data.src;
        if (src) blocks.push(`<p><img src="${escapeHtml(src)}" alt="${escapeHtml(block.data.alt || '')}" loading="lazy"></p>`);
      }
    });
  });
  const html = sanitize(blocks.join('\n'));
  if (!html.trim()) throw new Error('文档里没有可导入的正文内容');
  return html;
}

module.exports = {
  MAX_IMPORT_BYTES,
  SUPPORTED_EXTENSIONS,
  FORMAT_BY_EXT,
  fileToArticle,
  univerDocumentToHtml,
  titleFromFilename
};
