/**
 * 文档导出：Univer Docs 快照 → .docx（WordprocessingML）/ .html / .md
 *
 * 输入模型（与 server/utils/spreadsheet-doc-store.js createEmptyDocument、
 * server/utils/office-import.js convertDocx 一致）：
 *   body.dataStream   整篇文本，段落分隔符为 \r\n，段内软换行为 \n
 *   body.paragraphs[] { startIndex, paragraphStyle{namedStyleType,listType,…} }
 *   body.textRuns[]   { st, en, tsId } 样式区间
 *   styles[tsId]      { bl, it, ul, st, cl:{r,g,b}, fs(磅), ff }
 *
 * 增强功能（v8.11+）：
 *   - HTML 导出使用 doc-html-renderer.js 共享渲染层（支持图片内联、表格、页眉页脚等）
 *   - .docx 导出支持图片嵌入、表格、超链接、页眉页脚
 *   - Markdown 导出保留原有功能
 */
'use strict';
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { renderDocToHtml, readLocalFile } = require('./doc-html-renderer');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const NAMED_STYLE_TO_PSTYLE = { 2: 'Title', 3: 'Subtitle', 4: 'Heading1', 5: 'Heading2', 6: 'Heading3', 7: 'Heading4', 8: 'Heading5' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => XML_ESCAPE[ch]);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function colorHex(cl, fallback) {
  if (!cl) return String(fallback || '000000');
  if (typeof cl === 'string') return cl.replace('#', '').toUpperCase();
  const to2 = x => Math.max(0, Math.min(255, Math.round(num(x, 0) * (num(x, 0) <= 1 ? 255 : 1))));
  const hex = n => to2(n).toString(16).padStart(2, '0').toUpperCase();
  return `${hex(cl.r)}${hex(cl.g)}${hex(cl.b)}`;
}

function extOfUrl(url) {
  const ext = (String(url || '').split('.').pop() || '').split('?')[0].toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? ext : 'png';
}

// ============ 段落/Run 解析 ============

function toParagraphs(doc) {
  const body = (doc && doc.body) || {};
  const dataStream = String(body.dataStream || '');
  const styles = (doc && doc.styles) || {};
  if (!dataStream.trim()) return [];

  const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
  const textRuns = Array.isArray(body.textRuns) ? body.textRuns : [];
  const ordered = paragraphs.slice().sort((a, b) => num(a.startIndex, 0) - num(b.startIndex, 0));

  const blocks = [];
  let cursor = 0;
  let idx = 0;
  const split = dataStream.split('\r\n');
  split.forEach((rawText, i) => {
    if (i === split.length - 1 && rawText === '' && blocks.length > 0) return;
    const pStyle = (ordered[idx] && ordered[idx].paragraphStyle) || {};
    idx += 1;
    const start = cursor;
    cursor += rawText.length + 2;
    blocks.push({
      text: rawText,
      startIndex: start,
      style: pStyle,
      runs: sliceRuns(rawText, start, textRuns, styles),
    });
  });
  return blocks;
}

/** 取 textRun 的绝对区间，兼容 { st, en } 与 { startIndex, endIndex } 两种写法 */
function runBounds(tr) {
  return { start: num(tr.st, num(tr.startIndex, 0)), end: num(tr.en, num(tr.endIndex, 0)) };
}

function runStyle(tr, styles) {
  if (tr.tsId) return styles[tr.tsId] || {};
  return tr.textStyle || {};
}

function sliceRuns(text, pStart, textRuns, styles) {
  const pEnd = pStart + text.length;
  const hits = textRuns
    .map(tr => ({ ...runBounds(tr), style: runStyle(tr, styles) }))
    .filter(r => r.start < pEnd && r.end > pStart)
    .sort((a, b) => a.start - b.start);
  const out = [];
  let pos = pStart;
  hits.forEach(r => {
    const s = Math.max(pos, r.start);
    const e = Math.min(pEnd, r.end);
    if (e <= s) return;
    if (s > pos) out.push({ text: text.slice(pos - pStart, s - pStart), style: {}, start: pos, end: s });
    out.push({ text: text.slice(s - pStart, e - pStart), style: r.style, start: s, end: e });
    pos = e;
  });
  if (pos < pEnd) out.push({ text: text.slice(pos - pStart), style: {}, start: pos, end: pEnd });
  return out.filter(r => r.text.length > 0);
}

// ============ 图片处理 ============

function createDocxMedia() {
  const entries = [];
  const cache = new Map();
  const MAX_TOTAL = 24 * 1024 * 1024;
  let total = 0;
  let seq = 0;

  return {
    resolve(src) {
      if (!src) return null;
      const hit = cache.get(src);
      if (hit) return hit;
      const buffer = readLocalFile(src);
      if (!buffer) return null;
      if (total + buffer.length > MAX_TOTAL) return null;
      total += buffer.length;
      seq += 1;
      const ext = extOfUrl(src);
      const name = `image${seq}.${ext}`;
      entries.push({ name, buffer, ext });
      cache.set(src, name);
      return name;
    },
    entries,
    rels: entries.map((e, i) => ({ id: i + 10, type: 'image', target: `media/${e.name}` }))
  };
}

// ============ .docx 增强导出 ============

function rPrXml(st) {
  const rPrParts = [];
  if (st.ff && st.ff.value) {
    const f = esc(st.ff.value);
    rPrParts.push(`<w:rFonts w:ascii="${f}" w:eastAsia="${f}" w:hAnsi="${f}"/>`);
  }
  if (st.bl) rPrParts.push('<w:b/>');
  if (st.it) rPrParts.push('<w:i/>');
  if (st.st) rPrParts.push('<w:strike/>');
  if (st.cl) rPrParts.push(`<w:color w:val="${colorHex(st.cl, '000000')}"/>`);
  if (num(st.fs, 0) > 0) rPrParts.push(`<w:sz w:val="${Math.round(st.fs * 2)}"/><w:szCs w:val="${Math.round(st.fs * 2)}"/>`);
  if (st.ul) rPrParts.push('<w:u w:val="single"/>');
  return rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
}

function runXml(run, mediaStore) {
  const st = run.style || {};
  const rPr = rPrXml(st);

  const lines = String(run.text).split('\n');
  const body = lines.map((line, i) => (i ? '<w:br/>' : '')
    + (line ? `<w:t xml:space="preserve">${esc(line)}</w:t>` : '')).join('');
  if (!body && !rPr) return '';
  return `<w:r>${rPr}${body}</w:r>`;
}

function paragraphProperties(pStyle) {
  const parts = [];
  const named = NAMED_STYLE_TO_PSTYLE[num(pStyle.namedStyleType, 0)];
  if (named) parts.push(`<w:pStyle w:val="${named}"/>`);
  const listType = pStyle.listType;
  if (listType) {
    // Univer 里 1 是无序列表、2 是有序列表，也可能是字符串枚举名
    const ordered = listType === 'ORDERED_LIST' || num(listType, 0) === 2;
    parts.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${ordered ? 2 : 1}"/></w:numPr>`);
  }
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}

function paraXml(block) {
  const pPr = paragraphProperties(block.style || {});
  const runs = (block.runs || []).map(r => runXml(r)).join('');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function buildDocxImages(doc, mediaStore) {
  const drawings = doc.drawings || {};
  const order = Array.isArray(doc.drawingsOrder) ? doc.drawingsOrder : Object.keys(drawings);
  const images = [];
  order.forEach(id => {
    const d = drawings[id];
    if (!d) return;
    const src = d.url || d.src || d.imageSource;
    if (!src) return;
    const name = mediaStore.resolve(src);
    if (name) {
      images.push({ id, name, drawing: d });
    }
  });
  return images;
}

function imageXml(img, rId) {
  const d = img.drawing;
  const w = num(d.width, 300);
  const h = num(d.height, 200);
  const cx = Math.round(w * 12700);
  const cy = Math.round(h * 12700);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" `
    + `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${rId}" name="${esc(img.name)}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicFrame><a:nvPicPr><a:cNvPr id="${rId}" name="${esc(img.name)}"/><a:cNvPicPr/></a:nvPicPr>`
    + `<a:blipFill><a:blip r:embed="rId${rId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`
    + `<a:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></a:spPr></a:graphicFrame></a:graphic>`
    + `</wp:inline></w:drawing></w:r>`;
}

// ============ 表格导出 ============

function buildDocxTables(doc) {
  const customBlocks = (doc.body && doc.body.customBlocks) || [];
  return customBlocks.filter(b => b.blockType === 'table' && b.table);
}

function tableXml(tableData) {
  if (!tableData || !tableData.rows || !tableData.rows.length) return '';
  const table = tableData.table || tableData;
  const rows = table.rows || [];
  if (!rows.length) return '';

  let xml = '<w:tbl>';
  // 表格属性
  xml += '<w:tblPr>';
  xml += '<w:tblW w:w="5000" w:type="pct"/>'; // 100% 宽度
  xml += '<w:tblBorders>';
  xml += '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  xml += '</w:tblBorders>';
  xml += '</w:tblPr>';

  // 表格网格
  const cols = rows.reduce((n, r) => Math.max(n, (r.cells || []).length), 0);
  if (cols > 0) {
    xml += '<w:tblGrid>';
    for (let i = 0; i < cols; i++) {
      xml += '<w:gridCol w:w="2000"/>';
    }
    xml += '</w:tblGrid>';
  }

  // 行
  rows.forEach((row, ri) => {
    xml += '<w:tr>';
    (row.cells || []).forEach(cell => {
      const cellText = cell.text || cell.content || '';
      const rowSpan = num(cell.rowSpan, 1);
      const colSpan = num(cell.colSpan, 1);
      xml += '<w:tc>';
      // 单元格属性
      xml += '<w:tcPr>';
      if (colSpan > 1) xml += `<w:gridSpan w:val="${colSpan}"/>`;
      if (rowSpan > 1) xml += `<w:vMerge w:val="restart"/>`;
      xml += '<w:tcBorders>';
      xml += '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
      xml += '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
      xml += '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
      xml += '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
      xml += '</w:tcBorders>';
      xml += '</w:tcPr>';
      // 单元格内容
      xml += `<w:p><w:r><w:t xml:space="preserve">${esc(cellText)}</w:t></w:r></w:p>`;
      xml += '</w:tc>';
    });
    xml += '</w:tr>';
  });

  xml += '</w:tbl>';
  return xml;
}

// ============ 超链接导出 ============

function buildDocxHyperlinks(doc) {
  const customRanges = (doc.body && doc.body.customRanges) || [];
  const hyperLinks = (doc.body && doc.body.hyperLinks && doc.body.hyperLinks.hyperLinks) || {};
  const list = customRanges
    .filter(cr => num(cr.rangeType, 0) === 0) // HYPERLINK
    .map(cr => {
      const entry = hyperLinks[cr.rangeId] || {};
      return {
        startIndex: num(cr.startIndex, 0),
        endIndex: num(cr.endIndex, 0),
        url: entry.url || (cr.properties && cr.properties.url) || ''
      };
    })
    .filter(h => h.url && h.endIndex > h.startIndex);
  list.sort((a, b) => a.startIndex - b.startIndex);
  list.forEach((h, i) => { h.rId = 200 + i; });
  return list;
}

function hyperlinkRunXml(text, rId, style) {
  const st = style || {};
  const inner = `<w:r>${rPrXml({ ...st, ul: st.ul || 1, cl: st.cl || { r: 5, g: 99, b: 193 } })}`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  return `<w:hyperlink r:id="rId${rId}">${inner}</w:hyperlink>`;
}

// ============ 页眉/页脚导出 ============

function headerXml(doc) {
  const ds = doc.documentStyle || {};
  const hfc = ds.headerFooterConfig || {};
  const header = hfc.header || {};
  const content = header.content || '';
  if (!content && !header.enabled) {
    // 默认页眉：文档名
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<w:hdr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
      + `<w:r><w:t>${esc(doc.name || '')}</w:t></w:r></w:p></w:hdr>`;
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:hdr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
    + `<w:r><w:t>${esc(content)}</w:t></w:r></w:p></w:hdr>`;
}

function footerXml(doc, sectionIdx, totalSections) {
  const pageNum = sectionIdx + 1;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:ftr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
    + `<w:r><w:t>第 ${pageNum} 页 / 共 ${totalSections} 页</w:t></w:r></w:p></w:ftr>`;
}

// ============ 目录导出 ============

function tocFieldXml() {
  // TOC 域代码
  return '<w:p>'
    + '<w:pPr><w:pStyle w:val="TOC1"/></w:pPr>'
    + '<w:r><w:rPr><w:b/></w:rPr><w:t>目录</w:t></w:r>'
    + '</w:p>'
    + '<w:sdt>'
    + '<w:sdtContent>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:t>（请在 Word 中右键更新目录）</w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    + '</w:sdtContent>'
    + '</w:sdt>';
}

function documentXml(blocks, documentStyle, images, tables, hyperlinks, mediaStore, doc) {
  const ds = documentStyle || {};
  const twips = px => Math.round(num(px, 0) * 20);
  let sectPr = '<w:sectPr>';
  sectPr += `<w:pgSz w:w="${twips(ds.pageSize && ds.pageSize.width) || 11906}" w:h="${twips(ds.pageSize && ds.pageSize.height) || 16838}"/>`;
  sectPr += `<w:pgMar w:top="${twips(ds.marginTop) || 1440}" w:right="${twips(ds.marginRight) || 1800}" `;
  sectPr += `w:bottom="${twips(ds.marginBottom) || 1440}" w:left="${twips(ds.marginLeft) || 1800}" `;
  sectPr += 'w:header="708" w:footer="708" w:gutter="0"/>';

  // 页眉/页脚引用
  sectPr += `<w:headerReference w:type="default" r:id="rId100"/>`;
  sectPr += `<w:footerReference w:type="default" r:id="rId101"/>`;

  sectPr += '</w:sectPr>';

  let bodyXml = '';

  // 添加目录（如果有标题）
  const hasHeadings = blocks.some(b => b.style && b.style.namedStyleType && b.style.namedStyleType >= 2 && b.style.namedStyleType <= 8);
  if (hasHeadings) {
    bodyXml += tocFieldXml();
  }

  // 处理段落（含超链接）
  blocks.forEach(block => {
    if (hyperlinks.length > 0) {
      const blockStart = num(block.startIndex, 0);
      const blockEnd = blockStart + (block.text || '').length;
      const blockLinks = hyperlinks.filter(h => h.startIndex >= blockStart && h.endIndex <= blockEnd);
      if (blockLinks.length > 0) {
        bodyXml += paraXmlWithLinks(block, blockLinks);
        return;
      }
    }
    bodyXml += paraXml(block);
  });

  // 插入表格
  tables.forEach(t => {
    bodyXml += tableXml(t);
  });

  // 插入图片段落
  images.forEach((img, i) => {
    const rId = 10 + i;
    bodyXml += `<w:p>${imageXml(img, rId)}</w:p>`;
  });

  bodyXml += sectPr;

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
}

/** 把一个 run 按超链接边界切成片段（超链接与样式可以共存） */
function splitRunSegments(text, run, links, rel, base) {
  const runStart = rel(num(run.start, base));
  const runEnd = Math.min(text.length, runStart + String(run.text == null ? '' : run.text).length);
  const out = [];
  let p = runStart;
  while (p < runEnd) {
    const from = p;
    const link = links.find(l => rel(l.startIndex) <= from && from < rel(l.endIndex));
    let stop = runEnd;
    if (link) {
      stop = Math.min(stop, rel(link.endIndex));
    } else {
      for (let i = 0; i < links.length; i++) {
        const s = rel(links[i].startIndex);
        if (s > from && s < stop) stop = s;
      }
    }
    if (stop <= from) break;
    out.push({ text: text.slice(from, stop), style: run.style || {}, link: link ? { rId: link.rId } : null });
    p = stop;
  }
  return out;
}

function paraXmlWithLinks(block, links) {
  const pPr = paragraphProperties(block.style || {});
  const text = block.text || '';
  const base = num(block.startIndex, 0);
  const rel = abs => Math.max(0, Math.min(text.length, num(abs, base) - base));
  const runs = (block.runs && block.runs.length)
    ? block.runs
    : [{ text, style: {}, start: base, end: base + text.length }];

  const segments = [];
  runs.forEach(run => splitRunSegments(text, run, links, rel, base).forEach(seg => segments.push(seg)));

  const covered = segments.reduce((n, s) => n + s.text.length, 0);
  if (covered < text.length) segments.push({ text: text.slice(covered), style: {}, link: null });

  const xml = segments.map(seg => (seg.link
    ? hyperlinkRunXml(seg.text, seg.link.rId, seg.style)
    : runXml(seg))).join('');

  return `<w:p>${pPr}${xml}</w:p>`;
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:styles ${W_NS}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Calibri" w:eastAsia="微软雅黑" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>'
  + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="TOC1"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="42"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:sz w:val="32"/><w:color w:val="595959"/></w:rPr></w:style>'
  + [1, 2, 3, 4, 5].map(i => '<w:style w:type="paragraph" w:styleId="Heading' + i + '">'
    + `<w:name w:val="heading ${i}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i - 1}"/>`
    + `<w:spacing w:before="${240 - i * 20}" w:after="120"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${44 - i * 6}"/></w:rPr></w:style>`).join('')
  + '</w:styles>';

const NUMBERING_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:numbering ${W_NS}>`
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>'
  + '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
  + '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>'
  + '</w:numbering>';

function settingsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:settings ${W_NS}><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/></w:settings>`;
}

function contentTypesXml(hasImages, hasHeaders) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>';
  if (hasImages) {
    xml += '<Default Extension="png" ContentType="image/png"/>';
    xml += '<Default Extension="jpg" ContentType="image/jpeg"/>';
    xml += '<Default Extension="jpeg" ContentType="image/jpeg"/>';
    xml += '<Default Extension="gif" ContentType="image/gif"/>';
    xml += '<Default Extension="webp" ContentType="image/webp"/>';
  }
  xml += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>';
  xml += '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>';
  xml += '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>';
  xml += '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>';
  if (hasHeaders) {
    xml += '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>';
    xml += '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>';
  }
  xml += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';
  xml += '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  xml += '</Types>';
  return xml;
}

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_HEADER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';

function relsXml(items) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(r => `<Relationship Id="rId${r.id}" Type="${REL_BASE}/${r.type}" Target="${esc(r.target)}"/>`).join('')
    + '</Relationships>';
}

function documentRelsXml(mediaStore, hyperlinks, hasHeaders) {
  const items = [
    { id: 1, type: 'styles', target: 'styles.xml' },
    { id: 2, type: 'numbering', target: 'numbering.xml' },
    { id: 3, type: 'settings', target: 'settings.xml' }
  ];

  // 图片关系
  mediaStore.entries.forEach((e, i) => {
    items.push({ id: 10 + i, type: 'image', target: `media/${e.name}` });
  });

  // 页眉/页脚关系
  if (hasHeaders) {
    items.push({ id: 100, type: 'header', target: 'header1.xml', isExternal: false, relType: REL_HEADER });
    items.push({ id: 101, type: 'footer', target: 'footer1.xml', isExternal: false, relType: REL_FOOTER });
  }

  // 超链接关系（外部链接）
  hyperlinks.forEach((h, i) => {
    items.push({ id: 200 + i, type: 'hyperlink', target: h.url, isExternal: true, relType: REL_HYPERLINK });
  });

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

  items.forEach(r => {
    const relType = r.relType || (r.type === 'image' ? REL_IMAGE : REL_BASE + '/' + r.type);
    const targetMode = r.isExternal ? ' TargetMode="External"' : '';
    xml += `<Relationship Id="rId${r.id}" Type="${relType}" Target="${esc(r.target)}"${targetMode}/>`;
  });

  xml += '</Relationships>';
  return xml;
}

function coreXml(name) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(name)}</dc:title><dc:creator>在线Office</dc:creator>`
    + '<cp:lastModifiedBy>在线Office</cp:lastModifiedBy>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>';
}

function appXml(paragraphCount) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
    + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>Qoder 在线Office</Application>'
    + `<Paragraphs>${paragraphCount}</Paragraphs><Words>0</Words>`
    + '<TitlesOfParts><vt:vector size="0" baseType="lpstr"/></TitlesOfParts>'
    + '<AppVersion>16.0000</AppVersion></Properties>';
}

/**
 * 生成 .docx（增强版：支持图片、表格、超链接、页眉页脚、目录）
 */
function toDocx(doc, options) {
  const o = options || {};
  const blocks = toParagraphs(doc);
  if (!blocks.length) throw new Error('文档内容为空，无法导出');

  const zip = new AdmZip();
  const mediaStore = createDocxMedia();
  const images = buildDocxImages(doc, mediaStore);
  const tables = buildDocxTables(doc);
  const hyperlinks = buildDocxHyperlinks(doc);
  const warnings = [];

  // 基础文件
  const hasHeaders = true; // 总是包含页眉页脚
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml(images.length > 0, hasHeaders), 'utf-8'));
  zip.addFile('_rels/.rels', Buffer.from(relsXml([
    { id: 1, type: 'officeDocument', target: 'word/document.xml' },
    { id: 2, type: 'core-properties', target: 'docProps/core.xml' },
    { id: 3, type: 'extended-properties', target: 'docProps/app.xml' }
  ]), 'utf-8'));

  // 文档主体
  zip.addFile('word/document.xml', Buffer.from(documentXml(blocks, doc.documentStyle, images, tables, hyperlinks, mediaStore, doc), 'utf-8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(documentRelsXml(mediaStore, hyperlinks, hasHeaders), 'utf-8'));

  // 样式/编号/设置
  zip.addFile('word/styles.xml', Buffer.from(STYLES_XML, 'utf-8'));
  zip.addFile('word/numbering.xml', Buffer.from(NUMBERING_XML, 'utf-8'));
  zip.addFile('word/settings.xml', Buffer.from(settingsXml(), 'utf-8'));

  // 页眉/页脚
  if (hasHeaders) {
    zip.addFile('word/header1.xml', Buffer.from(headerXml(doc), 'utf-8'));
    zip.addFile('word/footer1.xml', Buffer.from(footerXml(doc, 0, 1), 'utf-8'));
  }

  // 元数据
  zip.addFile('docProps/core.xml', Buffer.from(coreXml(o.name || doc.name || '文档'), 'utf-8'));
  zip.addFile('docProps/app.xml', Buffer.from(appXml(blocks.length), 'utf-8'));

  // 图片文件
  mediaStore.entries.forEach(entry => {
    zip.addFile(`word/media/${entry.name}`, entry.buffer);
  });

  // 警告
  const totalDrawings = Object.keys(doc.drawings || {}).length;
  if (totalDrawings > images.length) {
    warnings.push(`${totalDrawings - images.length} 张图片无法读取或超出大小限制`);
  }
  if (tables.length) {
    warnings.push(`已导出 ${tables.length} 个表格`);
  }
  if (hyperlinks.length) {
    warnings.push(`已导出 ${hyperlinks.length} 个超链接`);
  }

  return {
    buffer: zip.toBuffer(),
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    warnings,
    stats: { paragraphs: blocks.length, images: images.length, tables: tables.length, hyperlinks: hyperlinks.length }
  };
}

// ============ HTML / Markdown ============

/**
 * HTML 导出（使用共享渲染层，支持图片内联、表格、页眉页脚等）
 */
function toHtml(doc, options) {
  const o = options || {};
  const result = renderDocToHtml(doc, {
    name: o.name,
    readingMode: false,
    includeToc: true,
    includeHeaders: true,
    includeFooters: true,
    publicDir: o.publicDir
  });
  return {
    buffer: Buffer.from(result.html, 'utf-8'),
    ext: 'html',
    mime: 'text/html; charset=utf-8',
    warnings: result.warnings || [],
    stats: { sections: 1 }
  };
}

/**
 * 阅读模式 HTML 导出
 */
function toReadingHtml(doc, options) {
  const o = options || {};
  const result = renderDocToHtml(doc, {
    name: o.name,
    readingMode: true,
    includeToc: true,
    includeHeaders: false,
    includeFooters: false,
    publicDir: o.publicDir
  });
  return {
    buffer: Buffer.from(result.html, 'utf-8'),
    ext: 'html',
    mime: 'text/html; charset=utf-8',
    warnings: result.warnings || [],
    stats: { sections: 1 }
  };
}

function inlineHtml(run) {
  const st = run.style || {};
  let s = esc(run.text).replace(/\n/g, '<br>');
  if (st.cl) s = `<span style="color:#${colorHex(st.cl, '000000')}">${s}</span>`;
  if (num(st.fs, 0) > 0) s = `<span style="font-size:${st.fs}pt">${s}</span>`;
  if (st.ul) s = `<span style="text-decoration:underline">${s}</span>`;
  if (st.st) s = `<span style="text-decoration:line-through">${s}</span>`;
  if (st.bl) s = `<strong>${s}</strong>`;
  if (st.it) s = `<em>${s}</em>`;
  return s;
}

function blockHtml(block) {
  const inner = block.runs.map(inlineHtml).join('');
  const named = NAMED_STYLE_TO_PSTYLE[num((block.style || {}).namedStyleType, 0)];
  if (named && named !== 'Subtitle') {
    const level = named === 'Title' ? 1 : parseInt(named.slice(7), 10) + 1;
    return `<h${Math.min(6, level)}>${inner}</h${Math.min(6, level)}>`;
  }
  if ((block.style || {}).listType) return `<ul><li>${inner}</li></ul>`;
  return `<p>${inner || '<br>'}</p>`;
}

function inlineMarkdown(run) {
  const st = run.style || {};
  let s = String(run.text).replace(/\n/g, '  \n');
  if (st.ul) s = `<u>${s}</u>`;
  if (st.st) s = `~~${s}~~`;
  if (st.bl) s = `**${s}**`;
  if (st.it) s = `*${s}*`;
  return s;
}

function toMarkdown(doc, options) {
  const o = options || {};
  const blocks = toParagraphs(doc);
  if (!blocks.length) throw new Error('文档内容为空，无法导出');
  const lines = blocks.map(block => {
    const text = block.runs.map(inlineMarkdown).join('').trimEnd();
    const named = NAMED_STYLE_TO_PSTYLE[num((block.style || {}).namedStyleType, 0)];
    if (named === 'Title') return `# ${text}`;
    if (named && named !== 'Subtitle' && /^Heading/.test(named)) return `${'#'.repeat(Math.min(6, parseInt(named.slice(7), 10) + 1))} ${text}`;
    if ((block.style || {}).listType) return `- ${text}`;
    return text;
  });
  const head = `# ${o.name || doc.name || '文档'}\n\n`;
  return {
    buffer: Buffer.from(head + lines.join('\n\n') + '\n', 'utf-8'),
    ext: 'md',
    mime: 'text/markdown; charset=utf-8',
    warnings: [],
    stats: { paragraphs: blocks.length }
  };
}

module.exports = {
  exportOfficeDocument(doc, format, options) {
    const o = options || {};
    const f = String(format || 'docx').toLowerCase();
    if (f === 'html' || f === 'htm') return toHtml(doc, o);
    if (f === 'reading') return toReadingHtml(doc, o);
    if (f === 'md' || f === 'markdown') return toMarkdown(doc, o);
    if (f !== 'docx') throw new Error('文档导出仅支持 .docx / .html / .md');
    return toDocx(doc, o);
  },
  toParagraphs,
  toDocx,
  toHtml,
  toReadingHtml,
  toMarkdown
};
