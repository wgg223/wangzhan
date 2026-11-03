/**
 * 幻灯片场景渲染层（编辑器 / 放映 / 分享页共用）
 *
 * 数据模型（与 server/utils/spreadsheet-doc-store.js createEmptyPresentation 一致）：
 *   slide  = { id, title, layout, background, elements[], notes, transition, hidden }
 *   element= { id, type, x, y, width, height, rotation, opacity, ... }
 *     text   → content + style{fontSize,fontFamily,fontWeight,fontStyle,underline,strike,textAlign,valign,color,lineHeight,backgroundColor}
 *     shape  → shape(rect|roundRect|ellipse|triangle|diamond|hexagon|parallelogram|arrow|line) + style{fill,stroke,strokeWidth,radius} + content
 *     image  → src + style{radius,border}
 *     table  → rows[[...]] + colWidths[] + style{fontSize,headerFill,headerColor,borderColor,color}
 *     link   → content + link(url)
 *
 * 逻辑画布固定 960x540（16:9），所有坐标按此计算，展示时整体等比缩放，
 * 因此导入换算、编辑、放映、缩略图共用同一份 DOM 结构。
 */
(function () {
  'use strict';

  var LOGIC_W = 960;
  var LOGIC_H = 540;

  // 版式模板：新建页 / 切换版式时使用
  var LAYOUTS = {
    blank: { name: '空白', slots: [] },
    title: {
      name: '标题幻灯片',
      slots: [
        { role: 'title', x: 80, y: 150, width: 800, height: 110, style: { fontSize: 44, fontWeight: 'bold', textAlign: 'center', valign: 'middle', color: '#1f2937' } },
        { role: 'subtitle', x: 140, y: 280, width: 680, height: 70, style: { fontSize: 24, textAlign: 'center', valign: 'middle', color: '#6b7280' } }
      ]
    },
    'title-content': {
      name: '标题与内容',
      slots: [
        { role: 'title', x: 60, y: 40, width: 840, height: 80, style: { fontSize: 32, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#1f2937' } },
        { role: 'body', x: 60, y: 140, width: 840, height: 350, style: { fontSize: 20, textAlign: 'left', valign: 'top', color: '#374151', lineHeight: 1.5 } }
      ]
    },
    'two-column': {
      name: '双栏内容',
      slots: [
        { role: 'title', x: 60, y: 40, width: 840, height: 70, style: { fontSize: 30, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#1f2937' } },
        { role: 'body', x: 60, y: 130, width: 400, height: 360, style: { fontSize: 18, textAlign: 'left', valign: 'top', color: '#374151', lineHeight: 1.5 } },
        { role: 'body', x: 500, y: 130, width: 400, height: 360, style: { fontSize: 18, textAlign: 'left', valign: 'top', color: '#374151', lineHeight: 1.5 } }
      ]
    },
    'title-only': {
      name: '仅标题',
      slots: [
        { role: 'title', x: 60, y: 40, width: 840, height: 80, style: { fontSize: 32, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#1f2937' } }
      ]
    },
    section: {
      name: '节标题',
      slots: [
        { role: 'title', x: 80, y: 200, width: 620, height: 100, style: { fontSize: 40, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#ffffff' } },
        { role: 'subtitle', x: 80, y: 310, width: 620, height: 60, style: { fontSize: 20, textAlign: 'left', valign: 'middle', color: '#e5e7eb' } }
      ]
    }
  };

  // clip-path 形状表（line 走描边盒，不用裁剪）
  var SHAPE_CLIP = {
    triangle: 'polygon(50% 0, 100% 100%, 0 100%)',
    diamond: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
    hexagon: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)',
    parallelogram: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)',
    rightArrow: 'polygon(0 35%, 60% 35%, 60% 12%, 100% 50%, 60% 88%, 60% 65%, 0 65%)',
    leftArrow: 'polygon(100% 35%, 40% 35%, 40% 12%, 0 50%, 40% 88%, 40% 65%, 100% 65%)',
    star: 'polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
    chevron: 'polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%)'
  };
  var SHAPE_NAMES = {
    rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆', triangle: '三角形', diamond: '菱形',
    hexagon: '六边形', parallelogram: '平行四边形', rightArrow: '右箭头', leftArrow: '左箭头',
    star: '五角星', chevron: '箭头形', line: '直线'
  };

  var TRANSITIONS = {
    none: '无', fade: '渐隐', slide: '推入', zoom: '缩放', flip: '翻转'
  };

  // ============ 基础工具 ============

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 文本元素样式 → CSS 字符串片段 */
  function textStyleCss(el) {
    var st = el.style || {};
    var css = [];
    css.push('font-size:' + num(st.fontSize, 18) + 'px');
    if (st.fontFamily) css.push('font-family:' + String(st.fontFamily).replace(/[;"<>]/g, '') + ',-apple-system,"Microsoft YaHei",sans-serif');
    css.push('font-weight:' + (st.fontWeight === 'bold' || st.fontWeight === 700 ? 'bold' : 'normal'));
    css.push('font-style:' + (st.fontStyle === 'italic' ? 'italic' : 'normal'));
    var dec = [];
    if (st.underline) dec.push('underline');
    if (st.strike) dec.push('line-through');
    css.push('text-decoration:' + (dec.length ? dec.join(' ') : 'none'));
    css.push('text-align:' + (['center', 'right', 'justify'].indexOf(st.textAlign) >= 0 ? st.textAlign : 'left'));
    css.push('color:' + (st.color || '#333333'));
    css.push('line-height:' + (num(st.lineHeight, 0) > 0 ? num(st.lineHeight, 1.4) : 1.4));
    if (st.backgroundColor) css.push('background-color:' + st.backgroundColor);
    if (st.shadow) css.push('text-shadow:0 2px 6px rgba(0,0,0,.35)');
    return css.join(';');
  }

  function applyCommon(node, el) {
    node.style.position = 'absolute';
    node.style.left = num(el.x, 0) + 'px';
    node.style.top = num(el.y, 0) + 'px';
    node.style.width = Math.max(1, num(el.width, 100)) + 'px';
    node.style.height = Math.max(1, num(el.height, 30)) + 'px';
    var op = num(el.opacity, 1);
    if (op > 0 && op < 1) node.style.opacity = String(op);
    var rot = num(el.rotation, 0);
    if (rot) node.style.transform = 'rotate(' + rot + 'deg)';
  }

  /** 形状主体（不含文字） */
  function buildShape(el) {
    var st = el.style || {};
    var kind = SHAPE_CLIP[el.shape] ? el.shape : (el.shape === 'line' ? 'line' : 'rect');
    var box = document.createElement('div');
    box.className = 'ppt-shape';
    if (kind === 'line') {
      // 直线：以高度描边呈现，旋转由 el.rotation 负责
      box.style.cssText = 'position:absolute;left:0;top:50%;width:100%;height:' + Math.max(1, num(st.strokeWidth, 2)) + 'px;background:' + (st.stroke || st.fill || '#333333') + ';transform:translateY(-50%)';
    } else {
      var fill = st.fill == null || st.fill === '' ? 'transparent' : st.fill;
      box.style.cssText = 'position:absolute;inset:0;background:' + fill + ';';
      if (SHAPE_CLIP[kind]) {
        box.style.clipPath = SHAPE_CLIP[kind];
        if (st.stroke && st.stroke !== 'none') box.style.webkitClipPath = SHAPE_CLIP[kind];
      } else if (kind === 'roundRect') {
        box.style.borderRadius = num(st.radius, 12) + 'px';
      } else if (kind === 'ellipse') {
        box.style.borderRadius = '50%';
      }
      if (st.stroke && st.stroke !== 'none' && !SHAPE_CLIP[kind]) {
        box.style.border = Math.max(1, num(st.strokeWidth, 2)) + 'px solid ' + st.stroke;
      }
    }
    return box;
  }

  /** 表格元素 */
  function buildTable(el) {
    var st = el.style || {};
    var table = document.createElement('table');
    table.className = 'ppt-table';
    table.style.fontSize = num(st.fontSize, 16) + 'px';
    table.style.color = st.color || '#333333';
    var borderColor = st.borderColor || '#cbd5e1';
    var rows = Array.isArray(el.rows) ? el.rows : [];
    var colWidths = Array.isArray(el.colWidths) ? el.colWidths : [];
    rows.forEach(function (row, ri) {
      var tr = document.createElement('tr');
      (row || []).forEach(function (cell, ci) {
        var td = document.createElement(ri === 0 ? 'th' : 'td');
        td.textContent = cell == null ? '' : String(cell);
        td.style.border = '1px solid ' + borderColor;
        td.style.padding = '4px 8px';
        td.style.textAlign = (st.textAlign && ['center', 'right'].indexOf(st.textAlign) >= 0) ? st.textAlign : 'left';
        if (ri === 0) {
          td.style.background = st.headerFill || '#eef2ff';
          td.style.color = st.headerColor || '#1f2937';
        }
        if (colWidths[ci]) td.style.width = colWidths[ci] + '%';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    var wrap = document.createElement('div');
    wrap.className = 'ppt-el ppt-el-table';
    wrap.style.overflow = 'hidden';
    wrap.appendChild(table);
    return wrap;
  }

  /** 元素超链接：加上「可点击」标记，跳转由宿主页面（编辑器/放映/分享页）按 elId 自行处理 */
  function applyLink(wrap, el) {
    if (!el.link) return;
    wrap.classList.add('ppt-clickable');
    wrap.style.cursor = 'pointer';
  }

  /**
   * 单个元素 → DOM 节点
   * 文本一律走 textContent，避免文档内容注入（分享页对公网开放）
   */
  function renderElement(el) {
    if (!el || !el.type) return null;
    var wrap = document.createElement('div');
    wrap.className = 'ppt-el ppt-el-' + el.type;
    wrap.dataset.elId = el.id || '';
    applyCommon(wrap, el);

    if (el.type === 'image') {
      var img = document.createElement('img');
      img.src = String(el.src || '');
      img.alt = '';
      img.draggable = false;
      img.style.cssText = 'width:100%;height:100%;object-fit:' + (el.style && el.style.objectFit === 'cover' ? 'cover' : 'contain') + ';display:block';
      if (el.style && el.style.radius) img.style.borderRadius = num(el.style.radius, 0) + 'px';
      if (el.style && el.style.border) img.style.boxShadow = '0 0 0 ' + Math.max(1, num(el.style.borderWidth, 2)) + 'px ' + el.style.border;
      wrap.appendChild(img);
      applyLink(wrap, el);
      return wrap;
    }

    if (el.type === 'table') {
      var t = buildTable(el);
      t.dataset.elId = el.id || '';
      applyCommon(t, el);
      applyLink(t, el);
      return t;
    }

    if (el.type === 'shape') {
      wrap.appendChild(buildShape(el));
      var label = document.createElement('div');
      label.className = 'ppt-shape-text';
      label.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
        + textStyleCss(el) + ';padding:2px 6px;box-sizing:border-box;overflow:hidden';
      label.textContent = el.content || '';
      if (SHAPE_CLIP[el.shape]) {
        // 裁剪形状内的文字随形状一起裁掉，避免溢出到盒外
        label.style.clipPath = SHAPE_CLIP[el.shape];
      }
      wrap.appendChild(label);
      applyLink(wrap, el);
      return wrap;
    }

    // text / 未知类型统一按文本处理
    var st = el.style || {};
    var valign = ['middle', 'bottom'].indexOf(st.valign) >= 0 ? st.valign : 'top';
    wrap.classList.add('ppt-el-text');
    wrap.style.cssText += ';display:flex;flex-direction:column;justify-content:' + (valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start') + ';overflow:hidden';
    var inner = document.createElement('div');
    inner.className = 'ppt-text-inner';
    inner.style.cssText = textStyleCss(el) + ';white-space:pre-wrap;word-break:break-word';
    inner.textContent = el.content == null ? '' : String(el.content);
    if (el.link) {
      applyLink(wrap, el);
      inner.style.textDecoration = 'underline';
    }
    wrap.appendChild(inner);
    return wrap;
  }

  /** 幻灯片背景：纯色或渐变 */
  function backgroundCss(slide) {
    var bg = slide && slide.background ? String(slide.background) : '';
    if (!bg) return '#ffffff';
    // 渐变/图片等复合背景直接透传（仅服务端导入与本编辑器写入，值域可控）
    if (/^(linear|radial|conic|repeating)-gradient\(/i.test(bg) || /^url\(/i.test(bg)) return bg;
    if (slide.backgroundImage) {
      return { color: bg, image: slide.backgroundImage };
    }
    return bg;
  }

  /**
   * 把幻灯片渲染进画布节点
   * @param {HTMLElement} canvas 960x540 的逻辑画布
   * @param {object} slide
   * @param {{editable?: boolean, onRender?: function}} [opts]
   */
  function renderSlide(canvas, slide, opts) {
    if (!canvas) return;
    canvas.innerHTML = '';
    var bg = slide ? backgroundCss(slide) : '#ffffff';
    if (bg && typeof bg === 'object') {
      canvas.style.background = bg.color;
      canvas.style.backgroundImage = bg.image;
      canvas.style.backgroundSize = 'cover';
      canvas.style.backgroundPosition = 'center';
    } else {
      canvas.style.background = String(bg);
      canvas.style.backgroundImage = slide && slide.backgroundImage ? 'url(' + slide.backgroundImage + ')' : 'none';
      if (slide && slide.backgroundImage) {
        canvas.style.backgroundSize = 'cover';
        canvas.style.backgroundPosition = 'center';
      }
    }
    if (!slide) return;
    (slide.elements || []).forEach(function (el) {
      var node = renderElement(el);
      if (node) canvas.appendChild(node);
    });
    if (opts && typeof opts.onRender === 'function') opts.onRender(canvas, slide);
  }

  /**
   * 逻辑画布按舞台等比缩放
   * @param {HTMLElement} stage 外层容器
   * @param {HTMLElement} canvas 960x540 画布
   * @param {boolean} contain true=完整显示并居中（放映/嵌入），false=按宽铺满（页内预览）
   */
  function fit(stage, canvas, contain) {
    if (!stage || !canvas) return;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    if (sw <= 0) return;
    var scale = contain && sh > 0 ? Math.min(sw / LOGIC_W, sh / LOGIC_H) : sw / LOGIC_W;
    canvas.style.transform = 'scale(' + scale + ')';
    canvas.style.left = (contain && sh > 0) ? Math.round((sw - LOGIC_W * scale) / 2) + 'px' : '0px';
    canvas.style.top = (contain && sh > 0) ? Math.round((sh - LOGIC_H * scale) / 2) + 'px' : '0px';
    if (!(contain && sh > 0)) stage.style.height = Math.round(sw * LOGIC_H / LOGIC_W) + 'px';
  }

  /** 元素命中测试用的逻辑坐标换算：屏幕点 → 画布坐标 */
  function toCanvasPoint(canvas, clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var scale = rect.width / LOGIC_W || 1;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale: scale };
  }

  /** 按版式生成新幻灯片 */
  function makeSlide(layout, opts) {
    var key = LAYOUTS[layout] ? layout : 'blank';
    var o = opts || {};
    var id = o.id || newId('slide');
    var elements = LAYOUTS[key].slots.map(function (slot) {
      var el = {
        id: newId(slot.role || 'el'),
        type: 'text',
        x: slot.x, y: slot.y, width: slot.width, height: slot.height,
        content: slot.role === 'title' ? (o.title || '点击添加标题') : (slot.role === 'subtitle' ? (o.subtitle || '点击添加副标题') : (o.body || '点击输入内容')),
        style: JSON.parse(JSON.stringify(slot.style)),
        role: slot.role
      };
      return el;
    });
    return {
      id: id,
      title: (o.title || '新幻灯片').slice(0, 40),
      layout: key,
      background: o.background || '#ffffff',
      elements: elements,
      notes: o.notes || '',
      transition: o.transition || { type: 'fade', duration: 400 },
      hidden: false
    };
  }

  /** 补齐历史文档缺失字段，并修复 slideOrder（就地，返回同一对象） */
  function normalizeDoc(doc) {
    if (!doc || typeof doc !== 'object') return { slides: [], slideOrder: [] };
    if (!Array.isArray(doc.slides)) doc.slides = [];
    doc.slides.forEach(function (s, i) {
      if (!s.id) s.id = 'slide_' + (i + 1);
      if (!Array.isArray(s.elements)) s.elements = [];
      s.elements.forEach(function (el, j) { if (!el.id) el.id = 'el_' + (i + 1) + '_' + (j + 1); });
      if (!s.background) s.background = '#ffffff';
      if (typeof s.notes !== 'string') s.notes = '';
      if (!s.transition || typeof s.transition !== 'object') s.transition = { type: 'fade', duration: 400 };
      if (s.hidden == null) s.hidden = false;
      if (!s.layout) s.layout = 'blank';
    });
    if (!Array.isArray(doc.slideOrder) || !doc.slideOrder.length) {
      doc.slideOrder = doc.slides.map(function (s) { return s.id; });
    }
    // slideOrder 可能存在已删除的 id，也可能漏掉新页：按顺序去重补齐
    var ids = {};
    doc.slides.forEach(function (s) { ids[s.id] = true; });
    var seen = {};
    doc.slideOrder = doc.slideOrder.filter(function (id) {
      if (!ids[id] || seen[id]) return false;
      seen[id] = true;
      return true;
    });
    doc.slides.forEach(function (s) {
      if (!seen[s.id]) { doc.slideOrder.push(s.id); seen[s.id] = true; }
    });
    return doc;
  }

  /**
   * 按 slideOrder 解析实际幻灯片数组（派生数据，不写回文档，避免序列化时重复存储）
   */
  function ordered(doc) {
    if (!doc || !Array.isArray(doc.slides)) return [];
    var byId = {};
    doc.slides.forEach(function (s) { byId[s.id] = s; });
    var list = [];
    (doc.slideOrder || []).forEach(function (id) { if (byId[id]) list.push(byId[id]); });
    doc.slides.forEach(function (s) { if (list.indexOf(s) < 0) list.push(s); });
    return list;
  }

  /** 放映顺序的幻灯片（跳过隐藏页） */
  function showOrder(doc) {
    return ordered(doc).filter(function (s) { return !s.hidden; });
  }

  window.PPTScene = {
    LOGIC_W: LOGIC_W,
    LOGIC_H: LOGIC_H,
    LAYOUTS: LAYOUTS,
    SHAPE_NAMES: SHAPE_NAMES,
    TRANSITIONS: TRANSITIONS,
    renderElement: renderElement,
    renderSlide: renderSlide,
    fit: fit,
    toCanvasPoint: toCanvasPoint,
    makeSlide: makeSlide,
    normalizeDoc: normalizeDoc,
    ordered: ordered,
    showOrder: showOrder,
    newId: newId
  };
})();
