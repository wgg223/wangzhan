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
 * 说明：
 *   - 段落序号按 dataStream 的 \r\n 切分，再按 startIndex 对齐样式；
 *   - 未覆盖的文本区间按无样式输出，保证文字不丢；
 *   - 图片（drawings）暂不写进 docx，导出时给出提示。
 */
'use strict';
const AdmZip = require('adm-zip');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// Univer NamedStyleType → Word 内建样式名
const NAMED_STYLE_TO_PSTYLE = { 2: 'Title', 3: 'Subtitle', 4: 'Heading1', 5: 'Heading2', 6: 'Heading3', 7: 'Heading4', 8: 'Heading5' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => XML_ESCAPE[ch]);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** cl:{r,g,b}（0–1）或 #rrggbb → RRGGBB */
function colorHex(cl, fallback) {
  if (!cl) return String(fallback || '000000');
  if (typeof cl === 'string') return cl.replace('#', '').toUpperCase();
  const to2 = x => Math.max(0, Math.min(255, Math.round(num(x, 0) * (num(x, 0) <= 1 ? 255 : 1))));
  const hex = n => to2(n).toString(16).padStart(2, '0').toUpperCase();
  return `${hex(cl.r)}${hex(cl.g)}${hex(cl.b)}`;
}

// ============ 结构还原 ============

/**
 * 把 Univer Docs 快照拆成「段落 + 带样式片段」
 * @param {object} doc
 * @returns {Array<{text: string, style: object, runs: Array<{text, style}>}>}
 */
function toParagraphs(doc) {
  const body = (doc && doc.body) || {};
  const dataStream = String(body.dataStream || '');
  const styles = (doc && doc.styles) || {};
  if (!dataStream.trim()) return [];

  const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
  const textRuns = Array.isArray(body.textRuns) ? body.textRuns : [];
  // 段落样式按 startIndex 排序后依次对齐；数量不一致时按出现顺序取用
  const ordered = paragraphs
    .slice()
    .sort((a, b) => num(a.startIndex, 0) - num(b.startIndex, 0));

  const blocks = [];
  let cursor = 0;
  let idx = 0;
  const split = dataStream.split('\r\n');
  split.forEach((rawText, i) => {
    // 最后一段若无文字（末尾分隔符产生）跳过
    if (i === split.length - 1 && rawText === '' && blocks.length > 0) return;
    const pStyle = (ordered[idx] && ordered[idx].paragraphStyle) || {};
    idx += 1;
    const start = cursor;
    cursor += rawText.length + 2;
    blocks.push({ text: rawText, style: pStyle, runs: sliceRuns(rawText, start, textRuns, styles) });
  });
  return blocks;
}

/** 按绝对偏移切出段落内的样式片段，未覆盖部分补无样式片段 */
function sliceRuns(text, pStart, textRuns, styles) {
  const pEnd = pStart + text.length;
  const hits = textRuns
    .filter(r => num(r.st, 0) < pEnd && num(r.en, 0) > pStart)
    .sort((a, b) => num(a.st, 0) - num(b.st, 0));
  const out = [];
  let pos = pStart;
  hits.forEach(r => {
    const s = Math.max(pos, num(r.st, 0));
    const e = Math.min(pEnd, num(r.en, 0));
    if (e <= s) return;
    if (s > pos) out.push({ text: text.slice(pos - pStart, s - pStart), style: {} });
    out.push({ text: text.slice(s - pStart, e - pStart), style: styles[r.tsId] || {} });
    pos = e;
  });
  if (pos < pEnd) out.push({ text: text.slice(pos - pStart), style: {} });
  return out.filter(r => r.text.length > 0);
}

// ============ docx ============

function runXml(run) {
  const st = run.style || {};
  // CT_RPr 子元素有固定顺序：rFonts → b → i → strike → color → sz → u
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
  const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
  // 段内软换行 → <w:br/>
  const lines = String(run.text).split('\n');
  const body = lines.map((line, i) => (i ? '<w:br/>' : '')
    + (line ? `<w:t xml:space="preserve">${esc(line)}</w:t>` : '')).join('');
  if (!body && !rPr) return '';
  return `<w:r>${rPr}${body}</w:r>`;
}

function paraXml(block) {
  const pStyle = block.style || {};
  const pPrParts = [];
  const named = NAMED_STYLE_TO_PSTYLE[num(pStyle.namedStyleType, 0)];
  if (named) pPrParts.push(`<w:pStyle w:val="${named}"/>`);
  if (pStyle.listType) {
    const numId = pStyle.listType === 'ORDERED_LIST' ? 2 : 1;
    pPrParts.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
  }
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';
  const runs = block.runs.map(runXml).join('');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function documentXml(blocks, documentStyle) {
  const ds = documentStyle || {};
  const twips = px => Math.round(num(px, 0) * 20);
  const sectPr = '<w:sectPr>'
    + `<w:pgSz w:w="${twips(ds.pageSize && ds.pageSize.width) || 11906}" w:h="${twips(ds.pageSize && ds.pageSize.height) || 16838}"/>`
    + `<w:pgMar w:top="${twips(ds.marginTop) || 1440}" w:right="${twips(ds.marginRight) || 1800}" `
    + `w:bottom="${twips(ds.marginBottom) || 1440}" w:left="${twips(ds.marginLeft) || 1800}" `
    + 'w:header="708" w:footer="708" w:gutter="0"/>'
    + '</w:sectPr>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document ${W_NS}><w:body>${blocks.map(paraXml).join('')}${sectPr}</w:body></w:document>`;
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:styles ${W_NS}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Calibri" w:eastAsia="微软雅黑" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
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

function contentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
}

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function relsXml(items) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(r => `<Relationship Id="rId${r.id}" Type="${REL_BASE}/${r.type}" Target="${esc(r.target)}"/>`).join('')
    + '</Relationships>';
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
 * 生成 .docx
 * @param {object} doc Univer Docs 快照
 * @param {{name?: string}} [options]
 */
function toDocx(doc, options) {
  const o = options || {};
  const blocks = toParagraphs(doc);
  if (!blocks.length) throw new Error('文档内容为空，无法导出');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml(), 'utf-8'));
  zip.addFile('_rels/.rels', Buffer.from(relsXml([
    { id: 1, type: 'officeDocument', target: 'word/document.xml' },
    { id: 2, type: 'core-properties', target: 'docProps/core.xml' },
    { id: 3, type: 'extended-properties', target: 'docProps/app.xml' }
  ]), 'utf-8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml(blocks, doc.documentStyle), 'utf-8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(relsXml([
    { id: 1, type: 'styles', target: 'styles.xml' },
    { id: 2, type: 'numbering', target: 'numbering.xml' },
    { id: 3, type: 'settings', target: 'settings.xml' }
  ]), 'utf-8'));
  zip.addFile('word/styles.xml', Buffer.from(STYLES_XML, 'utf-8'));
  zip.addFile('word/numbering.xml', Buffer.from(NUMBERING_XML, 'utf-8'));
  zip.addFile('word/settings.xml', Buffer.from(settingsXml(), 'utf-8'));
  zip.addFile('docProps/core.xml', Buffer.from(coreXml(o.name || doc.name || '文档'), 'utf-8'));
  zip.addFile('docProps/app.xml', Buffer.from(appXml(blocks.length), 'utf-8'));

  const warnings = [];
  const drawings = Object.keys(doc.drawings || {});
  if (drawings.length) warnings.push(`${drawings.length} 个插图暂未写入 .docx`);
  return {
    buffer: zip.toBuffer(),
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    warnings,
    stats: { paragraphs: blocks.length }
  };
}

// ============ HTML / Markdown ============

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

function toHtml(doc, options) {
  const o = options || {};
  const blocks = toParagraphs(doc);
  if (!blocks.length) throw new Error('文档内容为空，无法导出');
  const title = esc(o.name || doc.name || '文档');
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;background:#f1f5f9;font-family:"Microsoft YaHei",system-ui,sans-serif;color:#111827;line-height:1.8}
.page{max-width:800px;margin:24px auto;background:#fff;padding:56px 64px;box-shadow:0 4px 24px rgba(15,23,42,.12)}
h1{font-size:26px}h2{font-size:22px}h3{font-size:19px}h4,h5{font-size:17px}p{margin:0 0 12px}
ul{margin:0 0 12px;padding-left:22px}@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}}
</style></head><body><div class="page">
<h1>${title}</h1>
${blocks.map(blockHtml).join('\n')}
</div></body></html>`;
  return { buffer: Buffer.from(html, 'utf-8'), ext: 'html', mime: 'text/html; charset=utf-8', warnings: [], stats: { paragraphs: blocks.length } };
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
    if (f === 'md' || f === 'markdown') return toMarkdown(doc, o);
    if (f !== 'docx') throw new Error('文档导出仅支持 .docx / .html / .md');
    return toDocx(doc, o);
  },
  toParagraphs,
  toDocx,
  toHtml,
  toMarkdown
};
