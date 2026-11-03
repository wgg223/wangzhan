/**
 * 在线 Office 文件导入：按扩展名分发到对应解析器，产出各类型的文档快照
 *
 * 支持格式 → 目标类型：
 *   .xlsx / .xls / .csv            → spreadsheet（SheetJS，见 spreadsheet-univer-io.js）
 *   .docx                          → document   （mammoth → HTML → Univer Docs 快照）
 *   .pptx                          → presentation（OOXML slideN.xml → 自绘幻灯片模型）
 *   .doc / .ppt（旧版二进制 OLE）  → 无纯 JS 解析器，需服务器装 LibreOffice（soffice）先转新格式
 *
 * 设计要点：
 *   - 统一返回 { docType, doc, stats, warnings }，路由按 docType 落库，避免各处判断扩展名；
 *   - 解析失败/格式不支持抛 Error，由路由转成 400 提示；
 *   - .doc/.ppt 自动探测并使用 LibreOffice（未安装则返回可操作提示）；
 *   - 幻灯片坐标由 EMU（English Metric Unit，914400 EMU = 1 英寸）换算到 960x540 逻辑画布。
 */
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { importBufferToUniverDoc } = require('./spreadsheet-univer-io');
const libreoffice = require('./libreoffice');
const { uploadsDir } = require('../config/app-root');

const EMU_PER_INCH = 914400;
const SLIDE_W = 960; // 与编辑器 createEmptyPresentation 保持同一逻辑画布
const SLIDE_H = 540;

// 导入文件大小上限：解析器需要整包 Buffer（SheetJS / mammoth / adm-zip 都不支持流式），
// 2GB 服务器上再高就有堆溢出风险，可用 OFFICE_IMPORT_MAX_MB 在 1–200 之间调整
const MAX_IMPORT_MB = Math.min(200, Math.max(1, Number(process.env.OFFICE_IMPORT_MAX_MB) || 50));
const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024;

// 同一时刻只允许一个导入解析（峰值内存 = 原文件 + 解析产物，并发极易打满堆内存）
const importSlot = { busy: false };
function claimSlot() {
  if (importSlot.busy) return false;
  importSlot.busy = true;
  return true;
}

// 各扩展名对应的文档类型
const EXT_DOC_TYPE = {
  xlsx: 'spreadsheet', xls: 'spreadsheet', csv: 'spreadsheet',
  docx: 'document',
  pptx: 'presentation',
  doc: 'document', ppt: 'presentation'
};

/** 识别扩展名（小写，不含点） */
function extOf(filename) {
  return (String(filename || '').split('.').pop() || '').toLowerCase();
}

/** 扩展名 → 目标文档类型（未知扩展名返回 null） */
function docTypeOf(filename) {
  return EXT_DOC_TYPE[extOf(filename)] || null;
}

// ============ .docx → Univer Docs 快照 ============

// 十进制实体与常用命名实体
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', divide: '÷', deg: '°',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
  laquo: '«', raquo: '»', lsqb: '[', rsqb: ']', lsqb2: '['
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : m;
    });
}

// Univer 的 NamedStyleType 枚举（内建样式表按数字键取用，此版本最高到 HEADING_5=8）
const NAMED_STYLE = { TITLE: 2, SUBTITLE: 3, HEADING_1: 4, HEADING_5: 8 };
const BULLET_LIST = 'BULLET_LIST'; // Univer 预设列表类型

/**
 * 解析 mammoth 产出的 HTML，得到「段落 → 文本片段」结构
 * 只处理 Word 常见的块级与行内标签，其余标签按纯文本展开
 * @returns {Array<{runs: Array<{text, style}>, paragraphStyle: object}>}
 */
function parseDocxHtml(html) {
  const blocks = [];
  // 块级标签切分：h1-h6 / p / li / 表格单元格行 / 普通 div
  const blockRe = /<(h[1-6]|p|li|td|th|div)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let matched = false;
  while ((m = blockRe.exec(html)) !== null) {
    matched = true;
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const runs = parseInlineRuns(inner);
    const text = runs.map(r => r.text).join('').trim();
    if (!text && !runs.length) continue;
    // <li> 嵌在 <ul>/<ol> 里会被上面的正则各取一次，无需额外处理
    const paragraphStyle = {};
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag.slice(1), 10);
      // h1 用作文档主标题；其余按层级映射（HEADING_1=4 对应 h2），超出 HEADING_5 的并入 HEADING_5
      paragraphStyle.namedStyleType = level === 1 ? NAMED_STYLE.TITLE
        : Math.min(NAMED_STYLE.HEADING_1 + level - 1, NAMED_STYLE.HEADING_5);
    } else if (tag === 'li') {
      paragraphStyle.listType = BULLET_LIST;
      paragraphStyle.hanging = { v: 21 };
      paragraphStyle.indentStart = { v: 21 };
    }
    blocks.push({ runs, paragraphStyle });
  }
  // 没有识别出任何块（例如纯文本片段）时按换行分段，避免整篇丢空
  if (!matched) {
    const plain = decodeEntities(html.replace(/<[^>]+>/g, '')).split(/\r?\n/);
    for (const line of plain) {
      if (!line.trim()) continue;
      blocks.push({ runs: [{ text: line.trim(), style: {} }], paragraphStyle: {} });
    }
  }
  return blocks;
}

/** 行内标签 → 带样式的文本片段序列 */
function parseInlineRuns(inner) {
  const runs = [];
  const styleStack = [];
  // 依次匹配标签与文本，标签栈维护加粗/斜体/下划线/颜色/链接
  const tokenRe = /<([a-z]+)([^>]*)>|<\/([a-z]+)>|([^<]+)/gi;
  let t;
  while ((t = tokenRe.exec(inner)) !== null) {
    if (t[3]) { // 闭合标签
      const tag = t[3].toLowerCase();
      for (let i = styleStack.length - 1; i >= 0; i--) {
        if (styleStack[i].tag === tag) { styleStack.splice(i, 1); break; }
      }
      continue;
    }
    if (t[1]) { // 开始标签
      const tag = t[1].toLowerCase();
      const attrs = t[2] || '';
      if (tag === 'br') { runs.push({ text: '\n', style: currentStyle(styleStack) }); continue; }
      if (tag === 'img') { continue; } // 图片在 convertDocx 中单独统计并提示
      const style = {};
      if (tag === 'strong' || tag === 'b') style.bl = 1;
      if (tag === 'em' || tag === 'i') style.it = 1;
      if (tag === 'u') style.ul = { tr: 1 };
      if (tag === 's' || tag === 'strike') style.st = { tr: 1 };
      const colorMatch = /color:\s*#([0-9a-f]{6})/i.exec(attrs);
      if (colorMatch) style.cl = hexToRgb(colorMatch[1]);
      const sizeMatch = /font-size:\s*(\d+(?:\.\d+)?)pt/i.exec(attrs);
      // Univer 的 fs 与 Word 一样以磅为单位，直接沿用数值
      if (sizeMatch) style.fs = Math.round(parseFloat(sizeMatch[1]));
      styleStack.push({ tag, style });
      continue;
    }
    const text = decodeEntities(t[4]);
    if (text) runs.push({ text, style: currentStyle(styleStack) });
  }
  return runs.filter(r => r.text.length > 0);
}

function currentStyle(stack) {
  const merged = {};
  stack.forEach(s => Object.assign(merged, s.style));
  return merged;
}

function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

/**
 * Word 样式名 → 标题级别
 * mammoth 只认英文内建样式名，中文版 Word 的「标题 1」「标题」等必须显式映射，
 * 否则整篇按普通段落输出，导入后没有大纲层级。
 */
const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1",
  "p[style-name='标题'] => h1",
  "p[style-name='Subtitle'] => h2",
  "p[style-name='副标题'] => h2",
  "p[style-name='Heading 1'] => h1",
  "p[style-name='标题 1'] => h1",
  "p[style-name='Heading 2'] => h2",
  "p[style-name='标题 2'] => h2",
  "p[style-name='Heading 3'] => h3",
  "p[style-name='标题 3'] => h3",
  "p[style-name='Heading 4'] => h4",
  "p[style-name='标题 4'] => h4",
  "p[style-name='Heading 5'] => h5",
  "p[style-name='标题 5'] => h5",
  "p[style-name='Heading 6'] => h6",
  "p[style-name='标题 6'] => h6"
];

/**
 * .docx → Univer Docs 快照
 * 说明：mammoth 只输出结构与 b/i/u/s，Word 里的字体颜色、字号等直接格式不会出现在 HTML 中，
 * 因此导入结果保留大纲层级与强调样式，不承诺像素级还原。
 * @param {Buffer} buffer docx 内容
 * @param {string} docName 文档名
 */
async function convertDocx(buffer, docName) {
  const result = await mammoth.convertToHtml({ buffer }, { styleMap: DOCX_STYLE_MAP });
  const blocks = parseDocxHtml(result.value || '');

  // 组装 dataStream：每个段落以 \r\n 结束（Univer 段落分隔符固定占 2 个字符）
  let dataStream = '';
  const paragraphs = [];
  const sectionBreaks = [];
  const textRuns = [];
  const styles = {};
  let styleSeq = 0;

  blocks.forEach((block) => {
    block.runs.forEach((run) => {
      const st = dataStream.length;
      dataStream += run.text;
      const en = dataStream.length;
      if (en > st) {
        const keys = Object.keys(run.style);
        let tsId = null;
        if (keys.length) {
          tsId = 'ts-' + (++styleSeq);
          styles[tsId] = run.style;
        }
        textRuns.push(tsId ? { st, en, tsId } : { st, en });
      }
    });
    dataStream += '\r\n';
    const breakIndex = dataStream.length - 2; // \r 所在位置
    paragraphs.push({ startIndex: breakIndex, paragraphStyle: block.paragraphStyle });
    sectionBreaks.push({ startIndex: dataStream.length - 1 });
  });

  if (!paragraphs.length) {
    dataStream = '\r\n';
    paragraphs.push({ startIndex: 0, paragraphStyle: {} });
    sectionBreaks.push({ startIndex: 1 });
  }

  const images = (result.value.match(/<img/gi) || []).length;
  const warnings = [];
  if (images) warnings.push(`已忽略 ${images} 张图片（.docx 图片暂不支持导入）`);
  (result.messages || [])
    .filter(msg => msg && msg.type === 'warning')
    .slice(0, 3)
    .forEach(msg => warnings.push('Word 样式提示：' + msg.message));

  return {
    doc: {
      id: 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      appVersion: '1.0.0',
      name: docName || '导入的文档',
      docType: 'document',
      body: {
        dataStream, sectionBreaks, paragraphs, textRuns,
        hyperLinks: { hyperLinks: {} }, customRanges: [], customMarks: []
      },
      styles,
      documentStyle: {
        pageSize: { width: 595, height: 842 },
        marginTop: 72, marginBottom: 72, marginLeft: 90, marginRight: 90
      },
      drawings: {},
      drawingsOrder: [],
      resources: '[]'
    },
    stats: { paragraphs: paragraphs.length, chars: dataStream.length, images },
    warnings
  };
}

// ============ .pptx → 自绘幻灯片模型 ============

/** XML 属性数值解析（失败返回默认值） */
function attrInt(attrs, name, fallback) {
  const m = new RegExp('\\b' + name + '="(-?[\\d.]+)"').exec(attrs || '');
  return m ? parseFloat(m[1]) : fallback;
}

function hexColor(hex) {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return '#' + hex.toLowerCase();
}

/** 从 <a:p> 段落串中提取纯文本（丢弃字段占位符） */
function extractParaText(xml) {
  let text = '';
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) text += decodeEntities(m[1]);
  return text;
}

/** EMU → 逻辑画布坐标（按轴缩放系数换算） */
function emuToPx(attrs, name, scale, fallback) {
  const m = new RegExp('\\b' + name + '="(-?\\d+)"').exec(attrs || '');
  if (!m) return fallback;
  return parseInt(m[1], 10) * scale;
}

// 源文件里的 prstGeom → 编辑器形状名
const PRST_TO_SHAPE = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', tri: 'triangle',
  diamond: 'diamond', hexagon: 'hexagon', parallelogram: 'parallelogram',
  rightArrow: 'rightArrow', leftArrow: 'leftArrow', star5: 'star', star4: 'star', star48: 'star',
  chevron: 'chevron', line: 'line', lineInv: 'line'
};
// 可安全落盘给浏览器显示的图片扩展名
const IMPORTABLE_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 单图
const MAX_MEDIA_TOTAL = 24 * 1024 * 1024; // 单次导入图片总量
const MAX_MEDIA_COUNT = 80; // 单次导入图片数量

/**
 * 解析结果里的图片先留在内存，整篇解析成功后才落盘，避免失败导入留下垃圾文件
 * 落盘路径与编辑器图片上传一致（/uploads/office/…），导出 pptx 时可直接读回
 */
function createImportMediaSink() {
  const token = crypto.randomBytes(8).toString('hex');
  const dir = path.join(uploadsDir, 'office', 'import', token);
  const urlBase = `/uploads/office/import/${token}`;
  const pending = [];
  let total = 0;
  let skipped = 0;
  return {
    /** @returns {string|null} 可引用的 URL；被限额或格式过滤掉时返回 null */
    add(fileName, buffer) {
      const ext = (String(fileName).split('.').pop() || '').toLowerCase();
      if (!IMPORTABLE_IMAGE_EXT.includes(ext) || !buffer || !buffer.length) {
        skipped += 1;
        return null;
      }
      if (pending.length >= MAX_MEDIA_COUNT || buffer.length > MAX_MEDIA_BYTES
        || total + buffer.length > MAX_MEDIA_TOTAL) {
        skipped += 1;
        return null;
      }
      total += buffer.length;
      pending.push({
        name: `${token.slice(0, 8)}-${pending.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
        buffer
      });
      return `${urlBase}/${pending[pending.length - 1].name}`;
    },
    /** 写盘，返回写入数量 */
    // 导入全程同步解析，落盘也保持同步，避免半途失败的图片被引用到
    /* eslint-disable no-sync */
    commit() {
      if (!pending.length) return 0;
      fs.mkdirSync(dir, { recursive: true });
      pending.forEach(f => fs.writeFileSync(path.join(dir, f.name), f.buffer));
      const n = pending.length;
      pending.length = 0;
      return n;
    },
    /* eslint-enable no-sync */
    get skipped() { return skipped; },
    get count() { return pending.length; }
  };
}

/** 解析 OOXML 部件的关系表：rId → { target, external, path } */
function pptxRels(zip, partPath) {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash);
  const name = slash < 0 ? partPath : partPath.slice(slash + 1);
  const xml = zip.readAsText(`${dir}/_rels/${name}.rels`);
  const map = new Map();
  (xml.match(/<Relationship\s[^>]*>/gi) || []).forEach(tag => {
    const id = /\bId="([^"]+)"/.exec(tag);
    const target = /\bTarget="([^"]+)"/.exec(tag);
    if (!id || !target) return;
    const external = /TargetMode="External"/i.test(tag);
    let t = decodeEntities(target[1]).replace(/\\/g, '/');
    let abs = null;
    if (!external) {
      // 以 / 开头是包内绝对路径，其余相对当前部件所在目录
      const joined = t.startsWith('/') ? t.slice(1) : (dir ? `${dir}/${t}` : t);
      const segs = [];
      joined.split('/').forEach(seg => {
        if (!seg || seg === '.') return;
        if (seg === '..') segs.pop();
        else segs.push(seg);
      });
      abs = segs.join('/');
    }
    map.set(id[1], { target: t, external, path: abs });
  });
  return map;
}

/** 从压缩包里按部件路径读二进制；条目缺失或损坏时返回 null，交由调用方计数 */
function zipBuffer(zip, relPath) {
  if (!zip || !relPath) return null;
  try {
    const entry = zip.getEntry(relPath);
    return entry ? entry.getData() : null;
  } catch (e) {
    return null;
  }
}

/** 取纯色填充（先剔除描边，noFill 视为无填充；渐变等复杂填充不映射） */
function fillColorOf(scope) {
  const clean = String(scope || '')
    .replace(/<a:ln[^>]*>[\s\S]*?<\/a:ln>/g, '')
    .replace(/<a:ln[^>]*\/>/g, '');
  const solid = /<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(clean);
  if (!solid) return null;
  if (/<a:noFill\/>/.test(clean.slice(0, solid.index))) return null;
  return pickColor(solid[1]);
}

/** 在指定 XML 片段里找颜色（可先剔除 <a:ln> 之类干扰） */
function pickColor(scope) {
  const m = /<a:srgbClr val="([0-9a-fA-F]{6})"/.exec(scope || '');
  return m ? hexColor(m[1]) : null;
}

/** 取 <p:spPr> / <p:grpSpPr> 等属性块 */
function spPrOf(xml) {
  const m = /<p:spPr([^>]*)>([\s\S]*?)<\/p:spPr>/.exec(xml) || /<p:spPr([^>]*)\/>/.exec(xml);
  return m ? (m[2] || '') : '';
}

/** 段落串 → 文本元素样式（取首个有效运行的属性） */
function paraStyleOf(inner, dims) {
  const runRe = /<a:rPr([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/.exec(inner);
  const attrs = runRe ? runRe[1] : '';
  const runInner = (runRe && runRe[2]) || '';
  const style = {};
  const sz = attrInt(attrs, 'sz', 0);
  style.fontSize = sz ? Math.max(10, Math.round(sz / 100 * 4 / 3 * dims.fontScale)) : 18;
  if (/\bb="(1|true)"/.test(attrs)) style.fontWeight = 'bold';
  if (/\bi="(1|true)"/.test(attrs)) style.fontStyle = 'italic';
  if (/u="(sng|dash|words)"/.test(attrs)) style.underline = true;
  if (/strike="(sngStrike|dblStrike)"/.test(attrs)) style.strike = true;
  const align = /\balgn="([^"]+)"/.exec(inner);
  style.textAlign = align ? (align[1] === 'ctr' ? 'center' : (align[1] === 'r' ? 'right' : 'left')) : 'left';
  style.color = pickColor(runInner) || pickColor(inner) || '#333333';
  return style;
}

/**
 * 单个 <p:sp> → 文本元素或形状元素
 * 带几何图形（或填充/描边）的按形状导入并保留其中的文字，纯文本框按文本导入
 */
function parsePptxShape(shapeXml, dims, rels) {
  const off = /<a:off([^/>]*)\/?>/.exec(shapeXml);
  const ext = /<a:ext([^/>]*)\/?>/.exec(shapeXml);
  const x = emuToPx(off ? off[1] : '', 'x', dims.scaleX, 0);
  const y = emuToPx(off ? off[1] : '', 'y', dims.scaleY, 0);
  const w = emuToPx(ext ? ext[1] : '', 'cx', dims.scaleX, SLIDE_W / 2);
  const h = emuToPx(ext ? ext[1] : '', 'cy', dims.scaleY, SLIDE_H / 4);
  const xfrm = /<a:xfrm([^>]*?)(?:\/>|>)/.exec(shapeXml);
  const rot = xfrm ? attrInt(xfrm[1], 'rot', 0) : 0;

  const paras = [];
  const paraRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
  let pm;
  while ((pm = paraRe.exec(shapeXml)) !== null) {
    const text = extractParaText(pm[1]);
    if (!text.trim()) continue;
    paras.push({ text, style: paraStyleOf(pm[1], dims) });
  }

  const spPr = spPrOf(shapeXml);
  const geom = /<a:prstGeom\s+prst="([^"]+)"/.exec(spPr);
  const shapeName = geom ? (PRST_TO_SHAPE[geom[1]] || null) : null;
  const hasText = paras.length > 0;
  if (!hasText && !shapeName) return null;

  const fill = fillColorOf(spPr);
  const lnScope = /<a:ln([^>]*?)(?:\/>|>([\s\S]*?)<\/a:ln>)/.exec(spPr);
  const stroke = lnScope ? pickColor(lnScope[2] || '') : null;

  const el = {
    x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h)
  };
  if (rot) el.rotation = Math.round((((rot / 60000) % 360) + 360) % 360);
  const alpha = /<a:alpha val="(\d+)"/.exec(spPr);
  if (alpha) el.opacity = Math.max(0, Math.min(1, parseInt(alpha[1], 10) / 100000));

  // PowerPoint 的普通文本框同样带 prst="rect"（且有 txBox="1" 标记），
  // 只有非常用几何、或有填充/描边时才按形状导入
  const isTextBox = /<p:cNvSpPr\b[^>]*\btxBox="1"/.test(shapeXml);
  const boxLike = !shapeName || shapeName === 'rect' || shapeName === 'line';
  const asShape = hasText ? (!isTextBox && (!boxLike || Boolean(fill) || Boolean(stroke))) : Boolean(shapeName);
  el.type = asShape ? 'shape' : 'text';

  if (asShape) {
    el.shape = shapeName || 'rect';
    el.style = {
      fill: fill || '#4472C4',
      stroke,
      strokeWidth: lnScope ? Math.max(1, Math.round(attrInt(lnScope[1], 'w', 12700) / 12700)) : 1,
      radius: el.shape === 'roundRect' ? roundRectRadius(spPr, Math.min(w, h)) : 12
    };
    if (!el.style.stroke) delete el.style.stroke;
  }

  if (hasText) {
    const base = paras[0].style;
    el.content = paras.map(p => p.text).join('\n');
    const textStyle = {
      fontSize: Math.max(...paras.map(p => p.style.fontSize)),
      fontFamily: base.fontFamily,
      fontWeight: base.fontWeight || 'normal',
      fontStyle: base.fontStyle || 'normal',
      underline: Boolean(base.underline),
      strike: Boolean(base.strike),
      textAlign: base.textAlign || 'left',
      color: base.color || '#333333'
    };
    const bodyPr = /<a:bodyPr([^>]*)/.exec(shapeXml);
    const anchor = bodyPr && /anchor="(ctr|b)"/.exec(bodyPr[1]);
    if (anchor) textStyle.valign = anchor[1] === 'ctr' ? 'middle' : 'bottom';
    // 文本框的填充改作背景色，形状保留上面的 fill/stroke
    if (!asShape && fill) textStyle.backgroundColor = fill;
    el.style = Object.assign(el.style || {}, textStyle);
  }

  const link = pickPptxLink(shapeXml, rels);
  if (link) el.link = link;
  return el;
}

function pickPptxLink(xml, rels) {
  const m = /<a:hlinkClick[^>]*\br:id="([^"]+)"/.exec(xml);
  if (!m) return null;
  const rel = rels.get(m[1]);
  if (!rel || !rel.external) return null;
  return /^(https?:|mailto:)/i.test(rel.target) ? rel.target : null;
}

/** roundRect 的 adj 是「半径 / 短边一半」的千分比，反推回逻辑像素 */
function roundRectRadius(spPr, minSidePx) {
  const gd = /<a:gd\s+name="adj"[^>]*fmla="val\s+(\d+)"/.exec(spPr);
  if (!gd) return 12;
  return Math.max(0, Math.min(240, Math.round(parseInt(gd[1], 10) / 50000 * Math.max(1, minSidePx / 2))));
}

/** <p:pic> → 图片元素；媒体读不出或被限额拦下时返回 null，由调用方计数 */
function parsePptxPic(picXml, dims, rels, sink, zip) {
  const blip = /<a:blip\b[^>]*>/.exec(picXml);
  if (!blip) return null;
  const embed = /\br:embed="([^"]+)"/.exec(blip[0]);
  const link = /\br:link="([^"]+)"/.exec(blip[0]);
  let url = null;
  const emb = embed && rels.get(embed[1]);
  if (emb && emb.path) {
    const buf = zipBuffer(zip, emb.path);
    if (buf) url = sink.add(emb.path.split('/').pop(), buf);
  }
  // 外链图片不落盘，直接引用原始地址
  const ext = !url && link && rels.get(link[1]);
  if (ext && ext.external && /^(https?:)?\/\//i.test(ext.target)) url = ext.target;
  if (!url) return null;
  const off = /<a:off([^/>]*)\/?>/.exec(picXml);
  const sz = /<a:ext([^/>]*)\/?>/.exec(picXml);
  const spPr = spPrOf(picXml);
  const el = {
    type: 'image', src: url,
    x: Math.round(emuToPx(off ? off[1] : '', 'x', dims.scaleX, 0)),
    y: Math.round(emuToPx(off ? off[1] : '', 'y', dims.scaleY, 0)),
    width: Math.round(emuToPx(sz ? sz[1] : '', 'cx', dims.scaleX, SLIDE_W / 4)),
    height: Math.round(emuToPx(sz ? sz[1] : '', 'cy', dims.scaleY, SLIDE_H / 4)),
    // 源文件裁切过 → 铺满显示，否则完整显示
    style: { objectFit: /<a:srcRect\b[^>]*\b[tlrb]="\d+"/.test(picXml) ? 'cover' : 'contain' }
  };
  const radius = /<a:prstGeom\s+prst="roundRect"/.test(spPr)
    ? roundRectRadius(spPr, Math.min(el.width, el.height)) : 0;
  if (radius) el.style.radius = radius;
  const ln = /<a:ln([^>]*?)(?:\/>|>([\s\S]*?)<\/a:ln>)/.exec(spPr);
  if (ln) {
    const c = pickColor(ln[2] || '');
    if (c) {
      el.style.border = c;
      el.style.borderWidth = Math.max(1, Math.round(attrInt(ln[1], 'w', 12700) / 12700));
    }
  }
  const blipBody = /<a:blip\b[\s\S]*?(?:<\/a:blip>|\/>)/.exec(picXml);
  const alphaFix = blipBody && /<a:alphaModFix\b[^>]*\bamt="(\d+)"/.exec(blipBody[0]);
  if (alphaFix) el.opacity = Math.max(0, Math.min(1, parseInt(alphaFix[1], 10) / 100000));
  const xfrm = /<a:xfrm([^>]*?)(?:\/>|>)/.exec(picXml);
  const rot = xfrm ? attrInt(xfrm[1], 'rot', 0) : 0;
  if (rot) el.rotation = Math.round((((rot / 60000) % 360) + 360) % 360);
  const click = pickPptxLink(picXml, rels);
  if (click) el.link = click;
  return el;
}

/** <p:graphicFrame> 里的 <a:tbl> → 表格元素 */
function parsePptxTable(frameXml, dims) {
  const tbl = /<a:tbl>([\s\S]*?)<\/a:tbl>/.exec(frameXml);
  if (!tbl) return null;
  const off = /<a:off([^/>]*)\/?>/.exec(frameXml);
  const ext = /<a:ext([^/>]*)\/?>/.exec(frameXml);
  const width = Math.round(emuToPx(ext ? ext[1] : '', 'cx', dims.scaleX, SLIDE_W / 2));
  const height = Math.round(emuToPx(ext ? ext[1] : '', 'cy', dims.scaleY, SLIDE_H / 6));
  const gridCols = [...tbl[1].matchAll(/<a:gridCol[^>]*\bw="(\d+)"/g)].map(m => parseInt(m[1], 10));
  const rows = [];
  const trRe = /<a:tr[^>]*>([\s\S]*?)<\/a:tr>/gi;
  let tr;
  while ((tr = trRe.exec(tbl[1])) !== null) {
    const cells = [];
    const tcRe = /<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/gi;
    let tc;
    while ((tc = tcRe.exec(tr[1])) !== null) {
      const paras = [];
      const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
      let p;
      while ((p = pRe.exec(tc[1])) !== null) {
        const text = extractParaText(p[1]);
        if (text) paras.push(text);
      }
      cells.push(paras.join('\n'));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const total = gridCols.reduce((a, b) => a + b, 0);
  const el = {
    type: 'table',
    x: Math.round(emuToPx(off ? off[1] : '', 'x', dims.scaleX, 0)),
    y: Math.round(emuToPx(off ? off[1] : '', 'y', dims.scaleY, 0)),
    width, height,
    rows: rows.map(r => {
      const copy = r.slice();
      while (copy.length < cols) copy.push('');
      return copy;
    }),
    colWidths: cols && total
      ? gridCols.slice(0, cols).map(w => Math.round(w / total * 100))
      : new Array(cols).fill(Math.round(100 / cols)),
    style: { fontSize: 14, borderColor: '#cbd5e1', color: '#374151', headerFill: '#eef2ff', headerColor: '#1f2937' }
  };
  const firstRow = /<a:tr[^>]*>([\s\S]*?)<\/a:tr>/i.exec(tbl[1]);
  const cellFill = firstRow && /<a:tcPr[^>]*>([\s\S]*?)<\/a:tcPr>/.exec(firstRow[1]);
  if (cellFill) {
    const c = pickColor(cellFill[1].replace(/<a:ln[TLRB][\s\S]*?<\/a:ln[TLRB]>/g, ''));
    if (c) el.style.headerFill = c;
  }
  const szMatch = /<a:rPr[^>]*\bsz="(\d+)"/.exec(tbl[1]);
  if (szMatch) el.style.fontSize = Math.max(10, Math.round(parseInt(szMatch[1], 10) / 100 * 4 / 3 * dims.fontScale));
  return el;
}

/** 背景：<p:bg> → background（纯色/渐变）与 backgroundImage */
function parsePptxBg(slideXml, rels, sink, zip) {
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(slideXml);
  const out = { background: '#ffffff', backgroundImage: '' };
  if (!bg) return out;
  const scope = bg[1];
  const blip = /<a:blip\b[^>]*>/.exec(scope);
  const embed = blip && /\br:embed="([^"]+)"/.exec(blip[0]);
  if (embed) {
    const rel = rels.get(embed[1]);
    if (rel && rel.path) {
      const buf = zipBuffer(zip, rel.path);
      const url = buf && sink.add(rel.path.split('/').pop(), buf);
      if (url) out.backgroundImage = url;
    }
    return out;
  }
  const grad = /<a:gradFill[\s\S]*?<\/a:gradFill>/.exec(scope);
  if (grad) {
    const stops = [...grad[0].matchAll(/<a:gs[^>]*pos="(\d+)"[^>]*>([\s\S]*?)<\/a:gs>/g)]
      .map(m => ({ pos: Math.round(parseInt(m[1], 10) / 1000), color: pickColor(m[2]) || '#4472c4' }));
    if (stops.length >= 2) {
      const lin = /<a:lin[^>]*ang="(-?\d+)"/.exec(grad[0]);
      // OOXML 角度为 1/60000 度、0° 指向正右方；CSS 的 0deg 指向正上方
      const deg = lin ? Math.round((parseInt(lin[1], 10) / 60000 + 90) % 360) : 135;
      out.background = `linear-gradient(${deg}deg, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
    }
    return out;
  }
  const solid = fillColorOf(scope);
  if (solid) out.background = solid;
  return out;
}

/** 切页动画 + 自动换页时间 */
function parsePptxTransition(slideXml) {
  const t = /<p:transition([^>]*)>([\s\S]*?)<\/p:transition>/i.exec(slideXml)
    || /<p:transition([^>]*)\/>/i.exec(slideXml);
  if (!t) return {};
  const attrs = t[1] || '';
  const inner = t[2] || '';
  const type = /<p:fade/.test(inner) ? 'fade'
    : /<p:wipe|<p:push|<p:cover|<p:slide/.test(inner) ? 'slide'
      : /<p:zoom|<p:gallery/.test(inner) ? 'zoom'
        : /<p:flip/.test(inner) ? 'flip' : 'none';
  // 动画时长优先取效果自身的 dur（毫秒），否则退回 spd 档位
  const dur = /<p:\w+[^>]*\bdur="(\d+)"/.exec(inner);
  const spd = /\bspd="(slow|fast)"/.exec(attrs) || /\bspd="(slow|fast)"/.exec(inner);
  const duration = dur ? Math.round(parseInt(dur[1], 10)) : (spd && spd[1] === 'slow' ? 1200 : 400);
  const advTm = attrInt(attrs, 'advTm', 0);
  const out = { transition: { type, duration } };
  if (advTm > 0) out.timings = { ms: Math.round(advTm) };
  return out;
}

/** 备注页正文：备注页里的多个占位形状只有正文那个有内容，取文本最长的一段 */
function parsePptxNotes(zip, rels) {
  const rel = [...rels.values()].find(r => r.path && /notesSlides\/notesSlide\d+\.xml$/.test(r.path));
  if (!rel) return '';
  const xml = zip.readAsText(rel.path);
  if (!xml) return '';
  let best = '';
  const spRe = /<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/gi;
  let sm;
  while ((sm = spRe.exec(xml)) !== null) {
    const lines = [];
    const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
    let p;
    while ((p = pRe.exec(sm[1])) !== null) {
      const text = extractParaText(p[1]);
      if (text.trim()) lines.push(text);
    }
    const joined = lines.join('\n');
    if (joined.length > best.length) best = joined;
  }
  return best.slice(0, 4000);
}

/** 组合嵌套与页数上限，防止畸形文件把解析拖死 */
const MAX_GROUP_DEPTH = 4;
const MAX_PPTX_SLIDES = 200;

/**
 * 按文档顺序切出顶层形状块：<p:sp> <p:pic> <p:graphicFrame> <p:grpSp>
 * 组合形内部的形状不单独返回，由调用方带坐标变换递归处理
 */
function scanShapeParts(xml) {
  const tagRe = /<(\/?)p:(sp|pic|graphicFrame|grpSp)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const out = [];
  const stack = [];
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const name = m[2];
    if (m[1]) {
      if (!stack.length || stack[stack.length - 1].name !== name) continue;
      const open = stack.pop();
      if (!stack.length) out.push({ name, xml: xml.slice(open.start, tagRe.lastIndex) });
    } else if (m[4]) {
      if (!stack.length) out.push({ name, xml: m[0] });
    } else {
      stack.push({ name, start: m.index });
    }
  }
  return out;
}

/** 组合形：chOff/chExt 是子坐标系参考框，把子元素坐标映射回幻灯片坐标 */
function pptxGroupFrame(grpXml, dims) {
  const pass = { dims, dx: 0, dy: 0 };
  const pr = /<p:grpSpPr\b[\s\S]*?<\/p:grpSpPr>/.exec(grpXml);
  const xf = pr && /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(pr[0]);
  if (!xf) return pass;
  const rect = tag => {
    const m = new RegExp('<a:' + tag + '\\b([^>]*)>').exec(xf[1]);
    return m ? m[1] : '';
  };
  const gsx = attrInt(rect('ext'), 'cx', 0) / Math.max(1, attrInt(rect('chExt'), 'cx', 1));
  const gsy = attrInt(rect('ext'), 'cy', 0) / Math.max(1, attrInt(rect('chExt'), 'cy', 1));
  if (!(gsx > 0) || !(gsy > 0) || gsx > 20 || gsy > 20) return pass;
  return {
    dims: {
      scaleX: dims.scaleX * gsx,
      scaleY: dims.scaleY * gsy,
      fontScale: dims.fontScale * Math.min(gsx, gsy)
    },
    dx: (attrInt(rect('off'), 'x', 0) - attrInt(rect('chOff'), 'x', 0) * gsx) * dims.scaleX,
    dy: (attrInt(rect('off'), 'y', 0) - attrInt(rect('chOff'), 'y', 0) * gsy) * dims.scaleY
  };
}

/**
 * 递归收集一页里可导入的元素
 * @param {object} ctx {rels, sink, zip, counted}
 */
function collectPptxElements(xml, dims, ctx, depth) {
  const els = [];
  const take = (el, kind) => {
    ctx.counted[kind] += 1;
    els.push(el);
  };
  scanShapeParts(xml).forEach(part => {
    if (part.name === 'sp') {
      const el = parsePptxShape(part.xml, dims, ctx.rels);
      // 无内容占位形状（只有版式留下的空框）静默丢弃，不算损失
      if (el) take(el, el.type === 'text' ? 'texts' : 'shapes');
      else ctx.counted.empty += 1;
    } else if (part.name === 'pic') {
      const el = parsePptxPic(part.xml, dims, ctx.rels, ctx.sink, ctx.zip);
      if (el) take(el, 'images');
      else ctx.counted.dropped += 1;
    } else if (part.name === 'graphicFrame') {
      const el = parsePptxTable(part.xml, dims);
      if (el) take(el, 'tables');
      else ctx.counted.dropped += 1;
    } else if (part.name === 'grpSp' && depth < MAX_GROUP_DEPTH) {
      const frame = pptxGroupFrame(part.xml, dims);
      // 去掉组合形自身的首尾标签和属性块，剩下的就是子元素
      const inner = part.xml
        .replace(/^<p:grpSp\b[^>]*>/i, '')
        .replace(/<\/p:grpSp>$/i, '')
        .replace(/<p:grpSpPr\b[\s\S]*?<\/p:grpSpPr>/i, '');
      collectPptxElements(inner, frame.dims, ctx, depth + 1).forEach(el => {
        el.x = Math.round(el.x + frame.dx);
        el.y = Math.round(el.y + frame.dy);
        els.push(el);
      });
    } else {
      ctx.counted.dropped += 1;
    }
  });
  return els;
}

/** 背景常常只写在版式或母版上：沿关系链向上找第一处能识别的 <p:bg> */
function pptxSlideBg(partPath, zip, sink) {
  let current = partPath;
  const seen = new Set();
  for (let hop = 0; hop < 3 && current && !seen.has(current); hop++) {
    seen.add(current);
    const xml = zip.readAsText(current);
    if (!xml) break;
    const rels = pptxRels(zip, current);
    if (/<p:bg\b/.test(xml)) {
      const bg = parsePptxBg(xml, rels, sink, zip);
      if (bg.backgroundImage || bg.background !== '#ffffff') return bg;
    }
    const up = [...rels.values()].find(r => r.path && /^ppt\/slide(Layouts|Masters)\//.test(r.path));
    current = up ? up.path : null;
  }
  return { background: '#ffffff', backgroundImage: '' };
}

/** 幻灯片顺序以 presentation.xml 的关系表为准，读不出时按文件编号排 */
function pptxSlideParts(zip, presXml) {
  const rels = pptxRels(zip, 'ppt/presentation.xml');
  const ordered = [...presXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map(m => { const r = rels.get(m[1]); return r && r.path; })
    .filter(p => p && /^ppt\/slides\/slide\d+\.xml$/.test(p));
  if (ordered.length) return [...new Set(ordered)];
  return zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .map(e => e.entryName)
    .sort((a, b) => parseInt(/slide(\d+)/.exec(a)[1], 10) - parseInt(/slide(\d+)/.exec(b)[1], 10));
}

/**
 * .pptx → 演示文稿模型
 * @param {Buffer} buffer pptx 内容
 * @param {string} docName 文档名
 */
function convertPptx(buffer, docName) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    throw new Error('PPTX 解析失败：文件可能已损坏');
  }
  const presXml = zip.readAsText('ppt/presentation.xml');
  if (!presXml) throw new Error('PPTX 结构异常：缺少 presentation.xml');

  // 幻灯片尺寸（EMU）→ 换算到 960x540 逻辑画布
  const sldSz = /<p:sldSz([^/>]*)\/?>/.exec(presXml);
  const srcW = attrInt(sldSz ? sldSz[1] : '', 'cx', 0) || 12192000;
  const srcH = attrInt(sldSz ? sldSz[1] : '', 'cy', 0) || 6858000;
  const scaleX = SLIDE_W / srcW;
  const scaleY = SLIDE_H / srcH;
  const dims = {
    scaleX,
    scaleY,
    // 1pt 在源文件里是 4/3 像素（96DPI），再乘画布缩放；取较小轴向，避免非 16:9 幻灯片文字溢出
    fontScale: (EMU_PER_INCH / 96) * Math.min(scaleX, scaleY)
  };

  let parts = pptxSlideParts(zip, presXml);
  if (!parts.length) throw new Error('PPTX 中没有幻灯片');
  const warnings = [];
  if (parts.length > MAX_PPTX_SLIDES) {
    warnings.push(`文件共 ${parts.length} 页，最多导入 ${MAX_PPTX_SLIDES} 页`);
    parts = parts.slice(0, MAX_PPTX_SLIDES);
  }

  const sink = createImportMediaSink();
  const counted = { texts: 0, shapes: 0, images: 0, tables: 0, notes: 0, hidden: 0, dropped: 0, empty: 0 };
  const slides = parts.map((partPath, i) => {
    const xml = zip.readAsText(partPath) || '';
    const rels = pptxRels(zip, partPath);
    const elements = collectPptxElements(xml, dims, { rels, sink, zip, counted }, 0)
      .map((el, n) => Object.assign({ id: `el_${i + 1}_${n + 1}` }, el));
    const bg = pptxSlideBg(partPath, zip, sink);
    const notes = parsePptxNotes(zip, rels);
    if (notes) counted.notes += 1;
    const anim = parsePptxTransition(xml);
    const sldTag = /<p:sld\b[^>]*>/.exec(xml);
    const hidden = Boolean(sldTag && /\bshow="0"/.test(sldTag[0]));
    if (hidden) counted.hidden += 1;
    const firstText = elements.find(el => el.type === 'text');
    const slide = {
      id: 'slide-' + (i + 1),
      title: (firstText ? String(firstText.content).split('\n')[0] : '幻灯片').slice(0, 30),
      layout: 'blank',
      elements,
      background: bg.background
    };
    if (bg.backgroundImage) slide.backgroundImage = bg.backgroundImage;
    if (notes) slide.notes = notes;
    if (hidden) slide.hidden = true;
    if (anim.transition) slide.transition = anim.transition;
    if (anim.timings) slide.timings = anim.timings;
    return slide;
  });

  const imported = sink.commit();
  if (counted.dropped) {
    warnings.push(`已跳过 ${counted.dropped} 个不支持的内容（图表、SmartArt、音视频或无法读取的图片）`);
  }
  if (sink.skipped) {
    warnings.push(`${sink.skipped} 张图片超出格式或大小限制，未导入`);
  }
  if (counted.hidden) warnings.push(`${counted.hidden} 页在原文件里设为隐藏，放映时会自动跳过`);

  return {
    doc: {
      id: 'ppt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      appVersion: '1.0.0',
      name: docName || '导入的演示文稿',
      docType: 'presentation',
      slideWidth: SLIDE_W,
      slideHeight: SLIDE_H,
      slides,
      slideOrder: slides.map(s => s.id),
      masters: [],
      themes: [{ name: '默认', primaryColor: '#4472C4', backgroundColor: '#ffffff' }],
      resources: '[]'
    },
    stats: {
      slides: slides.length,
      elements: slides.reduce((n, s) => n + s.elements.length, 0),
      images: imported,
      tables: counted.tables,
      notes: counted.notes
    },
    warnings
  };
}

// ============ 统一入口 ============

/**
 * 导入入口：按扩展名分发
 * @param {Buffer} buffer 文件内容
 * @param {string} filename 原始文件名
 * @param {string} docName 目标文档名
 * @param {{convertLegacy?: function(string, Buffer, string): Promise<Buffer>}} [opts]
 *        convertLegacy(ext, buffer, filename) → 转换后的新格式 Buffer；
 *        缺省时 .doc/.ppt 自动走 LibreOffice（未安装则返回可操作提示）
 * @returns {Promise<{docType, doc, stats, warnings}>}
 */
async function importOfficeFile(buffer, filename, docName, opts) {
  const options = opts || {};
  const ext = extOf(filename);
  const docType = EXT_DOC_TYPE[ext];
  if (!docType) {
    throw new Error(`不支持的文件格式 .${ext || '?'}，可用格式：${Object.keys(EXT_DOC_TYPE).map(e => '.' + e).join(' ')}`);
  }
  if (!buffer || !buffer.length) throw new Error('文件为空');
  if (!claimSlot()) throw new Error('服务器正在导入其他文件，请稍后重试');

  try {
    return await runImport(buffer, filename, ext, docType, docName, options);
  } finally {
    importSlot.busy = false;
  }
}

async function runImport(buffer, filename, ext, docType, docName, options) {
  let effectiveExt = ext;
  let effectiveBuf = buffer;
  let legacyConverted = null;
  if (ext === 'doc' || ext === 'ppt') {
    // 探测结果有缓存，首次请求在此 await，避免依赖启动时序
    const convert = options.convertLegacy
      || (await libreoffice.probe() ? libreoffice.convertLegacyAdapter : null);
    if (!convert) {
      throw new Error(`.${ext} 是旧版二进制格式，服务器未安装 LibreOffice，请先另存为 .${ext === 'doc' ? 'docx' : 'pptx'} 再导入`);
    }
    const targetExt = ext === 'doc' ? 'docx' : 'pptx';
    effectiveBuf = await convert(ext, buffer, filename);
    effectiveExt = targetExt;
    legacyConverted = targetExt;
  }

  let result;
  if (effectiveExt === 'docx') {
    result = await convertDocx(effectiveBuf, docName);
  } else if (effectiveExt === 'pptx') {
    result = convertPptx(effectiveBuf, docName);
  } else {
    const imported = importBufferToUniverDoc(effectiveBuf, 'file.' + effectiveExt, docName);
    result = { doc: imported.workbook, stats: imported.stats, warnings: [] };
  }

  if (legacyConverted) {
    result.warnings = (result.warnings || []).concat([`.${ext} 已经 LibreOffice 转换为 .${legacyConverted} 后导入`]);
  }
  return { docType, doc: result.doc, stats: result.stats, warnings: result.warnings || [] };
}

/**
 * multer/busboy 按 latin1 解码 multipart 文件名，中文名会变成乱码
 * （如「工作总结」→「å·¥ä½æ»ç»」），这里按 UTF-8 重新解释
 */
function decodeFilename(name) {
  const raw = String(name || '');
  if (!raw) return '';
  // 只有出现 latin1 特征字节（0x80–0xFF）才需要转换，纯 ASCII 名原样返回
  if (!/[\u0080-\u00ff]/.test(raw)) return raw;
  const fixed = Buffer.from(raw, 'latin1').toString('utf8');
  // 转换后含替换符说明原串本身不是 UTF-8 字节流，保留原值
  return fixed.indexOf('\uFFFD') === -1 ? fixed : raw;
}

/** multer 之后接一环，把 req.file.originalname 修正为真实文件名 */
function decodeUploadName(req, res, next) {
  if (req.file) req.file.originalname = decodeFilename(req.file.originalname);
  if (Array.isArray(req.files)) {
    req.files.forEach(f => { f.originalname = decodeFilename(f.originalname); });
  }
  next();
}

module.exports = {
  importOfficeFile,
  convertDocx,
  convertPptx,
  docTypeOf,
  extOf,
  decodeFilename,
  decodeUploadName,
  SUPPORTED_EXTENSIONS: Object.keys(EXT_DOC_TYPE),
  MAX_IMPORT_MB,
  MAX_IMPORT_BYTES
};
