/**
 * 演示文稿导出：自绘幻灯片模型 → .pptx（OOXML）/ 自包含 .html
 *
 * 输入模型与前端 /js/ppt-scene.js 一致（960x540 逻辑画布）：
 *   slide  = { id, title, layout, background, backgroundImage, elements[], notes, transition, hidden, timings }
 *   element= { id, type: text|shape|image|table, x, y, width, height, rotation, opacity, content, shape, src,
 *              rows, colWidths, link, style{…} }
 *
 * 设计要点：
 *   - 坐标换算：960 逻辑单位 → 12192000 EMU（1 单位 = 12700 EMU，16:9 下 x/y 系数相同）；
 *   - 字号换算：960x540 画布即 960x540 磅，1 逻辑单位 = 1 磅，OOXML 的 sz 为百分之一点 → 单位 * 100；
 *   - 图片按 URL 从 public 目录读盘并打包进 ppt/media，导出文件不依赖服务器地址；
 *   - 只生成一份 slideMaster/slideLayout/theme 模板，所有内容写在幻灯片自身形状上，
 *     避免占位符继承带来的版式漂移；
 *   - 生成失败（如图片缺失）降级为警告并跳过该元素，不中断整篇导出。
 */
'use strict';
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { publicDir } = require('../config/app-root');

const LOGIC_W = 960;
const LOGIC_H = 540;
const EMU_W = 12192000;
const EMU_PER_PX = EMU_W / LOGIC_W; // 12700
const EMU_H = EMU_PER_PX * LOGIC_H;
const NAMESPACE = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// 自绘形状 → OOXML prstGeom
const GEOM_MAP = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle',
  diamond: 'diamond', hexagon: 'hexagon', parallelogram: 'parallelogram',
  rightArrow: 'rightArrow', leftArrow: 'leftArrow', star: 'star5', chevron: 'chevron',
  arrow: 'rightArrow', line: 'line'
};

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => XML_ESCAPE[ch]);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 逻辑像素 → EMU */
function emu(px) {
  return Math.round(num(px, 0) * EMU_PER_PX);
}

/**
 * 逻辑字号 → OOXML 百分之一点
 * 画布 960x540 对应 13.33x7.5 英寸（= 960x540 磅），一个逻辑单位就是一个点，故直接 *100
 */
function fontSz(px) {
  return Math.max(100, Math.round(num(px, 18) * 100));
}

/** #rrggbb → RRGGBB（大写，无 #） */
function rgb(hex, fallback) {
  const s = String(hex || '').trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m) return m[1].toUpperCase();
  const short = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (short) return (short[1] + short[1]).toUpperCase().slice(0, 6);
  return String(fallback || '000000').toUpperCase();
}

/** 颜色 → <a:solidFill>；alpha 为 0–1 不透明度 */
function solidFill(hex, fallback, alpha) {
  const v = rgb(hex, fallback);
  const a = Math.max(0, Math.min(1, num(alpha, 1)));
  if (a >= 1) return `<a:solidFill><a:srgbClr val="${v}"/></a:solidFill>`;
  return `<a:solidFill><a:srgbClr val="${v}"><a:alpha val="${Math.max(1, Math.round(a * 100000))}"/>`
    + '</a:srgbClr></a:solidFill>';
}

/** 描边宽度：逻辑单位与位移同源（1 单位 = 12700 EMU），最细 0.5 单位 */
function lineEmu(px) {
  return Math.max(6350, Math.round(num(px, 2) * EMU_PER_PX));
}

function alignVal(v) {
  return v === 'center' ? 'ctr' : (v === 'right' ? 'r' : (v === 'justify' ? 'just' : 'l'));
}

function anchorVal(v) {
  return v === 'middle' ? 'ctr' : (v === 'bottom' ? 'b' : 't');
}

/** 角度（度）→ OOXML 1/60000 度 */
function degTo60000(deg) {
  const d = num(deg, 0);
  return d ? Math.round(((d % 360) + 360) % 360 * 60000) : 0;
}

/** 仅放行 http/https/mailto，避免 javascript: 等可执行协议被写进导出文件 */
function sanitizeUrl(url) {
  const s = String(url || '').trim();
  if (!/^(https?:|mailto:)/i.test(s)) return '';
  if (/[\r\n\t<>]/.test(s)) return '';
  return s.slice(0, 2000);
}

// ============ 媒体（图片）收集 ============

/** 服务器本地 URL（/uploads/…）→ public 目录下的真实文件 */
// 导出需同步拼装 zip / 内联图片，且单图受 8MB 上限约束，这里不做异步化
/* eslint-disable no-sync */
function readLocalFile(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  if (!/^\/(uploads|images|assets)\//.test(clean)) return null;
  const abs = path.join(publicDir, path.normalize(clean).replace(/^([/\\])+/, ''));
  // 防目录穿越：解析后必须仍位于 public 内
  if (!abs.startsWith(path.resolve(publicDir))) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(abs);
  } catch (e) {
    return null;
  }
}
/* eslint-enable no-sync */

function extOfUrl(url) {
  const m = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(String(url || ''));
  const ext = (m ? m[1] : '').toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? ext : 'png';
}

/**
 * 把幻灯片引用的图片读入内存，分配 ppt/media 内的文件名
 * @returns {{resolve: function(string): string|null, entries: Array<{name, buffer, ext}>}}
 */
function createMediaStore() {
  const bySrc = new Map();
  const missing = new Set();
  const entries = [];
  let seq = 0;

  return {
    /** 返回媒体包内文件名（imageN.png）；无法读取时返回 null */
    resolve(src) {
      if (!src) return null;
      const hit = bySrc.get(src);
      if (hit) return hit;
      if (missing.has(src)) return null;
      const buffer = readLocalFile(src);
      if (!buffer) {
        missing.add(src);
        return null;
      }
      seq += 1;
      const ext = extOfUrl(src);
      const name = `image${seq}.${ext}`;
      entries.push({ name, buffer, ext });
      bySrc.set(src, name);
      return name;
    },
    entries,
    get skipped() { return missing.size; }
  };
}

// ============ 元素 → OOXML 形状 ============

/** p:nvPr：形状/图片/表格的整体超链接挂在非视觉属性里（文本则挂在运行属性上） */
function nvPrXml(opts) {
  const rid = (opts || {}).hlinkRid;
  return rid ? `<p:nvPr><a:hlinkClick r:id="${rid}"/></p:nvPr>` : '<p:nvPr/>';
}

/** 形状通用外壳：nvSpPr + spPr + txBody */
function buildSp(id, name, xfrm, geom, fill, line, body, opts) {
  const o = opts || {};
  return '<p:sp>'
    + `<p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/>`
    + `<p:cNvSpPr${o.txBox ? ' txBox="1"' : ''}/>${nvPrXml(o)}</p:nvSpPr>`
    + `<p:spPr>${xfrm}${geom || ''}${fill || ''}${line || ''}</p:spPr>`
    + `${body || ''}`
    + '</p:sp>';
}

function xfrmXml(el) {
  const rot = degTo60000(el.rotation);
  return `<a:xfrm${rot ? ` rot="${rot}"` : ''}>`
    + `<a:off x="${emu(el.x)}" y="${emu(el.y)}"/>`
    + `<a:ext cx="${Math.max(1, emu(el.width))}" cy="${Math.max(1, emu(el.height))}"/>`
    + '</a:xfrm>';
}

/** 圆角矩形的 adj 是「半径 / 短边一半」的千分比 */
function geomXml(el, shape, radiusPx) {
  const prst = GEOM_MAP[shape] || 'rect';
  if (prst !== 'roundRect') return `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
  const half = Math.max(1, Math.min(num(el.width, 100), num(el.height, 30)) / 2);
  const adj = Math.max(0, Math.min(50000, Math.round(num(radiusPx, 12) / half * 50000)));
  return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
}

const RECT_GEOM = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';

/** 段落属性（对齐 / 行距 / 项目符号必须在 a:pPr 内，且排在 run 之前） */
function pPrXml(style, opts) {
  const st = style || {};
  const o = opts || {};
  const lh = num(st.lineHeight, 0);
  const pct = lh > 0 ? Math.round(lh * 100000) : 100000;
  return `<a:pPr algn="${alignVal(o.align || st.textAlign)}">`
    + `<a:lnSpc><a:spcPct val="${pct}"/></a:lnSpc>`
    + (o.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>')
    + '</a:pPr>';
}

/** 文本内容 → <a:p> 列表（加粗/斜体/下划线/删除线/颜色/字号/对齐/超链接） */
function paragraphsXml(content, style, opts) {
  const o = opts || {};
  const st = style || {};
  const sz = fontSz(o.fontSize || st.fontSize);
  const font = st.fontFamily
    ? `<a:latin typeface="${esc(st.fontFamily)}"/><a:ea typeface="${esc(st.fontFamily)}"/>`
    : '';
  const bold = o.bold || st.fontWeight === 'bold' || num(st.fontWeight, 400) >= 600;
  const hlink = o.hlinkRid
    ? '<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + `r:id="${o.hlinkRid}"/>`
    : '';
  const rPr = `<a:rPr lang="zh-CN" sz="${sz}" dirty="0"`
    + `${bold ? ' b="1"' : ''}${st.fontStyle === 'italic' ? ' i="1"' : ''}`
    + ` u="${st.underline ? 'sng' : 'none'}"${st.strike ? ' strike="sngStrike"' : ''}>`
    + solidFill(o.color || st.color, '333333') + font + hlink + '</a:rPr>';
  const pPr = pPrXml(st, o);
  const lines = String(content == null ? '' : content).split('\n');
  return lines.map(line => {
    if (!line) return `<a:p>${pPr}<a:endParaRPr lang="zh-CN" sz="${sz}"/></a:p>`;
    return `<a:p>${pPr}<a:r>${rPr}<a:t>${esc(line)}</a:t></a:r></a:p>`;
  }).join('');
}

function txBodyXml(content, style, opts) {
  const o = opts || {};
  const st = style || {};
  const wrap = o.noWrap ? 'none' : 'square';
  return '<p:txBody>'
    + `<a:bodyPr wrap="${wrap}" lIns="45720" tIns="27432" rIns="45720" bIns="27432" `
    + `anchor="${anchorVal(o.valign || st.valign)}" anchorCtr="0"><a:normAutofit/></a:bodyPr>`
    + '<a:lstStyle/>'
    + paragraphsXml(content, style, o)
    + '</p:txBody>';
}

/** 文本元素 */
function textShapeXml(el, id, opts) {
  const st = el.style || {};
  const fill = st.backgroundColor ? solidFill(st.backgroundColor, 'FFFFFF') : '<a:noFill/>';
  return buildSp(id, el.role === 'title' ? '标题' : '文本框',
    xfrmXml(el), RECT_GEOM, fill, '<a:ln><a:noFill/></a:ln>',
    txBodyXml(el.content, st, Object.assign({ valign: st.valign }, opts || {})), { txBox: true });
}

/** 形状元素（含可选内部文字） */
function shapeXml(el, id, opts) {
  const st = el.style || {};
  const shape = el.shape || 'rect';
  const isLine = shape === 'line';
  const alpha = num(el.opacity, 1);
  const fill = isLine ? '<a:noFill/>' : solidFill(st.fill || '#4472C4', '4472C4', alpha);
  const line = isLine
    ? `<a:ln w="${lineEmu(num(st.strokeWidth, 3))}">`
      + `${solidFill(st.stroke || st.fill || '#4472C4', '4472C4', alpha)}</a:ln>`
    : (st.stroke && st.stroke !== 'none'
      ? `<a:ln w="${lineEmu(num(st.strokeWidth, 2))}">${solidFill(st.stroke, '000000', alpha)}</a:ln>`
      : '<a:ln><a:noFill/></a:ln>');
  const hasText = el.content != null && String(el.content).length > 0;
  const body = hasText
    ? txBodyXml(el.content,
      Object.assign({}, st, { color: st.color || '#FFFFFF', textAlign: st.textAlign || 'center', valign: 'middle' }),
      Object.assign({ valign: 'middle' }, opts || {}))
    : '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>';
  return buildSp(id, '形状', xfrmXml(el), geomXml(el, shape, st.radius), fill, line, body, opts || {});
}

/** 图片元素：媒体读不到时退化为占位文本框，保证导出结构完整 */
function imageXml(el, id, media, rels, opts) {
  const st = el.style || {};
  const name = media.resolve(el.src);
  if (!name) {
    return buildSp(id, '图片（未找到文件）', xfrmXml(el), RECT_GEOM,
      '<a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill>', '<a:ln><a:noFill/></a:ln>',
      txBodyXml('[图片缺失]', { fontSize: 12, color: '#6B7280', textAlign: 'center', valign: 'middle' },
        { align: 'center', valign: 'middle' }), Object.assign({ txBox: true }, opts));
  }
  const rid = rels.addMedia(name);
  const alpha = num(el.opacity, 1);
  const geom = num(st.radius, 0) > 0 ? geomXml(el, 'roundRect', st.radius) : RECT_GEOM;
  const blip = alpha < 1
    ? `<a:blip r:embed="${rid}"><a:alphaModFix amt="${Math.max(1, Math.round(alpha * 100000))}"/></a:blip>`
    : `<a:blip r:embed="${rid}"/>`;
  return '<p:pic>'
    + `<p:nvPicPr><p:cNvPr id="${id}" name="图片"/>`
    + `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${nvPrXml(opts)}</p:nvPicPr>`
    + `<p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrmXml(el)}${geom}`
    + `${st.border ? `<a:ln w="${lineEmu(num(st.borderWidth, 2))}">${solidFill(st.border, '000000')}</a:ln>` : '<a:ln><a:noFill/></a:ln>'}`
    + '</p:spPr></p:pic>';
}

/** 表格元素 → a:tbl graphicFrame */
function tableXml(el, id, opts) {
  const rows = Array.isArray(el.rows) ? el.rows : [];
  const cols = rows.reduce((n, r) => Math.max(n, (r || []).length), 0);
  if (!rows.length || !cols) return '';
  const st = el.style || {};
  const colWidths = Array.isArray(el.colWidths) && el.colWidths.length === cols
    ? el.colWidths.map(p => Math.max(1, Math.round(num(p, 100 / cols) * emu(el.width) / 100)))
    : new Array(cols).fill(Math.round(emu(el.width) / cols));
  const gridCol = colWidths.map(w => `<a:gridCol w="${w}"/>`).join('');
  const body = rows.map((row, ri) => {
    const cells = [];
    for (let ci = 0; ci < cols; ci++) {
      const text = row && row[ci] != null ? String(row[ci]) : '';
      const color = ri === 0 ? (st.headerColor || st.color || '#1F2937') : (st.color || '#374151');
      cells.push('<a:tc>'
        + '<a:txBody><a:bodyPr/><a:lstStyle/>'
        + paragraphsXml(text, Object.assign({}, st, { color, textAlign: 'left', valign: 'middle' }), { align: 'left' })
        + '</a:txBody>'
        // tcPr 的子元素顺序由 schema 规定：先边框、后填充
        + '<a:tcPr marL="45720" marR="45720" marT="27432" marB="27432" anchor="ctr">'
        + `<a:lnL w="${lineEmu(1)}">${solidFill(st.borderColor || '#CBD5E1', 'CBD5E1')}</a:lnL>`
        + `<a:lnR w="${lineEmu(1)}">${solidFill(st.borderColor || '#CBD5E1', 'CBD5E1')}</a:lnR>`
        + `<a:lnT w="${lineEmu(1)}">${solidFill(st.borderColor || '#CBD5E1', 'CBD5E1')}</a:lnT>`
        + `<a:lnB w="${lineEmu(1)}">${solidFill(st.borderColor || '#CBD5E1', 'CBD5E1')}</a:lnB>`
        + solidFill(ri === 0 ? (st.headerFill || '#EEF2FF') : (st.fill || '#FFFFFF'), 'FFFFFF')
        + '</a:tcPr></a:tc>');
    }
    return `<a:tr h="${Math.max(1, Math.round(emu(el.height) / rows.length))}">${cells.join('')}</a:tr>`;
  }).join('');

  return '<p:graphicFrame>'
    + `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="表格"/>`
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr>'
    + `${nvPrXml(opts)}</p:nvGraphicFramePr>`
    + `<p:xfrm>${`<a:off x="${emu(el.x)}" y="${emu(el.y)}"/><a:ext cx="${Math.max(1, emu(el.width))}" cy="${Math.max(1, emu(el.height))}"/>`}</p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + '<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5940675A-B46B-43E1-9843-0B8F6C49E392}</a:tableStyleId></a:tblPr>'
    + `<a:tblGrid>${gridCol}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic>`
    + '</p:graphicFrame>';
}

// ============ 幻灯片 ============

class RelList {
  constructor() {
    this.items = [];
    this.seq = 0;
  }

  add(type, target, external) {
    this.seq += 1;
    this.items.push({ id: this.seq, type, target, external: Boolean(external) });
    return `rId${this.seq}`;
  }

  addMedia(mediaName) {
    return this.add('image', `../media/${mediaName}`);
  }

  addLayout() {
    return this.add('slideLayout', '../slideLayouts/slideLayout1.xml');
  }

  addHyperlink(url) {
    const safe = sanitizeUrl(url);
    return safe ? this.add('hyperlink', safe, true) : null;
  }

  toXml() {
    return relsXml(this.items);
  }
}

/** .rels 部件 */
function relsXml(items) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(r => `<Relationship Id="rId${r.id}" Type="${REL_BASE}/${r.type}" `
      + `Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';
}

/** 切页动画 → OOXML transition；彩排耗时用 advTm 表达自动换页 */
function transitionXml(slide) {
  const t = slide.transition || {};
  const ms = Math.max(100, Math.min(5000, num(t.duration, 400)));
  const spd = ms >= 1500 ? 'slow' : (ms <= 500 ? 'fast' : 'med');
  const advTm = Math.max(0, Math.round(num(slide.timings && slide.timings.ms, 0)));
  const auto = advTm > 0 ? ` advClick="0" advTm="${advTm}"` : '';
  // 效果自身的 dur 才是精确时长，父级 spd 只做档位兜底
  const dur = ` dur="${ms}"`;
  let inner = '';
  switch (t.type) {
    case 'fade': inner = `<p:fade${dur}/>`; break;
    case 'slide': inner = `<p:push dir="l"${dur}/>`; break;
    case 'zoom': inner = `<p:zoom dir="in"${dur}/>`; break;
    case 'flip': inner = `<p:flip dir="l"${dur}/>`; break;
    default: inner = '';
  }
  if (!inner && !auto) return '';
  return `<p:transition spd="${spd}"${auto}>${inner}</p:transition>`;
}

function slideBgXml(slide, media, rels) {
  const bg = String(slide.background || '').trim();
  let fillInner = '';
  const imgName = slide.backgroundImage ? media.resolve(slide.backgroundImage) : null;
  if (imgName) {
    const rid = rels.addMedia(imgName);
    fillInner = `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
  } else if (/gradient\(/i.test(bg)) {
    const colors = (bg.match(/#[0-9a-fA-F]{3,8}/g) || []);
    const angleM = /(-?\d+(?:\.\d+)?)deg/i.exec(bg);
    const ang = degTo60000(angleM ? Number(angleM[1]) - 90 : 90);
    const stops = (colors.length ? colors : ['#4472C4']).map((c, i, arr) => {
      const pos = arr.length > 1 ? Math.round(i / (arr.length - 1) * 100000) : 0;
      return `<a:gs pos="${pos}"><a:srgbClr val="${rgb(c, '4472C4')}"/></a:gs>`;
    }).join('');
    fillInner = `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>`
      + `<a:lin ang="${ang || 5400000}" scaled="1"/></a:gradFill>`;
  } else if (bg) {
    fillInner = solidFill(bg, 'FFFFFF');
  }
  if (!fillInner) return '';
  return `<p:bg><p:bgPr>${fillInner}<a:effectLst/></p:bgPr></p:bg>`;
}

/**
 * 生成单页幻灯片
 * @param {object} slide
 * @param {object} media 媒体仓库
 * @param {number} notePart 备注部件号（0 表示无备注）
 * @returns {{xml: string, rels: RelList}} rels 与 xml 中的 rId 一一对应，需原样写入 .rels
 */
function buildSlideXml(slide, media, notePart) {
  const rels = new RelList();
  rels.addLayout();
  if (notePart) rels.add('notesSlide', `../notesSlides/notesSlide${notePart}.xml`);
  const list = Array.isArray(slide.elements) ? slide.elements : [];
  const shapes = [];
  list.forEach((el, i) => {
    const id = i + 2; // 1 留给 spTree 根节点
    const rid = el.link ? rels.addHyperlink(el.link) : null;
    const opts = rid ? { hlinkRid: rid } : {};
    let xml = '';
    if (el.type === 'image') xml = imageXml(el, id, media, rels, opts);
    else if (el.type === 'table') xml = tableXml(el, id, opts);
    else if (el.type === 'shape') xml = shapeXml(el, id, opts);
    else xml = textShapeXml(el, id, opts);
    if (xml) shapes.push(xml);
  });

  // cSld 内容顺序：bg? → spTree；形状必须包在 spTree 内
  const cSld = '<p:cSld>' + slideBgXml(slide, media, rels)
    + spTreeOpen(1, '') + shapes.join('') + '</p:spTree>'
    + '</p:cSld>';
  const hidden = slide.hidden ? ' show="0"' : '';
  return {
    xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<p:sld${hidden} ${NAMESPACE}>`
      + cSld
      + '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" '
      + 'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" '
      + 'accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
      + transitionXml(slide)
      + '</p:sld>',
    rels
  };
}

/** 备注页（讲者备注） */
function buildNotesXml(slide) {
  const text = String(slide.notes || '');
  const paras = text
    ? text.split('\n')
      .map(line => `<a:p><a:r><a:rPr lang="zh-CN" sz="1200"/><a:t>${esc(line)}</a:t></a:r></a:p>`).join('')
    : '<a:p><a:endParaRPr lang="zh-CN"/></a:p>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:notes ${NAMESPACE}>`
    + '<p:cSld>' + spTreeOpen(1, '')
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    + '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
    + `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="幻灯片图像"/>'
    + '<p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>'
    + '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

// ============ 固定模板部分 ============

const THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office 主题">'
  + '<a:themeElements><a:clrScheme name="自定义">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme><a:fontScheme name="自定义">'
  + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont>'
  + '</a:fontScheme><a:fmtScheme name="Office">'
  + '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>'
  + '<a:lnStyleLst>'
  + '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
  + '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
  + '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
  + '</a:lnStyleLst><a:effectStyleLst>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>'
  + '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>'
  + '</a:effectStyleLst><a:bgFillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
  + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements>'
  + '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

function spTreeOpen(id, name) {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

const TX_STYLES = '<p:txStyles>'
  + '<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400"><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" b="0"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr algn="l" defTabSz="914400"><a:buNone/><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:lvl1pPr algn="l"><a:buNone/><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle>'
  + '</p:txStyles>';

const SLIDE_MASTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:sldMaster ${NAMESPACE}>`
  + '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
  + spTreeOpen(1, '母版') + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
  + 'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '<p:hf sldNum="0" hdr="0" ftr="0" dt="0"/>'
  + TX_STYLES
  + '</p:sldMaster>';

const SLIDE_LAYOUT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:sldLayout ${NAMESPACE} type="blank" preserve="1">`
  + '<p:cSld name="空白版式">' + spTreeOpen(1, '版式') + '</p:spTree></p:cSld>'
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
  + '</p:sldLayout>';

const NOTES_MASTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:notesMaster ${NAMESPACE}>`
  + '<p:cSld>' + spTreeOpen(1, '备注母版')
  + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
  + '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
  + '<p:spPr><a:xfrm><a:off x="457200" y="3962400"/><a:ext cx="6400800" cy="4800600"/></a:xfrm></p:spPr>'
  + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
  + 'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + TX_STYLES
  + '</p:notesMaster>';

function presentationXml(slideCount) {
  const sldIds = [];
  for (let i = 1; i <= slideCount; i++) {
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:presentation ${NAMESPACE} saveSubsetFonts="1">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483647" r:id="rId${slideCount + 1}"/></p:sldMasterIdLst>`
    + `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slideCount + 3}"/></p:notesMasterIdLst>`
    + `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${EMU_W}" cy="${EMU_H}"/>`
    + `<p:notesSz cx="${EMU_H}" cy="${EMU_W}"/>`
    + '<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>'
    + '</p:presentation>';
}

function presentationRelXml(slideCount) {
  const items = [];
  for (let i = 1; i <= slideCount; i++) items.push({ id: i, type: 'slide', target: `slides/slide${i}.xml` });
  items.push({ id: slideCount + 1, type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' });
  items.push({ id: slideCount + 2, type: 'theme', target: 'theme/theme1.xml' });
  items.push({ id: slideCount + 3, type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' });
  return relsXml(items);
}

function contentTypesXml(slideCount, mediaEntries, noteParts) {
  const overrides = [];
  const push = (part, type) => overrides.push(`<Override PartName="/${part}" ContentType="${type}"/>`);
  push('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml');
  push('ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml');
  push('ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml');
  push('ppt/notesMasters/notesMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml');
  push('ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml');
  for (let i = 1; i <= slideCount; i++) {
    push(`ppt/slides/slide${i}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
  }
  (noteParts || []).forEach(part => {
    push(`ppt/notesSlides/notesSlide${part}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml');
  });
  overrides.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');
  overrides.push('<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>');
  const mediaTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const exts = [];
  mediaEntries.forEach(m => { if (exts.indexOf(m.ext) < 0) exts.push(m.ext); });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + exts.map(e => `<Default Extension="${e}" ContentType="${mediaTypes[e] || 'application/octet-stream'}"/>`).join('')
    + overrides.join('')
    + '</Types>';
}

function rootRelsXml() {
  return relsXml([
    { id: 1, type: 'officeDocument', target: 'ppt/presentation.xml' },
    { id: 2, type: 'core-properties', target: 'docProps/core.xml' },
    { id: 3, type: 'extended-properties', target: 'docProps/app.xml' }
  ]);
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

function appXml(slideCount, noteCount, titles) {
  const parts = (titles || []).slice(0, 100);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
    + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Application>Qoder 在线Office</Application><Slides>${slideCount}</Slides>`
    + `<Notes>${noteCount}</Notes>`
    + `<TitlesOfParts><vt:vector size="${parts.length + 1}" baseType="lpstr">`
    + '<vt:lpstr>演示文稿</vt:lpstr>'
    + parts.map(t => `<vt:lpstr>${esc(t)}</vt:lpstr>`).join('')
    + '</vt:vector></TitlesOfParts>'
    + '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
    + '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>';
}

// ============ 导出：PPTX ============

/**
 * 生成 .pptx
 * @param {object} doc 演示文稿快照
 * @param {{name?: string}} [options]
 * @returns {{buffer: Buffer, ext: string, mime: string, warnings: string[], stats: object}}
 */
function toPptx(doc, options) {
  const o = options || {};
  const slides = PPTOrdered(doc);
  if (!slides.length) throw new Error('演示文稿没有可导出的幻灯片');
  // 导出为同步过程，限制规模避免长时间占用事件循环
  if (slides.length > 300) throw new Error('幻灯片数量超过 300 页，请拆分后再导出');
  const media = createMediaStore();
  const zip = new AdmZip();
  const warnings = [];

  const noteParts = [];
  slides.forEach((slide, i) => {
    const part = i + 1;
    const hasNotes = Boolean(String(slide.notes || '').trim());
    if (hasNotes) noteParts.push(part);
    const built = buildSlideXml(slide, media, hasNotes ? part : 0);
    zip.addFile(`ppt/slides/slide${part}.xml`, Buffer.from(built.xml, 'utf-8'));
    zip.addFile(`ppt/slides/_rels/slide${part}.xml.rels`, Buffer.from(built.rels.toXml(), 'utf-8'));
    if (slide.hidden) warnings.push(`第 ${part} 页为隐藏页，导出后在 PowerPoint 中同样标记为不放映`);
  });

  noteParts.forEach(part => {
    zip.addFile(`ppt/notesSlides/notesSlide${part}.xml`, Buffer.from(buildNotesXml(slides[part - 1]), 'utf-8'));
    zip.addFile(`ppt/notesSlides/_rels/notesSlide${part}.xml.rels`, Buffer.from(relsXml([
      { id: 1, type: 'slide', target: `../slides/slide${part}.xml` },
      { id: 2, type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' }
    ]), 'utf-8'));
  });

  media.entries.forEach(m => zip.addFile(`ppt/media/${m.name}`, m.buffer));
  if (media.skipped) {
    warnings.push(`${media.skipped} 张图片无法从服务器读取（外链或已删除），导出文件中以占位框代替`);
  }

  zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml(slides.length, media.entries, noteParts), 'utf-8'));
  zip.addFile('_rels/.rels', Buffer.from(rootRelsXml(), 'utf-8'));
  zip.addFile('ppt/presentation.xml', Buffer.from(presentationXml(slides.length), 'utf-8'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(presentationRelXml(slides.length), 'utf-8'));
  zip.addFile('ppt/theme/theme1.xml', Buffer.from(THEME_XML, 'utf-8'));
  zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from(SLIDE_MASTER_XML, 'utf-8'));
  zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(relsXml([
    { id: 1, type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 2, type: 'theme', target: '../theme/theme1.xml' }
  ]), 'utf-8'));
  zip.addFile('ppt/slideLayouts/slideLayout1.xml', Buffer.from(SLIDE_LAYOUT_XML, 'utf-8'));
  zip.addFile('ppt/slideLayouts/_rels/slideLayout1.xml.rels', Buffer.from(relsXml([
    { id: 1, type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }
  ]), 'utf-8'));
  zip.addFile('ppt/notesMasters/notesMaster1.xml', Buffer.from(NOTES_MASTER_XML, 'utf-8'));
  zip.addFile('ppt/notesMasters/_rels/notesMaster1.xml.rels', Buffer.from(relsXml([
    { id: 1, type: 'theme', target: '../theme/theme1.xml' }
  ]), 'utf-8'));
  zip.addFile('docProps/core.xml', Buffer.from(coreXml(o.name || doc.name || '演示文稿'), 'utf-8'));
  zip.addFile('docProps/app.xml',
    Buffer.from(appXml(slides.length, noteParts.length, slides.map(s => s.title || '幻灯片')), 'utf-8'));

  return {
    buffer: zip.toBuffer(),
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    warnings,
    stats: { slides: slides.length, media: media.entries.length, notes: noteParts.length }
  };
}

// ============ 幻灯片顺序 ============

/** 与前端 PPTScene.ordered 一致：按 slideOrder 排出有效幻灯片 */
function PPTOrdered(doc) {
  const slides = (doc && Array.isArray(doc.slides)) ? doc.slides : [];
  const byId = {};
  slides.forEach(s => { byId[s.id] = s; });
  const out = [];
  ((doc && doc.slideOrder) || []).forEach(id => { if (byId[id]) out.push(byId[id]); });
  slides.forEach(s => { if (out.indexOf(s) < 0) out.push(s); });
  return out;
}

// ============ 导出：自包含 HTML ============

const CSS_COLORS = {
  rect: 'polygon(0 0,100% 0,100% 100%,0 100%)',
  roundRect: 'polygon(6% 0,94% 0,100% 6%,100% 94%,94% 100%,6% 100%,0 94%,0 6%)',
  ellipse: 'ellipse(50% 50% at 50% 50%)',
  triangle: 'polygon(50% 0,100% 100%,0 100%)',
  diamond: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
  hexagon: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)',
  parallelogram: 'polygon(20% 0,100% 0,80% 100%,0 100%)',
  rightArrow: 'polygon(0 35%,60% 35%,60% 12%,100% 50%,60% 88%,60% 65%,0 65%)',
  leftArrow: 'polygon(100% 35%,40% 35%,40% 12%,0 50%,40% 88%,40% 65%,100% 65%)',
  star: 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)',
  chevron: 'polygon(0 0,75% 0,100% 50%,75% 100%,0 100%,25% 50%)',
  line: 'none'
};

function htmlStyle(el) {
  const st = el.style || {};
  const parts = [];
  parts.push(`left:${num(el.x, 0)}px`);
  parts.push(`top:${num(el.y, 0)}px`);
  parts.push(`width:${Math.max(1, num(el.width, 100))}px`);
  parts.push(`height:${Math.max(1, num(el.height, 30))}px`);
  if (el.rotation) parts.push(`transform:rotate(${num(el.rotation, 0)}deg)`);
  if (el.opacity != null && num(el.opacity, 1) < 1) parts.push(`opacity:${num(el.opacity, 1)}`);
  if (el.type === 'shape') {
    const clip = CSS_COLORS[el.shape];
    if (el.shape !== 'line' && clip && clip !== 'none') parts.push(`clip-path:${clip}`);
    parts.push(`background:${esc(st.fill || '#4472C4')}`);
    if (st.stroke) parts.push(`border:${num(st.strokeWidth, 2)}px solid ${esc(st.stroke)}`);
  }
  parts.push(`font-size:${num(st.fontSize, 18)}px`);
  if (st.fontFamily) parts.push(`font-family:${esc(st.fontFamily)}`);
  parts.push(`font-weight:${st.fontWeight === 'bold' || st.fontWeight === 700 ? '700' : '400'}`);
  parts.push(`font-style:${st.fontStyle === 'italic' ? 'italic' : 'normal'}`);
  const dec = [];
  if (st.underline) dec.push('underline');
  if (st.strike) dec.push('line-through');
  parts.push(`text-decoration:${dec.length ? dec.join(' ') : 'none'}`);
  parts.push(`text-align:${['center', 'right', 'justify'].includes(st.textAlign) ? st.textAlign : 'left'}`);
  parts.push(`color:${esc(st.color || '#333333')}`);
  if (num(st.lineHeight, 0) > 0) parts.push(`line-height:${num(st.lineHeight, 1.4)}`);
  const va = st.valign === 'middle' ? 'center' : (st.valign === 'bottom' ? 'flex-end' : 'flex-start');
  parts.push(`justify-content:${st.textAlign === 'center' ? 'center' : 'flex-start'}`);
  parts.push(`align-items:${va}`);
  return parts.join(';');
}

/**
 * HTML 导出的图片处理：站内图片内联成 data URI，保证「离线打开」真的离线可用
 * 读不到或超出总量时保留原始地址（联网时仍可显示）
 */
function createHtmlMedia() {
  const cache = new Map();
  const MAX_TOTAL = 24 * 1024 * 1024;
  let total = 0;
  let skipped = 0;
  return {
    url(src) {
      const s = String(src || '');
      if (!s || /^(data:|https?:|\/\/)/i.test(s)) return s;
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

function htmlOfSlide(slide, index, total, media) {
  const bg = String(slide.background || '#ffffff');
  const bgCss = /gradient\(/i.test(bg) ? bg : esc(bg);
  const body = (slide.elements || []).map(el => {
    if (el.type === 'image') {
      return `<img class="ppt-el" style="position:absolute;left:${num(el.x, 0)}px;top:${num(el.y, 0)}px;`
        + `width:${num(el.width, 200)}px;height:${num(el.height, 120)}px;object-fit:contain;`
        + `${el.rotation ? `transform:rotate(${num(el.rotation, 0)}deg);` : ''}" src="${esc(media.url(el.src))}" alt="">`;
    }
    if (el.type === 'table') {
      const rows = (el.rows || []).map((r, ri) => `<tr>${(r || []).map(c => `<${ri === 0 ? 'th' : 'td'}>${esc(c == null ? '' : c)}</${ri === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('');
      return `<table class="ppt-el" style="position:absolute;left:${num(el.x, 0)}px;top:${num(el.y, 0)}px;`
        + `width:${num(el.width, 200)}px;height:${num(el.height, 60)}px;font-size:${num((el.style || {}).fontSize, 14)}px;" border="1">${rows}</table>`;
    }
    const inner = esc(el.content == null ? '' : el.content).replace(/\n/g, '<br>');
    const linkOpen = el.link ? `<a href="${esc(el.link)}" target="_blank" rel="noopener noreferrer">` : '';
    const linkClose = el.link ? '</a>' : '';
    return `<div class="ppt-el" style="${htmlStyle(el)}"><div class="ppt-el-inner">${linkOpen}${inner}${linkClose}</div></div>`;
  }).join('');
  return `<section class="slide" data-idx="${index + 1}" style="background:${bgCss}">`
    + `${slide.backgroundImage ? `<div class="bgimg" style="background-image:url('${esc(media.url(slide.backgroundImage))}')"></div>` : ''}`
    + `${body}`
    + `<div class="pageno">${index + 1} / ${total}</div>`
    + '</section>';
}

/**
 * 生成自包含 HTML（离线翻页，无需服务器）
 * @param {object} doc
 * @param {{name?: string}} [options]
 */
function toHtml(doc, options) {
  const o = options || {};
  const slides = PPTOrdered(doc);
  if (!slides.length) throw new Error('演示文稿没有可导出的幻灯片');
  if (slides.length > 300) throw new Error('幻灯片数量超过 300 页，请拆分后再导出');
  const title = esc(o.name || doc.name || '演示文稿');
  const media = createHtmlMedia();
  const sections = slides.map((s, i) => htmlOfSlide(s, i, slides.length, media)).join('\n');
  const notes = slides.map((s, i) => {
    if (!String(s.notes || '').trim()) return '';
    return `<div class="note"><b>第 ${i + 1} 页备注</b><pre>${esc(s.notes)}</pre></div>`;
  }).join('\n');
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#111827;color:#111;font-family:"Microsoft YaHei",system-ui,sans-serif}
.stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.slide{position:relative;width:960px;height:540px;overflow:hidden;display:none;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.slide.is-active{display:block}
.bgimg{position:absolute;inset:0;background-size:cover;background-position:center}
.ppt-el{position:absolute;white-space:pre-wrap;word-break:break-word;overflow:hidden}
.ppt-el-inner{display:flex;flex-direction:column;width:100%;height:100%;padding:2px 6px;white-space:pre-wrap;word-break:break-word}
table.ppt-el{border-collapse:collapse;table-layout:fixed}
table.ppt-el td,table.ppt-el th{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:middle;font-size:inherit}
.pageno{position:absolute;right:12px;bottom:8px;font-size:12px;color:#94a3b8}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;align-items:center;padding:8px 14px;background:#0f172a;color:#e2e8f0;font-size:13px}
.bar button{background:#334155;border:0;color:#e2e8f0;border-radius:6px;padding:5px 11px;cursor:pointer}
.notes{max-width:960px;margin:20px auto;color:#cbd5e1}.note{margin-bottom:14px}.note pre{white-space:pre-wrap;font-family:inherit}
@media print{body{background:#fff}.stage{position:static}.slide{display:block!important;margin:0 auto 20px;page-break-after:always;box-shadow:none}.bar,.notes{display:none}}
</style></head>
<body><div class="stage">${sections}</div>
<div class="bar"><button onclick="go(-1)">上一页</button><button onclick="go(1)">下一页</button>
<span id="pos"></span><span style="margin-left:auto">← → / 空格翻页，F 全屏</span></div>
<div class="notes">${notes}</div>
<script>
var els=document.querySelectorAll('.slide'),cur=0;
function show(i){cur=Math.max(0,Math.min(els.length-1,i));for(var k=0;k<els.length;k++){els[k].classList.toggle('is-active',k===cur)}document.getElementById('pos').textContent='第 '+(cur+1)+' / '+els.length+' 页'}
function go(d){show(cur+d)}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();go(1)}else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(-1)}else if(e.key==='Home'){show(0)}else if(e.key==='End'){show(els.length-1)}else if(e.key==='f'||e.key==='F'){if(document.fullscreenElement){document.exitFullscreen()}else{document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}}});
show(0);
</script></body></html>`;
  return {
    buffer: Buffer.from(html, 'utf-8'),
    ext: 'html',
    mime: 'text/html; charset=utf-8',
    warnings: media.skipped ? [`${media.skipped} 张图片未能内联（读不到文件或超过 24MB 总量），离线打开时可能不显示`] : [],
    stats: { slides: slides.length }
  };
}

module.exports = {
  exportPresentation(doc, options) {
    const format = String((options && options.format) || 'pptx').toLowerCase();
    if (format === 'pdf') throw new Error('PDF 由编辑器「打印 / 存为 PDF」在浏览器内生成，服务端不提供转换');
    if (format === 'html' || format === 'htm') return toHtml(doc, options);
    return toPptx(doc, options);
  },
  toPptx,
  toHtml
};
