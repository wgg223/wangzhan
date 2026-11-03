/**
 * 页面布局视图：在 iframe 里按 A4 实测分页渲染文档
 *
 * 数据来源是后端 /page-view（renderDocFlow）返回的「每个 block 一段 HTML」，
 * 分页必须由浏览器实测高度决定，所以在这里把 block 逐段填进页面内容区，
 * 放不下的段落按行拆分，表格与图片整块移到下一栏/下一页。
 *
 * 之所以用 iframe：服务端 CSS 与导出 HTML / 打印完全同一份，
 * 既不会污染编辑器页面的样式，也让打印时得到的就是这套分页结果。
 */
(function (global) {
  'use strict';

  var PT = 96 / 72;          // 1pt = 1.333px（浏览器 96dpi）
  var COL_GAP_PT = 18;       // 分栏间距，与服务端 applyPageSetup 保持一致
  var MAX_PAGES = 400;       // 防御异常内容导致死循环
  var EPS = 0.6;             // 高度比较容差（px）

  function toPx(pt) { return Math.round(num(pt, 0) * PT * 100) / 100; }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  // ============ 文本切片（段落跨页拆分用） ============

  function collectTextNodes(root) {
    var out = [];
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) out.push(child);
        else if (child.nodeType === 1) walk(child);
      }
    })(root);
    return out;
  }

  /** 取元素内 [from, from+count) 这段文本，保留原有标签与样式 */
  function sliceElement(el, from, count) {
    var clone = el.cloneNode(true);
    var limit = from + count;
    var pos = 0;
    collectTextNodes(clone).forEach(function (tn) {
      var len = tn.nodeValue.length;
      var s = Math.max(0, from - pos);
      var e = Math.min(len, limit - pos);
      tn.nodeValue = e > s ? tn.nodeValue.slice(s, e) : '';
      pos += len;
    });
    return clone;
  }

  // ============ iframe 外壳 ============

  // 打印 / PDF 页由服务端拼外壳，样式必须与此完全一致，否则分页测量结果会偏
  var DL_CSS = ''
    + 'html,body{margin:0;padding:0;background:#e8eaed;}'
    + 'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;}'
    + '.dl-sheet{padding:56px 24px 40px;display:flex;flex-direction:column;align-items:center;gap:22px;}'
    + '.dl-page{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18);position:relative;'
    + 'display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden;}'
    + '.dl-page .doc-content{flex:1 1 auto;min-height:0;}'
    + '.dl-cols{display:flex;flex:1 1 auto;min-height:0;column-gap:normal;}'
    + '.dl-col{flex:0 0 auto;min-width:0;align-self:flex-start;overflow:hidden;position:relative;}'
    + '.dl-guide{position:absolute;left:0;right:0;border-top:1px dotted #b9c2d0;pointer-events:none;}'
    + '.dl-hf{cursor:default;}'
    + '.dl-hf.dl-editable{cursor:text;}'
    + '.dl-hf.dl-editable:hover{background:#f4f7ff;}'
    + '.dl-page-no{position:absolute;bottom:-22px;right:0;font:12px/1 system-ui;color:#6b7280;}'
    + '.dl-ruler{position:sticky;top:0;z-index:5;background:#f3f4f6;border-bottom:1px solid #d7dbe2;'
    + 'height:22px;margin:0 0 -22px;box-sizing:border-box;}'
    + '.dl-ruler-canvas{display:block;height:22px;}'
    + '.dl-measure{position:absolute;left:-99999px;top:0;overflow:hidden;visibility:hidden;}'
    + '.dl-empty{padding:60px;color:#6b7280;font-size:15px;text-align:center;}'
    + '.dl-hl{animation:dlflash 1.6s ease-out;}'
    + '@keyframes dlflash{0%{background:#fff3bf;}100%{background:transparent;}}'
    + '@media print{html,body{background:#fff;}.dl-sheet{padding:0;gap:0;}'
    + '.dl-page{box-shadow:none;break-after:page;page-break-after:always;}'
    + '.dl-page:last-child{break-after:auto;page-break-after:auto;}'
    + '.dl-page-no,.dl-ruler,.dl-guide,.dl-measure{display:none!important;}'
    + '}';

  // 阅读视图：连续排版，不造页盒，字体缩放交给 .doc-container 的 font-size（服务端 CSS 用 em）
  var DR_CSS = ''
    + 'body{background:#f4f3f0;}'
    + '.dr-wrap{padding:22px 16px 72px;}'
    + '.dr-sheet{margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.08);}'
    + '@media print{.dr-wrap{padding:0;}.dr-sheet{box-shadow:none;}}';

  function shellHtml(data) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<style>' + data.css + '</style>'
      + '<style id="dlCss">' + DL_CSS + '</style></head><body class="dl-print-root">'
      + '<div class="dl-ruler" id="dlRuler"></div>'
      + '<div class="dl-sheet" id="dlSheet"></div>'
      + '<div class="dl-measure" id="dlMeasure"></div>'
      + '</body></html>';
  }

  function readingShellHtml(data) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<style>' + data.css + '</style>'
      + '<style id="dlCss">' + DL_CSS + DR_CSS + '</style></head>'
      + '<body class="reading-mode"><div class="dr-wrap">'
      + '<div class="doc-container dr-sheet" id="drSheet"></div>'
      + '</div></body></html>';
  }

  // ============ 分页 ============

  /**
   * 把 block 依次填入列，列满翻页；段落按行拆分，其余整块搬运
   * @param {Document} D iframe 文档
   * @param {object} data /page-view 返回的数据
   * @param {object} state 跨节累计状态 { pages: [] }
   */
  function fillSection(D, sec) {
    var sheet = D.getElementById('dlSheet');
    var measure = D.getElementById('dlMeasure');
    var pageW = toPx(sec.pageWidthPt);
    var pageH = toPx(sec.pageHeightPt);
    var padT = toPx(sec.margins.top);
    var padB = toPx(sec.margins.bottom);
    var padL = toPx(sec.margins.left);
    var padR = toPx(sec.margins.right);
    var contentW = Math.max(60, pageW - padL - padR);
    var colCount = Math.max(1, Math.min(4, num(sec.columns, 1)));
    var gapPx = colCount > 1 ? toPx(COL_GAP_PT) : 0;
    var colW = Math.max(60, (contentW - gapPx * (colCount - 1)) / colCount);

    function newPage() {
      return createPage(D, sec, pageW, pageH, padT, padR, padB, padL, colCount, colW, gapPx);
    }

    // 先造一页量出页眉页脚占位，再确定正文可用高度
    var probe = newPage();
    sheet.appendChild(probe);
    var bodyH = Math.max(40, innerHeightOf(probe));
    sheet.removeChild(probe);

    var queue = [];
    sec.blocks.forEach(function (html) {
      var host = D.createElement('div');
      host.innerHTML = html;
      var kids = [];
      for (var i = 0; i < host.childNodes.length; i++) {
        if (host.childNodes[i].nodeType === 1) kids.push(host.childNodes[i].cloneNode(true));
      }
      queue = queue.concat(kids);
    });

    var pages = [];
    if (!queue.length) {
      var only = newPage();
      colsOf(only)[0].appendChild(emptyParagraph(D));
      sheet.appendChild(only);
      return [only];
    }

    var colIdx = 0;
    var col = null;
    var used = 0;
    var guard = 0;

    function nextColumn() {
      used = 0;
      colIdx += 1;
      if (pages.length && colIdx < colsOf(pages[pages.length - 1]).length) {
        col = colsOf(pages[pages.length - 1])[colIdx];
        return;
      }
      if (pages.length >= MAX_PAGES) return;
      var fresh = newPage();
      sheet.appendChild(fresh);
      pages.push(fresh);
      colIdx = 0;
      col = colsOf(fresh)[0];
    }

    function needs(node) {
      measure.style.width = colW + 'px';
      measure.textContent = '';
      measure.appendChild(node);
      return measure.scrollHeight;
    }

    nextColumn();
    while (queue.length) {
      if (guard++ > MAX_PAGES * 40) break;
      var block = queue.shift();
      var space = Math.max(0, bodyH - used);
      var need = needs(block.cloneNode(true));
      if (need <= space + EPS) {
        col.appendChild(block);
        used += need;
        continue;
      }
      if (space > 12 || used === 0) {
        var piece = splitToFit(D, measure, block, used === 0 ? bodyH : space, colW);
        if (piece) {
          used += needs(piece.head.cloneNode(true));
          col.appendChild(piece.head);
          queue.unshift(piece.rest);
          nextColumn();
          continue;
        }
      }
      if (used > 0) {
        queue.unshift(block);
        nextColumn();
      } else {
        col.appendChild(block); // 单块高过整页，只能溢出显示
        nextColumn();
      }
    }

    return pages;
  }

  /** 二分找出「高度不超过 maxHeight」的最大字符数，切成 head + rest */
  function splitToFit(D, measure, block, maxHeight, widthPx) {
    var total = block.textContent.length;
    if (!total) return null;
    measure.style.width = widthPx + 'px';
    function heightOf(count) {
      measure.textContent = '';
      measure.appendChild(sliceElement(block, 0, count));
      return measure.scrollHeight;
    }
    if (heightOf(1) > maxHeight) return null;
    if (heightOf(total) <= maxHeight) return null;
    var lo = 1, hi = total;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (heightOf(mid) <= maxHeight) lo = mid; else hi = mid - 1;
    }
    // 回退到最近的行/句边界，避免切在半个汉字上
    var cut = snapToBoundary(block.textContent, lo);
    if (cut <= 0 || cut >= total) return null;
    return { head: sliceElement(block, 0, cut), rest: sliceElement(block, cut, total - cut) };
  }

  function snapToBoundary(text, pos) {
    var slice = text.slice(0, pos);
    var idx = Math.max(
      slice.lastIndexOf(' '),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('，'),
      slice.lastIndexOf('。'),
      slice.lastIndexOf('、'),
      slice.lastIndexOf('；')
    );
    if (idx > pos - 40) return idx;
    return pos;
  }

  // ============ 页面盒子 ============

  function createPage(D, sec, pageW, pageH, padT, padR, padB, padL, colCount, colW, gapPx) {
    var page = D.createElement('div');
    page.className = 'dl-page doc-page';
    page.style.width = pageW + 'px';
    page.style.height = pageH + 'px';
    page.style.padding = padT + 'px ' + padR + 'px ' + padB + 'px ' + padL + 'px';
    // dataset 会做 kebab→camel 转换，这里必须用驼峰键，否则 section 索引丢失、页眉页脚取错配置
    page.dataset.sectionIndex = String(sec.index);

    if (sec.header && sec.header.enabled) {
      page.appendChild(hfElement(D, 'header', 'doc-header'));
    }

    var cols = D.createElement('div');
    cols.className = 'dl-cols doc-content';
    for (var c = 0; c < colCount; c++) {
      var col = D.createElement('div');
      col.className = 'dl-col';
      col.style.flex = '0 0 ' + colW + 'px';
      if (c > 0 && gapPx) col.style.marginLeft = gapPx + 'px';
      cols.appendChild(col);
    }
    page.appendChild(cols);

    if (sec.footer && sec.footer.enabled) {
      page.appendChild(hfElement(D, 'footer', 'doc-footer'));
    }

    // 正文边界虚线（Word 的页边距提示）
    var guideTop = D.createElement('div');
    guideTop.className = 'dl-guide';
    guideTop.style.top = padT + 'px';
    page.appendChild(guideTop);
    var guideBottom = D.createElement('div');
    guideBottom.className = 'dl-guide';
    guideBottom.style.bottom = padB + 'px';
    page.appendChild(guideBottom);

    var no = D.createElement('div');
    no.className = 'dl-page-no';
    page.appendChild(no);
    return page;
  }

  function hfElement(D, type, cssClass) {
    var el = D.createElement('div');
    el.className = cssClass + ' dl-hf';
    el.dataset.hf = type;
    return el;
  }

  function colsOf(page) {
    var list = page.querySelectorAll('.dl-col');
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function innerHeightOf(page) {
    var cols = page.querySelector('.dl-cols');
    return cols ? cols.clientHeight : 0;
  }

  function emptyParagraph(D) {
    var p = D.createElement('p');
    p.textContent = '';
    return p;
  }

  // ============ 页码填充 ============

  function stampPages(pages, data) {
    var total = pages.length;
    var offset = num((data.sections[0] || {}).pageNumberStart, 1) - 1;
    pages.forEach(function (page, i) {
      var sec = data.sectionsByIndex[num(page.dataset.sectionIndex, 0)] || data.sections[0] || {};
      var pageNo = i + 1 + offset;
      var no = page.querySelector('.dl-page-no');
      if (no) no.textContent = '第 ' + (i + 1) + ' / 共 ' + total + ' 页';
      var slots = page.querySelectorAll('.dl-hf');
      for (var s = 0; s < slots.length; s++) {
        var slot = slots[s];
        var conf = slot.dataset.hf === 'header' ? sec.header : sec.footer;
        slot.textContent = String((conf && conf.text) || '')
          .replace(/\{PAGE\}/g, String(pageNo))
          .replace(/\{NUMPAGES\}/g, String(total))
          .replace(/\{SECTION\}/g, String(num(sec.index, 0) + 1));
      }
    });
  }

  // ============ 标尺 ============

  function drawRuler(D, sec) {
    var host = D.querySelector('.dl-ruler');
    if (!host) return;
    var canvas = host.querySelector('canvas');
    if (!canvas) {
      canvas = D.createElement('canvas');
      canvas.className = 'dl-ruler-canvas';
      host.appendChild(canvas);
    }
    var pageW = toPx(sec.pageWidthPt);
    var dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(pageW * dpr);
    canvas.height = Math.round(22 * dpr);
    canvas.style.width = pageW + 'px';
    canvas.style.height = '22px';
    host.style.width = pageW + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, pageW, 22);
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, pageW, 22);
    var ml = toPx(sec.margins.left);
    var mr = toPx(sec.margins.right);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(0, 0, ml, 22);
    ctx.fillRect(pageW - mr, 0, mr, 22);
    ctx.strokeStyle = '#c3cad6';
    ctx.beginPath();
    ctx.moveTo(ml + 0.5, 0); ctx.lineTo(ml + 0.5, 22);
    ctx.moveTo(pageW - mr - 0.5, 0); ctx.lineTo(pageW - mr - 0.5, 22);
    ctx.stroke();
    // 刻度：每厘米一格，每 5 厘米标数字
    var cmPx = 96 / 2.54;
    ctx.font = '10px system-ui';
    ctx.fillStyle = '#6b7280';
    ctx.strokeStyle = '#9aa3b2';
    for (var i = 0; i * cmPx <= pageW; i++) {
      var x = Math.round(i * cmPx) + 0.5;
      var tall = i % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(x, tall ? 4 : 12);
      ctx.lineTo(x, 22);
      ctx.stroke();
      if (tall && i > 0) ctx.fillText(String(i), x + 2, 11);
    }
  }

  // ============ 对外接口 ============

  /** 服务端给每个标题渲染了 id="toc-anchor-N"，两处视图都靠它做定位与页码映射 */
  function goToAnchor(D, anchor) {
    var el = D.getElementById(String(anchor || ''));
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('dl-hl');
    setTimeout(function () { el.classList.remove('dl-hl'); }, 1600);
    return true;
  }

  /** 每个锚点落在第几页（页码含 section 起始页偏移），供「生成目录」写入真实页码 */
  function anchorPageMap(D, toc, data) {
    var map = {};
    var pages = D.querySelectorAll('.dl-page');
    if (!pages.length) return map;
    var first = (data && data.sections && data.sections[0]) || {};
    var offset = num(first.pageNumberStart, 1) - 1;
    (toc || []).forEach(function (item) {
      var el = D.getElementById(item.anchor);
      if (!el) return;
      for (var i = 0; i < pages.length; i++) {
        if (pages[i] === el || pages[i].contains(el)) {
          map[item.anchor] = i + 1 + offset;
          break;
        }
      }
    });
    return map;
  }

  /** 滚动位置对应的当前章节锚点（大纲窗格高亮用） */
  function activeAnchor(D, toc, viewH) {
    var current = null;
    var list = toc || [];
    for (var i = 0; i < list.length; i++) {
      var el = D.getElementById(list[i].anchor);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= Math.max(40, viewH * 0.25)) current = list[i].anchor;
      else break;
    }
    return current;
  }

  // 页面盒子按 index 取版式配置，避免依赖数组位置（渲染端会跳过空节）
  function indexSections(payload) {
    payload.sectionsByIndex = {};
    payload.sections.forEach(function (sec) { payload.sectionsByIndex[num(sec.index, 0)] = sec; });
    return payload;
  }

  /**
   * 在指定 document 内分页渲染（编辑器 iframe 与打印/PDF 页共用同一套测量逻辑）
   * @param {Document} D 目标文档，需含 #dlSheet 与 #dlMeasure
   * @param {object} data /page-view 返回的 data
   * @returns {Element[]} 页元素列表
   */
  function renderPages(D, data) {
    var sheet = D.getElementById('dlSheet');
    if (!sheet) return [];
    sheet.textContent = '';
    var all = [];
    data.sections.forEach(function (sec) {
      all = all.concat(fillSection(D, sec) || []);
    });
    if (!all.length) {
      var box = D.createElement('div');
      box.className = 'dl-empty';
      box.textContent = '文档暂无内容';
      sheet.appendChild(box);
    }
    stampPages(all, data);
    return all;
  }

  /**
   * 阅读视图渲染：所有 block 顺排进一个连续容器，不测量、不分页
   * @returns {Element[]} 正文元素列表
   */
  function renderReading(D, data) {
    var sheet = D.getElementById('drSheet');
    if (!sheet) return [];
    sheet.textContent = '';
    var out = [];
    (data.sections || []).forEach(function (sec) {
      (sec.blocks || []).forEach(function (html) {
        var host = D.createElement('div');
        host.innerHTML = html;
        for (var i = 0; i < host.childNodes.length; i++) {
          var node = host.childNodes[i];
          if (node.nodeType !== 1) continue;
          var el = node.cloneNode(true);
          sheet.appendChild(el);
          out.push(el);
        }
      });
    });
    if (!out.length) {
      var box = D.createElement('div');
      box.className = 'dl-empty';
      box.textContent = '文档暂无内容';
      sheet.appendChild(box);
    }
    return out;
  }

  /**
   * 打印页入口：在顶层文档里分页并可选只保留指定页码范围
   * @param {Document} D
   * @param {object} data /page-view 返回的 data
   * @param {object} [opts] { from, to, headerFooter }
   * @returns {object} { pages, total }
   */
  function renderPrintPage(D, data, opts) {
    var o = opts || {};
    // 屏显外壳由 shellHtml 自带样式，服务端拼的打印页则在这里补齐，两处同一份 DL_CSS
    if (!D.getElementById('dlCss')) {
      var st = D.createElement('style');
      st.id = 'dlCss';
      st.textContent = DL_CSS;
      D.head.appendChild(st);
    }
    indexSections(data);
    var pages = renderPages(D, data);
    var total = pages.length;
    var from = Math.min(Math.max(1, num(o.from, 1)), total);
    var to = num(o.to, 0);
    if (to < from || to > total) to = total;
    pages.forEach(function (p, i) {
      var no = i + 1;
      if (no < from || no > to) p.parentNode.removeChild(p);
      if (o.headerFooter === false) {
        var slots = p.querySelectorAll('.dl-hf');
        for (var k = 0; k < slots.length; k++) slots[k].style.display = 'none';
      }
    });
    return { pages: Math.max(0, to - from + 1), total: total };
  }

  /**
   * @param {HTMLElement} host 宿主容器
   * @param {object} data /page-view 返回的 data
   * @param {object} [opts] { zoom, showRuler, canEdit, onEditHeaderFooter }
   * @returns {object} 实例：setZoom / fitWidth / destroy / pages / print
   */
  function mount(host, data, opts) {
    var o = opts || {};
    var zoom = num(o.zoom, 1);
    var showRuler = o.showRuler !== false;
    // 浏览器打印时按页码范围/页眉页脚开关临时过滤，打印结束即还原
    var printFilter = null;
    var trackingOff = null;
    host.classList.add('dl-host');
    host.innerHTML = '<iframe class="dl-frame" title="页面布局预览"></iframe>';
    var frame = host.querySelector('.dl-frame');
    indexSections(data);

    function applyPrintFilter(pages) {
      if (!printFilter) return;
      var from = Math.max(1, num(printFilter.from, 1));
      var to = num(printFilter.to, pages.length);
      if (to < from || to > pages.length) to = pages.length;
      for (var i = 0; i < pages.length; i++) {
        var page = pages[i];
        var no = i + 1;
        if (no < from || no > to) {
          page.style.display = 'none';
          continue;
        }
        if (printFilter.headerFooter === false) {
          var slots = page.querySelectorAll('.dl-hf');
          for (var k = 0; k < slots.length; k++) slots[k].style.display = 'none';
        }
      }
    }

    function render() {
      var doc = frame.contentDocument;
      if (!doc || !doc.getElementById('dlSheet')) return;
      var all = renderPages(doc, data);
      applyPrintFilter(all);
      var ruler = doc.getElementById('dlRuler');
      if (ruler) ruler.style.display = showRuler ? '' : 'none';
      if (showRuler) drawRuler(doc, data.sections[0] || {});
      applyZoom();
      bindHeaderFooterClick(doc);
      bindScrollTracking();
      if (typeof o.onReady === 'function') o.onReady(all.length, data.warnings || []);
    }

    function applyZoom() {
      var doc = frame.contentDocument;
      if (!doc) return;
      doc.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }

    function bindHeaderFooterClick(doc) {
      if (!o.canEdit || typeof o.onEditHeaderFooter !== 'function') return;
      var slots = doc.querySelectorAll('.dl-hf');
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i];
        slot.classList.add('dl-editable');
        slot.title = '点击编辑' + (slot.dataset.hf === 'header' ? '页眉' : '页脚');
        slot.addEventListener('click', function () {
          o.onEditHeaderFooter(this.dataset.hf, this.textContent);
        });
      }
    }

    function bindScrollTracking() {
      if (trackingOff) trackingOff();
      trackingOff = null;
      if (typeof o.onActiveAnchor !== 'function') return;
      var win = frame.contentWindow;
      var doc = frame.contentDocument;
      if (!win || !doc) return;
      var rafId = 0;
      var emit = function () {
        o.onActiveAnchor(activeAnchor(doc, data.toc, win.innerHeight));
      };
      var onScroll = function () {
        if (rafId) return;
        rafId = win.requestAnimationFrame(function () { rafId = 0; emit(); });
      };
      win.addEventListener('scroll', onScroll, { passive: true });
      emit();
      trackingOff = function () {
        win.removeEventListener('scroll', onScroll);
        if (rafId && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
        rafId = 0;
      };
    }

    frame.addEventListener('load', render);
    frame.srcdoc = shellHtml(data);

    return {
      setData: function (next) { if (next) { data = indexSections(next); render(); } },
      setZoom: function (z) { zoom = Math.max(0.4, Math.min(2.5, num(z, 1))); applyZoom(); },
      setRuler: function (visible) { showRuler = Boolean(visible); render(); },
      fitWidth: function () {
        var sec = data.sections[0] || {};
        var pageW = toPx(sec.pageWidthPt || 595);
        var avail = frame.clientWidth - 48;
        zoom = Math.max(0.4, Math.min(2.5, avail / pageW));
        applyZoom();
        return zoom;
      },
      setPrintFilter: function (filter) { printFilter = filter || null; render(); },
      goTo: function (anchor) {
        var doc = frame.contentDocument;
        return doc ? goToAnchor(doc, anchor) : false;
      },
      anchorPages: function () {
        var doc = frame.contentDocument;
        return doc ? anchorPageMap(doc, data.toc, data) : {};
      },
      print: function (filter) {
        var restore = Boolean(filter);
        if (restore) { printFilter = filter; render(); }
        var doc = frame.contentDocument;
        var restored = false;
        var done = function () {
          if (!restore || restored) return;
          restored = true;
          printFilter = null;
          render();
        };
        if (doc && doc.defaultView) doc.defaultView.addEventListener('afterprint', done, { once: true });
        if (frame.contentWindow) frame.contentWindow.focus();
        if (frame.contentWindow) frame.contentWindow.print();
        // afterprint 在部分浏览器取消打印时不触发，兜底还原视图
        setTimeout(done, 60000);
      },
      destroy: function () {
        if (trackingOff) trackingOff();
        trackingOff = null;
        host.innerHTML = '';
        host.classList.remove('dl-host');
      }
    };
  }

  /**
   * 阅读视图：连续排版 + 字号/页宽调节 + 大纲跳转
   * @param {HTMLElement} host 宿主容器
   * @param {object} data /page-view?mode=reading 返回的数据
   * @param {object} [opts] { fontSize, pageWidth, onActiveAnchor, onReady }
   * @returns {object} 实例：setFontSize / setPageWidth / goTo / print / destroy
   */
  function mountReading(host, data, opts) {
    var o = opts || {};
    var fontSize = num(o.fontSize, 17);
    var pageWidth = num(o.pageWidth, 0); // 0 = 跟随服务端默认页宽
    var trackingOff = null;
    host.classList.add('dl-host');
    host.innerHTML = '<iframe class="dl-frame dr-frame" title="文档阅读视图"></iframe>';
    var frame = host.querySelector('.dr-frame');
    indexSections(data);

    function applyScale() {
      var doc = frame.contentDocument;
      var sheet = doc && doc.getElementById('drSheet');
      if (!sheet) return;
      sheet.style.fontSize = fontSize + 'px';
      sheet.style.maxWidth = pageWidth ? pageWidth + 'px' : '';
    }

    function bindScrollTracking() {
      if (trackingOff) trackingOff();
      trackingOff = null;
      var win = frame.contentWindow;
      var doc = frame.contentDocument;
      if (!win || !doc || typeof o.onActiveAnchor !== 'function') return;
      var rafId = 0;
      var onScroll = function () {
        if (rafId) return;
        rafId = win.requestAnimationFrame(function () {
          rafId = 0;
          o.onActiveAnchor(activeAnchor(doc, data.toc, win.innerHeight));
        });
      };
      win.addEventListener('scroll', onScroll, { passive: true });
      o.onActiveAnchor(activeAnchor(doc, data.toc, win.innerHeight));
      trackingOff = function () {
        win.removeEventListener('scroll', onScroll);
        if (rafId && win.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
        rafId = 0;
      };
    }

    function render() {
      var doc = frame.contentDocument;
      if (!doc || !doc.getElementById('drSheet')) return;
      var blocks = renderReading(doc, data);
      applyScale();
      bindScrollTracking();
      if (typeof o.onReady === 'function') o.onReady(blocks.length, data.warnings || []);
    }

    frame.addEventListener('load', render);
    frame.srcdoc = readingShellHtml(data);

    return {
      setData: function (next) { if (next) { data = indexSections(next); render(); } },
      setFontSize: function (px) { fontSize = Math.max(12, Math.min(32, num(px, 17))); applyScale(); },
      setPageWidth: function (px) { pageWidth = Math.max(0, num(px, 0)); applyScale(); },
      goTo: function (anchor) {
        var doc = frame.contentDocument;
        return doc ? goToAnchor(doc, anchor) : false;
      },
      print: function () {
        if (frame.contentWindow) frame.contentWindow.focus();
        if (frame.contentWindow) frame.contentWindow.print();
      },
      destroy: function () {
        if (trackingOff) trackingOff();
        trackingOff = null;
        host.innerHTML = '';
        host.classList.remove('dl-host');
      }
    };
  }

  global.DocLayout = {
    mount: mount,
    mountReading: mountReading,
    ptToPx: toPx,
    renderPrintPage: renderPrintPage
  };
})(window);
