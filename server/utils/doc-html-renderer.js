/**
 * 文档 HTML 渲染器：把 IR 转换为可打印/可导出的 HTML
 * 用于：导出 HTML、打印预览、阅读视图
 *
 * 功能：
 *   - 富文本样式（加粗/斜体/下划线/删除线/颜色/字号/字体）
 *   - 超链接渲染
 *   - 图片内联为 data URI（离线可用）
 *   - 表格渲染（合并单元格、边框）
 *   - 页眉/页脚
 *   - 页码
 *   - 目录（自动生成）
 *   - 脚注
 *   - 分栏布局
 *   - 列表（有序/无序）
 *   - 打印优化 CSS（@page 规则）
 *   - 阅读模式
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildDocumentIR, esc, num } = require('./doc-renderer');

/** 数值型样式属性必须夹到合法区间：直接插进 style="...pt" 会被字符串值撑破属性 */
function clampPt(v, fallback) {
  return Math.max(1, Math.min(4000, num(v, fallback)));
}

function clampLevel(v) {
  return Math.max(1, Math.min(6, num(v, 1)));
}

let _publicDir;
function getPublicDir() {
  if (_publicDir) return _publicDir;
  try { _publicDir = require('../config/app-root').publicDir; } catch (e) { /* ignore */ }
  if (!_publicDir) _publicDir = path.join(__dirname, '..', '..', 'public');
  return _publicDir;
}

/**
 * 读取本地图片文件（安全路径限制）
 */
function readLocalFile(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  if (!/^\/(uploads|images|assets)\//.test(clean)) return null;
  const publicDir = getPublicDir();
  const abs = path.join(publicDir, path.normalize(clean).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(path.resolve(publicDir))) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(abs);
  } catch (e) {
    return null;
  }
}

function extOfUrl(url) {
  const ext = (String(url || '').split('.').pop() || '').split('?')[0].toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext) ? ext : 'png';
}

/**
 * 创建 HTML 媒体处理器（图片内联为 data URI）
 */
function createHtmlMedia() {
  const cache = new Map();
  const MAX_TOTAL = 24 * 1024 * 1024;
  let total = 0;
  let skipped = 0;
  return {
    url(src) {
      const s = String(src || '');
      if (!s) return '';
      if (/^data:/i.test(s)) return s;
      if (/^https?:\/\//i.test(s)) return s;
      const hit = cache.get(s);
      if (hit !== undefined) return hit;
      const buffer = readLocalFile(s);
      let out = s;
      if (buffer && total + buffer.length <= MAX_TOTAL) {
        total += buffer.length;
        out = `data:image/${extOfUrl(s)};base64,${buffer.toString('base64')}`;
      } else {
        skipped += 1;
      }
      cache.set(s, out);
      return out;
    },
    get skipped() { return skipped; }
  };
}

/**
 * 渲染文档为 HTML
 * @param {object} doc - Univer Docs 快照
 * @param {object} [options] - { name, readingMode, includeToc, format, orientation, publicDir }
 * @returns {{html, warnings}}
 */
function renderDocToHtml(doc, options) {
  const o = options || {};
  if (o.publicDir) _publicDir = o.publicDir;
  const ir = buildDocumentIR(doc);
  const warnings = [...(ir.warnings || [])];
  const media = createHtmlMedia();
  const title = esc(o.name || doc.name || '文档');

  const css = buildCSS(o, ir);
  let body = '';

  ir.sections.forEach((section, idx) => {
    body += renderSection(section, idx, ir, o, media, warnings);
  });

  if (media.skipped) {
    warnings.push(`${media.skipped} 张图片无法内联（文件不存在或超出大小限制）`);
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style></head>
<body class="${o.readingMode ? 'reading-mode' : 'print-mode'}">
<div class="doc-container">
${body}
</div>
${o.includeFootnotes !== false ? renderFootnotesSection(ir) : ''}
</body></html>`;

  return { html, warnings };
}

/**
 * 流式渲染：把文档拆成「每个 block 一段 HTML」，供前端按 A4 页面高度实测分页
 * 与 renderDocToHtml 的区别：这里不生成 .doc-page，页面盒子交给渲染端测量后创建
 * @returns {{css, sections, warnings}}
 */
function renderDocFlow(doc, options) {
  const o = options || {};
  if (o.publicDir) _publicDir = o.publicDir;
  const ir = buildDocumentIR(doc);
  const warnings = [...(ir.warnings || [])];
  const media = createHtmlMedia();

  const sections = ir.sections.map((section, idx) => {
    const props = section.properties;
    const blocks = [];
    if (o.includeToc && idx === 0 && ir.toc.length > 0) {
      blocks.push(renderToc(ir.toc));
    }
    section.blocks.forEach(block => {
      const html = renderBlock(block, ir, o, media, warnings);
      if (html) blocks.push(html);
    });
    const colCount = (props.columns || []).length > 1 ? props.columns.length : 1;
    return {
      index: idx,
      pageWidthPt: num(props.pageSize.width, 595),
      pageHeightPt: num(props.pageSize.height, 842),
      margins: {
        top: num(props.margins.top, 72),
        right: num(props.margins.right, 90),
        bottom: num(props.margins.bottom, 72),
        left: num(props.margins.left, 90),
      },
      columns: colCount,
      pageNumberStart: num(props.pageNumberStart, 1),
      header: flowHeaderFooter(section.header, 'header'),
      footer: flowHeaderFooter(section.footer, 'footer'),
      blocks,
    };
  });

  if (media.skipped) {
    warnings.push(`${media.skipped} 张图片无法内联（文件不存在或超出大小限制）`);
  }

  // 大纲：锚点 id 与 renderBlock 里标题上的 toc-anchor-N 一致，供导航窗格跳转
  const toc = ir.toc.map((item, i) => ({
    level: num(item.level, 1),
    text: item.text,
    anchor: 'toc-anchor-' + i,
  }));

  return { css: buildCSS({ readingMode: Boolean(o.readingMode) }, ir), sections, toc, warnings };
}

/** 页眉/页脚模板：保留 {PAGE} / {NUMPAGES} 占位符，由前端按实际页码替换 */
function flowHeaderFooter(hf, type) {
  const enabled = Boolean(hf && hf.enabled);
  let text = (hf && hf.content) || '';
  if (!enabled) {
    return type === 'footer'
      ? { enabled: true, text: '第 {PAGE} 页 / 共 {NUMPAGES} 页' }
      : { enabled: false, text: '' };
  }
  if (!text && type === 'footer') text = '第 {PAGE} 页';
  return { enabled: true, text };
}

/**
 * 构建 CSS 样式
 */
function buildCSS(o, ir) {
  const readingMode = o.readingMode;
  return `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: ${readingMode ? '#faf9f6' : '#f5f5f5'};
  font-family: "Microsoft YaHei", "SimSun", "PingFang SC", serif;
  color: #333;
  line-height: 1.8;
  ${readingMode ? 'font-size: 16px;' : ''}
}
.doc-container {
  max-width: ${readingMode ? '720px' : '210mm'};
  margin: ${readingMode ? '0 auto' : '20px auto'};
  background: #fff;
  ${readingMode ? 'padding: 40px 48px;' : 'box-shadow: 0 2px 8px rgba(0,0,0,0.1);'}
}
.doc-page {
  position: relative;
  ${readingMode ? '' : 'min-height: 297mm;'}
  ${readingMode ? '' : 'page-break-after: always;'}
  margin-bottom: ${readingMode ? '0' : '20px'};
  ${readingMode ? '' : 'border: 1px solid #e0e0e0;'}
}
${readingMode ? '.doc-page { border: none; min-height: auto; }' : ''}

/* 页眉 */
.doc-header {
  position: ${readingMode ? 'relative' : 'absolute'};
  top: 0; left: 0; right: 0;
  padding: 8pt 3.18cm;
  font-size: 9pt;
  color: #666;
  border-bottom: ${readingMode ? '1px solid #eee' : '0.5pt solid #ccc'};
  ${readingMode ? 'margin-bottom: 20pt;' : ''}
  text-align: center;
}

/* 页脚 */
.doc-footer {
  position: ${readingMode ? 'relative' : 'absolute'};
  ${readingMode ? '' : 'bottom: 0;'}
  left: 0; right: 0;
  padding: 8pt 3.18cm;
  font-size: 9pt;
  color: #666;
  border-top: ${readingMode ? '1px solid #eee' : '0.5pt solid #ccc'};
  text-align: center;
  ${readingMode ? 'margin-top: 20pt;' : ''}
}

/* 内容区 */
.doc-content {
  padding: ${readingMode ? '0' : '18pt 0'};
  ${readingMode ? '' : 'margin-top: 36pt; margin-bottom: 36pt;'}
}

/* 段落 */
p { margin: 0 0 8pt; text-align: justify; }
/* 段内制表符：撑满剩余宽度并画出点线前导（目录行的页码就靠它右对齐） */
.doc-tab {
  flex: 1 1 auto;
  min-width: 12pt;
  align-self: flex-end;
  border-bottom: 1pt dotted #9aa0a6;
  margin: 0 5pt 2pt 5pt;
}
h1 { font-size: 22pt; margin: 18pt 0 10pt; font-weight: bold; }
h2 { font-size: 18pt; margin: 14pt 0 8pt; font-weight: bold; }
h3 { font-size: 15pt; margin: 12pt 0 6pt; font-weight: bold; }
h4 { font-size: 13pt; margin: 10pt 0 4pt; font-weight: bold; }
h5 { font-size: 11pt; margin: 8pt 0 4pt; font-weight: bold; }
h6 { font-size: 10pt; margin: 6pt 0 2pt; font-weight: bold; }

/* 列表 */
ul.doc-list, ol.doc-list {
  margin: 0 0 8pt;
  padding-left: 24pt;
}
ul.doc-list { list-style-type: disc; }
ol.doc-list { list-style-type: decimal; }
ul.doc-list ul.doc-list { list-style-type: circle; }
ul.doc-list ul.doc-list ul.doc-list { list-style-type: square; }

/* 表格 */
table.doc-table {
  border-collapse: collapse;
  width: 100%;
  margin: 10pt 0;
  font-size: 10pt;
}
table.doc-table td, table.doc-table th {
  border: 1px solid #999;
  padding: 4pt 6pt;
  vertical-align: top;
  text-align: left;
}
table.doc-table th {
  background: #f0f0f0;
  font-weight: bold;
}

/* 图片 */
img.doc-image {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 8pt auto;
}

/* 超链接 */
a.doc-link {
  color: #2563eb;
  text-decoration: underline;
}
a.doc-link:hover { color: #1d4ed8; }

/* 目录 */
.doc-toc {
  background: #f9f9f9;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 16pt 20pt;
  margin: 16pt 0;
}
.doc-toc h2 { font-size: 16pt; margin: 0 0 10pt; border: none; }
.doc-toc-item {
  margin: 3pt 0;
  line-height: 1.6;
}
.doc-toc-item a {
  color: #333;
  text-decoration: none;
}
.doc-toc-item a:hover { text-decoration: underline; }
.toc-level-1 { margin-left: 0; font-weight: bold; }
.toc-level-2 { margin-left: 18pt; }
.toc-level-3 { margin-left: 36pt; }
.toc-level-4 { margin-left: 54pt; }
.toc-level-5 { margin-left: 72pt; }
.toc-level-6 { margin-left: 90pt; }

/* 脚注 */
.doc-footnote-ref {
  font-size: 8pt;
  vertical-align: super;
  color: #2563eb;
  cursor: pointer;
}
.doc-footnotes-section {
  margin-top: 24pt;
  padding-top: 12pt;
  border-top: 1px solid #ccc;
}
.doc-footnotes-section h3 { font-size: 12pt; margin: 0 0 8pt; }
.doc-footnote-item {
  font-size: 9pt;
  color: #555;
  margin: 2pt 0;
  padding-left: 18pt;
  text-indent: -18pt;
}

/* 分栏 */
.doc-columns {
  column-count: 1;
  column-gap: 24pt;
}
.doc-columns.cols-2 { column-count: 2; }
.doc-columns.cols-3 { column-count: 3; }

/* 打印优化 */
@media print {
  body { background: #fff; font-size: 11pt; }
  .doc-container { box-shadow: none; margin: 0; max-width: none; padding: 0; }
  .doc-page {
    page-break-after: always;
    border: none;
    min-height: auto;
    margin: 0;
  }
  .doc-page:last-child { page-break-after: auto; }
  .doc-toc { page-break-after: always; }
  table.doc-table { page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
  img.doc-image { page-break-inside: avoid; }
  @page { margin: 0; }
}

/* 阅读模式增强 */
.reading-mode .doc-container {
  padding: 40px 48px;
  max-width: 720px;
}
.reading-mode p { font-size: 1.05em; line-height: 2; }
.reading-mode h1 { font-size: 1.8em; }
.reading-mode h2 { font-size: 1.5em; }
.reading-mode h3 { font-size: 1.3em; }
`;
}

/**
 * 渲染单个 section
 */
function renderSection(section, idx, ir, o, media, warnings) {
  const props = section.properties;
  const pageW = props.pageSize.width;
  const pageH = props.pageSize.height;
  const margins = props.margins;
  const columns = props.columns || [{ width: 0, gap: 0 }];
  const colCount = columns.length > 1 ? columns.length : 1;

  let html = `<div class="doc-page" style="width:${pageW}pt;`;
  if (!o.readingMode) {
    html += `height:${pageH}pt;`;
  }
  html += `padding:${margins.top}pt ${margins.right}pt ${margins.bottom}pt ${margins.left}pt">`;

  // 页眉
  if (o.includeHeaders !== false) {
    html += renderHeaderFooter(section.header, idx, ir.sections.length, 'header');
  }

  // 内容区
  const colClass = colCount > 1 ? ` cols-${colCount}` : '';
  html += `<div class="doc-content${colCount > 1 ? ' doc-columns' + colClass : ''}">`;

  // 目录（仅第一页且启用）
  if (o.includeToc && idx === 0 && ir.toc.length > 0) {
    html += renderToc(ir.toc);
  }

  // 渲染 blocks
  section.blocks.forEach(block => {
    html += renderBlock(block, ir, o, media, warnings);
  });

  html += '</div>';

  // 页脚
  if (o.includeFooters !== false) {
    html += renderHeaderFooter(section.footer, idx, ir.sections.length, 'footer', props.pageNumberStart);
  }

  html += '</div>';
  return html;
}

/**
 * 渲染页眉/页脚
 */
function renderHeaderFooter(hf, sectionIdx, totalSections, type, pageNumberStart) {
  const pageNum = sectionIdx + (pageNumberStart || 1);
  if (!hf || !hf.enabled) {
    if (type === 'footer') {
      return `<div class="doc-footer">第 ${pageNum} 页 / 共 ${totalSections} 页</div>`;
    }
    return '';
  }

  const cls = type === 'header' ? 'doc-header' : 'doc-footer';
  let content = hf.content || '';
  content = content.replace(/\{PAGE\}/g, String(pageNum));
  content = content.replace(/\{NUMPAGES\}/g, String(totalSections));
  content = content.replace(/\{SECTION\}/g, String(sectionIdx + 1));

  if (!content && type === 'footer') {
    content = `第 ${pageNum} 页`;
  }

  return `<div class="${cls}">${esc(content)}</div>`;
}

/**
 * 渲染目录
 */
function renderToc(toc) {
  if (!toc.length) return '';
  let html = '<div class="doc-toc"><h2>目录</h2>';
  toc.forEach((item, i) => {
    html += `<div class="doc-toc-item toc-level-${clampLevel(item.level)}">`;
    html += `<a href="#toc-anchor-${i}">${esc(item.text)}</a>`;
    html += '</div>';
  });
  html += '</div>';
  return html;
}

/**
 * 渲染单个 block
 */
function renderBlock(block, ir, o, media, warnings) {
  switch (block.type) {
    case 'paragraph':
      return renderParagraph(block, ir, o);
    case 'table':
      return renderTable(block.data, ir);
    case 'image':
      return renderImage(block.data, ir, media, warnings);
    case 'custom':
      return renderCustomBlock(block.data, ir);
    default:
      return '';
  }
}

/**
 * 渲染段落
 */
function renderParagraph(block, ir, o) {
  const ps = block.paragraphStyle || {};
  const headingLevel = ps.headingLevel || 0;
  const isList = Boolean(ps.listType);

  // 确定标签
  let tag = 'p';
  if (headingLevel >= 1 && headingLevel <= 6) {
    tag = `h${headingLevel}`;
  }

  // 构建内联样式
  let inlineStyle = buildParagraphInlineStyle(ps);
  // 含制表符的段落改成弹性布局，让 .doc-tab 把后文推到右边界（目录页码即为此设计）
  if (hasTabContent(block)) {
    const flex = 'display:flex;flex-wrap:wrap;align-items:baseline;text-align:left';
    inlineStyle = inlineStyle ? `${inlineStyle};${flex}` : flex;
  }

  // 构建内容
  let content = '';
  if (isList) {
    const listTag = ps.listType === 'ORDERED_LIST' ? 'ol' : 'ul';
    content = `<${listTag} class="doc-list"><li>${renderRuns(block.runs, block.ranges, ir, o)}</li></${listTag}>`;
  } else {
    const runsHtml = renderRuns(block.runs, block.ranges, ir, o);
    const anchorId = headingLevel > 0 ? ` id="toc-anchor-${findTocIndex(ir.toc, block.startIndex)}"` : '';
    content = `<${tag} style="${inlineStyle}"${anchorId}>${runsHtml || '<br>'}</${tag}>`;
  }

  return content;
}

function hasTabContent(block) {
  const runs = block.runs || [];
  for (let i = 0; i < runs.length; i++) {
    if (String(runs[i].text || '').indexOf('\t') >= 0) return true;
  }
  return false;
}

function findTocIndex(toc, startIndex) {
  const idx = toc.findIndex(t => t.startIndex === startIndex);
  return idx >= 0 ? idx : 0;
}

/**
 * 渲染文本 runs（含超链接、脚注引用）
 */
function renderRuns(runs, ranges, ir, o) {
  if (!runs || !runs.length) return '';

  // 如果有 ranges（超链接/脚注），需要按位置切分
  if (ranges && ranges.length) {
    return renderRunsWithRanges(runs, ranges, ir, o);
  }

  return runs.map(run => renderSingleRun(run)).join('');
}

/**
 * 带 ranges 的 run 渲染（超链接、脚注等）
 */
function renderRunsWithRanges(runs, ranges, ir, o) {
  // 先把 runs 拼成完整文本和位置映射
  const fullText = runs.map(r => r.text).join('');
  const runPositions = [];
  let offset = 0;
  runs.forEach(r => {
    runPositions.push({ start: offset, end: offset + r.text.length, style: r.style });
    offset += r.text.length;
  });

  // 按 ranges 切分
  const sortedRanges = ranges.slice().sort((a, b) => a.start - b.start);
  let html = '';
  let pos = 0;

  sortedRanges.forEach(range => {
    if (range.start > pos) {
      html += renderTextSlice(fullText, runPositions, pos, range.start);
    }

    const sliceText = fullText.slice(range.start, range.end);
    if (range.rangeType === 0) {
      // 超链接
      const href = range.properties.url || range.properties.linkUrl || '#';
      const tooltip = range.properties.tooltip ? ` title="${esc(range.properties.tooltip)}"` : '';
      html += `<a class="doc-link" href="${esc(href)}"${tooltip}>${esc(sliceText)}</a>`;
    } else if (range.rangeType === 1) {
      // 脚注引用
      const fnId = range.rangeId;
      const fnIdx = Object.keys(ir.footnotes).indexOf(fnId) + 1;
      html += `<sup class="doc-footnote-ref" id="fnref-${fnIdx}"><a href="#fn-${fnIdx}">[${fnIdx}]</a></sup>`;
    } else {
      html += renderTextSlice(fullText, runPositions, range.start, range.end);
    }

    pos = range.end;
  });

  if (pos < fullText.length) {
    html += renderTextSlice(fullText, runPositions, pos, fullText.length);
  }

  return html;
}

/**
 * 渲染文本切片（保持样式）
 */
function renderTextSlice(fullText, runPositions, start, end) {
  let html = '';
  runPositions.forEach(rp => {
    const s = Math.max(start, rp.start);
    const e = Math.min(end, rp.end);
    if (e <= s) return;
    const text = fullText.slice(s, e);
    html += applyStyle(text, rp.style);
  });
  return html;
}

/**
 * 渲染单个 run
 */
function renderSingleRun(run) {
  return applyStyle(run.text, run.style);
}

/**
 * 应用文本样式
 */
function applyStyle(text, style) {
  if (!text) return '';
  // 制表符切成独立片段：每段各自套样式，避免把一个 <strong> 从中间劈开
  if (text.indexOf('\t') >= 0) {
    return text
      .split('\t')
      .map(seg => styleSegment(seg, style))
      .join('<span class="doc-tab"></span>');
  }
  return styleSegment(text, style);
}

function styleSegment(text, style) {
  if (!text) return '';
  let s = esc(text).replace(/\n/g, '<br>');
  if (!style || Object.keys(style).length === 0) return s;

  if (style.color && style.color !== '#000000') s = `<span style="color:${style.color}">${s}</span>`;
  if (style.backgroundColor) s = `<span style="background-color:${style.backgroundColor}">${s}</span>`;
  if (style.fontSize) s = `<span style="font-size:${style.fontSize}pt">${s}</span>`;
  if (style.fontFamily) s = `<span style="font-family:${esc(style.fontFamily)}">${s}</span>`;
  if (style.bold) s = `<strong>${s}</strong>`;
  if (style.italic) s = `<em>${s}</em>`;

  const decorations = [];
  if (style.underline) decorations.push('underline');
  if (style.strikethrough) decorations.push('line-through');
  if (decorations.length) s = `<span style="text-decoration:${decorations.join(' ')}">${s}</span>`;

  return s;
}

/**
 * 构建段落内联样式
 */
function buildParagraphInlineStyle(ps) {
  const parts = [];
  if (ps.textAlign) parts.push(`text-align:${ps.textAlign}`);
  if (ps.spacing) {
    if (ps.spacing.line) parts.push(`line-height:${ps.spacing.line}`);
    if (ps.spacing.before) parts.push(`margin-top:${ps.spacing.before}pt`);
    if (ps.spacing.after) parts.push(`margin-bottom:${ps.spacing.after}pt`);
  }
  if (ps.indent) {
    if (ps.indent.firstLine) parts.push(`text-indent:${ps.indent.firstLine}pt`);
    if (ps.indent.left) parts.push(`margin-left:${ps.indent.left}pt`);
    if (ps.indent.right) parts.push(`margin-right:${ps.indent.right}pt`);
  }
  return parts.join(';');
}

/**
 * 渲染表格
 */
function renderTable(tableData, ir) {
  if (!tableData || !tableData.rows || !tableData.rows.length) return '';

  let html = '<table class="doc-table">';
  tableData.rows.forEach((row, ri) => {
    html += '<tr>';
    (row.cells || []).forEach(cell => {
      const tag = ri === 0 ? 'th' : 'td';
      const attrs = [];
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
      const cellStyle = buildCellStyle(cell.style);
      if (cellStyle) attrs.push(`style="${cellStyle}"`);
      html += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${esc(cell.text)}</${tag}>`;
    });
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

function buildCellStyle(style) {
  if (!style) return '';
  const parts = [];
  if (style.backgroundColor) parts.push(`background-color:${style.backgroundColor}`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.textAlign) parts.push(`text-align:${style.textAlign}`);
  if (style.bold) parts.push('font-weight:bold');
  return parts.join(';');
}

/**
 * 渲染图片
 */
function renderImage(imageData, ir, media, warnings) {
  if (!imageData) return '';
  let src = imageData.src || imageData.url || '';
  if (src && !/^data:/i.test(src) && !/^https?:\/\//i.test(src)) {
    src = media.url(src);
  }
  if (!src) return '<p style="color:#999;font-style:italic;">[图片缺失]</p>';

  const width = clampPt(imageData.width, 300);
  const height = clampPt(imageData.height, 200);
  const alt = esc(imageData.alt || '图片');

  return `<img class="doc-image" src="${esc(src)}" style="width:${width}pt;height:${height}pt" alt="${alt}">`;
}

/**
 * 渲染自定义 block
 */
function renderCustomBlock(data, ir) {
  return `<div class="doc-custom-block" style="padding:8pt;border:1px dashed #ccc;margin:8pt 0;color:#999;">[不支持的内容块: ${esc(data.blockType || 'unknown')}]</div>`;
}

/**
 * 渲染脚注区域
 */
function renderFootnotesSection(ir) {
  const fns = ir.footnotes;
  const keys = Object.keys(fns);
  if (!keys.length) return '';

  let html = '<div class="doc-footnotes-section"><h3>脚注</h3>';
  keys.forEach((id, i) => {
    const fn = fns[id];
    const content = fn.content || '';
    html += `<div class="doc-footnote-item" id="fn-${i + 1}">`;
    html += `<sup>[${i + 1}]</sup> ${esc(content)} `;
    html += `<a href="#fnref-${i + 1}" style="font-size:8pt;color:#2563eb;text-decoration:none;">↩</a>`;
    html += '</div>';
  });
  html += '</div>';
  return html;
}

module.exports = { renderDocToHtml, renderDocFlow, createHtmlMedia, readLocalFile };
