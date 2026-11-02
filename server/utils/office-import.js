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
const { importBufferToUniverDoc } = require('./spreadsheet-univer-io');
const libreoffice = require('./libreoffice');

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

/** 解析一个文本框形状 → 一个文本元素（取首段样式作为整体样式） */
function parsePptxShape(shapeXml, dims) {
  const off = /<a:off([^/>]*)\/?>/.exec(shapeXml);
  const ext = /<a:ext([^/>]*)\/?>/.exec(shapeXml);
  const x = emuToPx(off ? off[1] : '', 'x', dims.scaleX, 0);
  const y = emuToPx(off ? off[1] : '', 'y', dims.scaleY, 0);
  const w = emuToPx(ext ? ext[1] : '', 'cx', dims.scaleX, SLIDE_W / 2);
  const h = emuToPx(ext ? ext[1] : '', 'cy', dims.scaleY, SLIDE_H / 4);

  const paras = [];
  const paraRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
  let pm;
  while ((pm = paraRe.exec(shapeXml)) !== null) {
    const text = extractParaText(pm[1]);
    if (!text.trim()) continue;
    // 首个文本运行的属性：<a:rPr .../> 或 <a:rPr ...>…</a:rPr>（颜色等子元素在标签内）
    const runRe = /<a:rPr([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/.exec(pm[1]);
    const attrs = runRe ? runRe[1] : '';
    const runInner = (runRe && runRe[2]) || '';
    const style = {};
    const sz = attrInt(attrs, 'sz', 0);
    style.fontSize = sz ? Math.max(10, Math.round(sz / 100 * 4 / 3 * dims.fontScale)) : 18;
    const bold = /\bb="([^"]+)"/.exec(attrs);
    if (bold && (bold[1] === '1' || bold[1] === 'true')) style.fontWeight = 'bold';
    const align = /algn="([^"]+)"/.exec(pm[1]);
    if (align) style.textAlign = align[1] === 'ctr' ? 'center' : (align[1] === 'r' ? 'right' : 'left');
    else style.textAlign = 'left';
    // 颜色优先取本运行的 solidFill，退化到整段（主题色/themeRef 不解析，按默认深灰）
    const color = /<a:srgbClr val="([0-9a-fA-F]{6})"/.exec(runInner) || /<a:srgbClr val="([0-9a-fA-F]{6})"/.exec(pm[1]);
    style.color = (color && hexColor(color[1])) || '#333333';
    paras.push({ text, style });
  }
  if (!paras.length) return null;

  const base = paras[0].style;
  const content = paras.map(p => p.text).join('\n');
  const size = Math.max(...paras.map(p => p.style.fontSize));
  return {
    type: 'text', x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h),
    content,
    style: { fontSize: size, fontWeight: base.fontWeight || 'normal', textAlign: base.textAlign || 'left', color: base.color || '#333333' }
  };
}

/** EMU → 逻辑画布坐标（按轴缩放系数换算） */
function emuToPx(attrs, name, scale, fallback) {
  const m = new RegExp('\\b' + name + '="(-?\\d+)"').exec(attrs || '');
  if (!m) return fallback;
  return parseInt(m[1], 10) * scale;
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

  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(/slide(\d+)\.xml/.exec(a.entryName)[1], 10);
      const nb = parseInt(/slide(\d+)\.xml/.exec(b.entryName)[1], 10);
      return na - nb;
    });
  if (!slideEntries.length) throw new Error('PPTX 中没有幻灯片');

  const warnings = [];
  let skippedMedia = 0;
  const slides = slideEntries.map((entry, i) => {
    const xml = zip.readAsText(entry);
    const elements = [];
    // 形状：优先 <p:sp>（含文本框），再补 <p:graphicFrame> 里的文字
    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/gi;
    let sm;
    while ((sm = spRe.exec(xml)) !== null) {
      const el = parsePptxShape(sm[1], dims);
      if (el) elements.push(Object.assign({ id: `el_${i + 1}_${elements.length + 1}` }, el));
    }
    if (/<p:pic[\s>]/i.test(xml)) skippedMedia++;

    const bg = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9a-fA-F]{6})"[\s\S]*?<\/p:bg>/i.exec(xml);
    const firstText = elements.find(el => el.type === 'text');
    return {
      id: 'slide-' + (i + 1),
      title: (firstText ? firstText.content.split('\n')[0] : '幻灯片').slice(0, 30),
      layout: 'blank',
      elements,
      background: (bg && hexColor(bg[1])) || '#ffffff'
    };
  });

  if (skippedMedia) warnings.push(`已忽略 ${skippedMedia} 张幻灯片图片（.pptx 图片暂不支持导入）`);

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
    stats: { slides: slides.length, elements: slides.reduce((n, s) => n + s.elements.length, 0) },
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
