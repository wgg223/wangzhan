/**
 * 文档共享渲染层：把 Univer Docs 快照转换为格式无关的中间表示（IR）
 * 供 .docx 导出、HTML 导出、打印预览、阅读视图共用
 *
 * IR 结构：
 * {
 *   name, docType,
 *   sections: [{ properties, blocks }],
 *   styles: { namedStyles, characterStyles, paragraphStyles, textStyles },
 *   drawings: { [id]: drawing },
 *   hyperlinks: { [id]: { url, tooltip } },
 *   footnotes: { [id]: { content } },
 *   headers: { [sectionId]: headerBlocks },
 *   footers: { [sectionId]: footerBlocks },
 *   toc: [{ level, text, startIndex }],
 *   warnings: []
 * }
 */
'use strict';

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => XML_ESCAPE[ch]);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** cl:{r,g,b}（0–1 浮点）或 #rrggbb → #rrggbb */
function colorHex(cl, fallback) {
  if (!cl) return fallback || '#000000';
  if (typeof cl === 'string') return cl.startsWith('#') ? cl.toLowerCase() : '#' + cl.toLowerCase();
  const to2 = x => Math.max(0, Math.min(255, Math.round(num(x, 0) * (num(x, 0) <= 1 ? 255 : 1))));
  const hex = n => to2(n).toString(16).padStart(2, '0');
  return `#${hex(cl.r)}${hex(cl.g)}${hex(cl.b)}`;
}

// Univer NamedStyleType → HTML heading level
// 2=TITLE, 3=SUBTITLE, 4=HEADING_1, 5=HEADING_2, 6=HEADING_3, 7=HEADING_4, 8=HEADING_5
const NAMED_STYLE_HEADING = { 2: 1, 3: 2, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5 };

/**
 * 解析 textStyle（Univer 内部格式）为统一的样式对象
 * 支持两种格式：
 *   - { bl, it, ul:{tr}, st:{tr}, cl:{r,g,b,a}, fs, ff:{value} }（doc.styles 里的 tsId 引用）
 *   - { bold, italic, underline, strikethrough, color, fontSize, fontFamily }（直接内联）
 */
function normalizeTextStyle(ts) {
  if (!ts) return {};
  const out = {};
  if (ts.bl === 1 || ts.bl === true || ts.bold) out.bold = true;
  if (ts.it === 1 || ts.it === true || ts.italic) out.italic = true;
  if (ts.ul || ts.underline) out.underline = true;
  if (ts.st || ts.strikethrough) out.strikethrough = true;
  const cl = ts.cl || (ts.color ? { r: 0, g: 0, b: 0 } : null);
  if (cl) out.color = colorHex(cl);
  else if (typeof ts.color === 'string') out.color = ts.color;
  const fs = num(ts.fs, 0) || num(ts.fontSize, 0);
  if (fs > 0) out.fontSize = fs;
  const ff = (ts.ff && ts.ff.value) || ts.fontFamily;
  if (ff) out.fontFamily = ff;
  if (ts.backgroundColor) out.backgroundColor = ts.backgroundColor;
  if (ts.bgColor) out.backgroundColor = colorHex(ts.bgColor);
  return out;
}

/**
 * 从 doc.styles 里按 tsId 取样式
 */
function resolveStyle(tsId, docStyles) {
  if (!tsId || !docStyles) return {};
  return normalizeTextStyle(docStyles[tsId]);
}

/**
 * 解析段落的文本运行（textRuns）
 * 支持两种格式：
 *   A: { st, en, tsId }  — 绝对偏移 + 样式引用
 *   B: { startIndex, endIndex, textStyle } — 绝对偏移 + 内联样式
 */
function parseTextRuns(body, docStyles) {
  const textRuns = Array.isArray(body.textRuns) ? body.textRuns : [];
  return textRuns.map(tr => {
    const start = num(tr.st, num(tr.startIndex, 0));
    const end = num(tr.en, num(tr.endIndex, 0));
    let style;
    if (tr.tsId) {
      style = resolveStyle(tr.tsId, docStyles);
    } else if (tr.textStyle) {
      style = normalizeTextStyle(tr.textStyle);
    } else {
      style = {};
    }
    return { start, end, style };
  }).filter(tr => tr.end > tr.start);
}

/**
 * 解析 customRanges（超链接等内联范围）
 */
function parseCustomRanges(body) {
  const ranges = Array.isArray(body.customRanges) ? body.customRanges : [];
  return ranges.map(cr => ({
    startIndex: num(cr.startIndex, 0),
    endIndex: num(cr.endIndex, 0),
    rangeId: cr.rangeId,
    rangeType: num(cr.rangeType, -1),
    properties: cr.properties || {}
  }));
}

/**
 * 解析段落列表
 */
function parseParagraphs(body) {
  const paras = Array.isArray(body.paragraphs) ? body.paragraphs : [];
  return paras.slice().sort((a, b) => num(a.startIndex, 0) - num(b.startIndex, 0));
}

/**
 * 解析 section breaks
 */
function parseSectionBreaks(body) {
  const breaks = Array.isArray(body.sectionBreaks) ? body.sectionBreaks : [];
  if (!breaks.length) return [{ startIndex: 0 }];
  return breaks.slice().sort((a, b) => num(a.startIndex, 0) - num(b.startIndex, 0));
}

/** 分节符是否真的携带页面设置（用来过滤「每段一个」的历史脏数据） */
function hasSectionProperties(sb) {
  if (!sb) return false;
  return Boolean(sb.pageSize
    || sb.columnProperties
    || sb.headerFooterConfig
    || sb.pageOrient
    || sb.marginTop !== undefined
    || sb.marginBottom !== undefined
    || sb.marginLeft !== undefined
    || sb.marginRight !== undefined
    || sb.pageNumberStart !== undefined);
}

/**
 * 解析 customBlocks（表格、图片等嵌入块）
 */
function parseCustomBlocks(body) {
  const blocks = Array.isArray(body.customBlocks) ? body.customBlocks : [];
  return blocks.map(b => ({
    startIndex: num(b.startIndex, 0),
    blockType: b.blockType || 'custom',
    data: b
  }));
}

/**
 * 解析 drawings 字典为有序列表
 */
function parseDrawings(doc) {
  const drawings = doc.drawings || {};
  const order = Array.isArray(doc.drawingsOrder) ? doc.drawingsOrder : Object.keys(drawings);
  const map = {};
  order.forEach(id => {
    const d = drawings[id];
    if (d) map[id] = normalizeDrawing(d, id);
  });
  return map;
}

/**
 * 标准化 drawing 对象
 */
function normalizeDrawing(d, id) {
  return {
    id,
    type: d.blockType || d.type || 'image',
    src: d.url || d.src || d.imageSource || '',
    width: num(d.width, 200),
    height: num(d.height, 150),
    alt: d.alt || d.description || '',
    transform: d.transform || {}
  };
}

/**
 * 解析超链接注册表
 */
function parseHyperlinks(body) {
  const hl = body.hyperLinks;
  if (!hl) return {};
  const map = hl.hyperLinks || hl;
  const out = {};
  Object.keys(map).forEach(id => {
    const h = map[id];
    out[id] = {
      url: h.url || h.linkUrl || '',
      tooltip: h.tooltip || h.displayString || ''
    };
  });
  return out;
}

/**
 * 解析脚注
 */
function parseFootnotes(body) {
  const fn = body.footnotes;
  if (!fn) return {};
  const map = fn.footnotes || {};
  const out = {};
  Object.keys(map).forEach(id => {
    const f = map[id];
    out[id] = {
      content: f.content || f.text || '',
      paragraphs: f.paragraphs || []
    };
  });
  return out;
}

/**
 * 解析页眉/页脚配置
 */
function parseHeaderFooter(config) {
  if (!config) return { enabled: false, content: '' };
  return {
    enabled: Boolean(config.headerFooterId || config.content || config.paragraphs),
    content: config.content || '',
    paragraphs: config.paragraphs || [],
    type: config.type || 'default'
  };
}

/**
 * 构建文档 IR
 * @param {object} doc - Univer Docs 快照
 * @returns {object} IR
 */
function buildDocumentIR(doc) {
  const body = doc.body || {};
  const documentStyle = doc.documentStyle || {};
  const docStyles = doc.styles || {};
  const dataStream = String(body.dataStream || '');

  const warnings = [];
  const rawBreaks = Array.isArray(body.sectionBreaks) ? body.sectionBreaks : [];
  const sectionBreaks = rawBreaks.length
    ? parseSectionBreaks(body)
    : [{ startIndex: Math.max(0, dataStream.length - 1) }];
  const paragraphs = parseParagraphs(body);
  const textRuns = parseTextRuns(body, docStyles);
  const customBlocks = parseCustomBlocks(body);
  const customRanges = parseCustomRanges(body);
  const drawings = parseDrawings(doc);
  const hyperlinks = parseHyperlinks(body);
  const footnotes = parseFootnotes(body);

  // Univer 中 paragraph.startIndex 指向段落结束符 \r 的位置，
  // 段落正文是「上一段落结束处 → 本段 startIndex」这一段，不是从 startIndex 开始
  const paraRanges = [];
  {
    let cursor = 0;
    paragraphs.forEach(p => {
      const end = num(p.startIndex, cursor);
      const text = dataStream.slice(cursor, Math.max(cursor, end));
      paraRanges.push({
        para: p,
        start: cursor,
        end: Math.max(cursor, end),
        text: text.replace(/\r\n$/, '')
      });
      cursor = Math.max(cursor, end) + 2;
    });
  }

  // 只有带页面属性的分节符才真的开一节；
  // 早期导入器给每个段落都塞了一个 sectionBreak，这类必须折叠成一节
  const meaningfulBreaks = sectionBreaks.filter((sb, i) =>
    i === sectionBreaks.length - 1 || hasSectionProperties(sb)
  );
  if (meaningfulBreaks.length !== sectionBreaks.length) {
    warnings.push('分节符数量与段落不符，已按单节渲染');
  }
  const boundaries = meaningfulBreaks.map(sb => num(sb.startIndex, dataStream.length));

  const sectionOf = (idx) => {
    for (let i = 0; i < boundaries.length; i++) {
      if (idx <= boundaries[i]) return i;
    }
    return Math.max(0, boundaries.length - 1);
  };

  // 按 section 分组
  const sections = meaningfulBreaks.map((sb, idx) => {
    const startIdx = idx === 0 ? 0 : boundaries[idx - 1] + 1;
    const endIdx = boundaries[idx];

    // 解析 section 属性
    const sectionProps = {
      pageSize: sb.pageSize || documentStyle.pageSize || { width: 595, height: 842 },
      margins: {
        top: num(sb.marginTop, num(documentStyle.marginTop, 72)),
        bottom: num(sb.marginBottom, num(documentStyle.marginBottom, 72)),
        left: num(sb.marginLeft, num(documentStyle.marginLeft, 90)),
        right: num(sb.marginRight, num(documentStyle.marginRight, 90)),
      },
      columns: sb.columnProperties || documentStyle.columnProperties || [{ width: 0, gap: 0 }],
      pageNumberStart: num(sb.pageNumberStart, num(documentStyle.pageNumberStart, 1)),
      pageOrient: sb.pageOrient || documentStyle.pageOrient || 'portrait',
      headerFooter: sb.headerFooterConfig || documentStyle.headerFooterConfig || {},
    };

    // 构建 block 列表（段落 + 嵌入块，按位置排序）
    const allItems = [];

    paraRanges.forEach(pr => {
      if (sectionOf(pr.end) !== idx) return;
      allItems.push({ type: 'paragraph', startIndex: pr.start, order: pr.end, data: pr });
    });
    customBlocks.forEach(b => {
      const bIdx = num(b.startIndex, 0);
      if (bIdx < startIdx || bIdx > endIdx) return;
      allItems.push({ type: 'block', startIndex: bIdx, order: bIdx, data: b });
    });
    allItems.sort((a, b) => a.order - b.order);

    const blocks = [];
    allItems.forEach(item => {
      if (item.type === 'paragraph') {
        const pr = item.data;
        const paraStyle = pr.para.paragraphStyle || {};

        // 提取此段落内的 textRuns
        const paraRuns = textRuns.filter(tr => tr.start < pr.end && tr.end > pr.start);
        const runs = buildRuns(pr.text, pr.start, paraRuns);

        // 提取此段落内的 customRanges（超链接、脚注引用等）
        const paraRangesHere = customRanges.filter(cr =>
          cr.startIndex < pr.end && cr.endIndex > pr.start
        );

        blocks.push({
          type: 'paragraph',
          startIndex: pr.start,
          text: pr.text,
          runs,
          paragraphStyle: normalizeParagraphStyle(paraStyle),
          ranges: paraRangesHere.map(cr => ({
            start: Math.max(0, cr.startIndex - pr.start),
            end: Math.min(pr.text.length, cr.endIndex - pr.start),
            rangeId: cr.rangeId,
            rangeType: cr.rangeType,
            properties: cr.properties
          }))
        });
      } else {
        const cb = item.data;
        const blockType = cb.data.blockType || cb.data.type || 'custom';

        if (blockType === 'table' || cb.data.table) {
          blocks.push({
            type: 'table',
            startIndex: item.startIndex,
            data: normalizeTableData(cb.data)
          });
        } else if (blockType === 'image' || cb.data.image) {
          const drawingId = cb.data.drawingId || (cb.data.image && cb.data.image.drawingId);
          blocks.push({
            type: 'image',
            startIndex: item.startIndex,
            data: drawingId && drawings[drawingId]
              ? drawings[drawingId]
              : normalizeDrawing(cb.data.image || cb.data, drawingId || 'inline')
          });
        } else {
          blocks.push({
            type: 'custom',
            startIndex: item.startIndex,
            data: cb.data
          });
        }
      }
    });

    return {
      id: idx,
      properties: sectionProps,
      blocks,
      header: parseHeaderFooter(sectionProps.headerFooter.header),
      footer: parseHeaderFooter(sectionProps.headerFooter.footer),
    };
  });

  // 如果没有 section，创建一个默认的
  if (!sections.length) {
    sections.push({
      id: 0,
      properties: {
        pageSize: documentStyle.pageSize || { width: 595, height: 842 },
        margins: {
          top: num(documentStyle.marginTop, 72),
          bottom: num(documentStyle.marginBottom, 72),
          left: num(documentStyle.marginLeft, 90),
          right: num(documentStyle.marginRight, 90),
        },
        columns: [{ width: 0, gap: 0 }],
        pageNumberStart: 1,
        pageOrient: 'portrait',
      },
      blocks: [],
      header: { enabled: false, content: '' },
      footer: { enabled: false, content: '' },
    });
  }

  // 提取目录
  const toc = extractToc(sections);

  return {
    name: doc.name || '文档',
    docType: doc.docType || 'document',
    sections,
    styles: {
      namedStyles: doc.namedStyles || {},
      characterStyles: doc.characterStyles || docStyles || {},
      paragraphStyles: doc.paragraphStyles || {},
      textStyles: docStyles,
    },
    drawings,
    hyperlinks,
    footnotes,
    toc,
    warnings,
    dataStream,
  };
}

/**
 * 构建段落内的 runs（文本 + 样式片段）
 */
function buildRuns(text, paraStart, textRuns) {
  if (!text) return [];
  const runs = [];
  let pos = 0;

  const sorted = textRuns.slice().sort((a, b) => a.start - b.start);
  sorted.forEach(tr => {
    const runStart = Math.max(0, tr.start - paraStart);
    const runEnd = Math.min(text.length, tr.end - paraStart);
    if (runEnd <= runStart) return;

    if (runStart > pos) {
      runs.push({ text: text.slice(pos, runStart), style: {} });
    }
    runs.push({ text: text.slice(runStart, runEnd), style: tr.style });
    pos = runEnd;
  });

  if (pos < text.length) {
    runs.push({ text: text.slice(pos), style: {} });
  }

  return runs.filter(r => r.text.length > 0);
}

/**
 * 标准化段落样式
 */
function normalizeParagraphStyle(ps) {
  if (!ps) return {};
  const out = {};
  if (ps.namedStyleType) out.headingLevel = NAMED_STYLE_HEADING[num(ps.namedStyleType, 0)] || 0;
  if (ps.namedStyleType) out.namedStyleType = num(ps.namedStyleType, 0);
  if (ps.listType) {
    out.listType = ps.listType;
    out.listHanging = ps.hanging ? num(ps.hanging.v, 0) : 0;
    out.listIndent = ps.indentStart ? num(ps.indentStart.v, 0) : 0;
  }
  if (ps.alignment) out.textAlign = ps.alignment;
  if (ps.spacing) out.spacing = ps.spacing;
  if (ps.indent) out.indent = ps.indent;
  return out;
}

/**
 * 标准化表格数据
 */
function normalizeTableData(data) {
  const table = data.table || data;
  const rows = table.rows || [];
  return {
    rows: rows.map(row => ({
      cells: (row.cells || []).map(cell => ({
        text: cell.text || cell.content || '',
        rowSpan: num(cell.rowSpan, 1),
        colSpan: num(cell.colSpan, 1),
        style: cell.style || {}
      }))
    })),
    colWidths: table.colWidths || [],
    style: table.style || {}
  };
}

/**
 * 从 IR 提取目录
 */
function extractToc(sections) {
  const toc = [];
  sections.forEach(section => {
    section.blocks.forEach(block => {
      if (block.type === 'paragraph' && block.paragraphStyle.headingLevel) {
        const level = block.paragraphStyle.headingLevel;
        if (level >= 1 && level <= 6) {
          const text = block.runs.map(r => r.text).join('');
          if (text.trim()) {
            toc.push({
              level,
              text: text.trim(),
              startIndex: block.startIndex
            });
          }
        }
      }
    });
  });
  return toc;
}

module.exports = { buildDocumentIR, extractToc, normalizeTextStyle, colorHex, esc, num };
