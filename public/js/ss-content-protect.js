/**
 * 只读内容保护（表格编辑器只读视图 + 分享页）
 * 依赖：页面在引入本脚本前设置 window.__SS_PROTECT__ = { watermark, tip }
 * 保护层次（纵深防御，Web 无法绝对防止截图/拍照，需结合服务端权限与审计）：
 *   1. 复制/剪切/右键/选择/拖拽 拦截
 *   2. 复制相关快捷键（Ctrl/Cmd+C/X/A、Ctrl+P/S/U）、开发者工具快捷键拦截
 *   3. PrintScreen 按键检测 + 尽力清空剪贴板
 *   4. 窗口失焦/切后台 → 遮罩隐藏内容
 *   5. 打印/另存为 → 输出替换为版权提示
 *   6. 平铺斜向水印（用户名 #ID / 只读分享）用于泄露溯源
 * 豁免：带 data-ss-copy-ok 属性的输入框（评论框 / 嵌入代码框）允许正常选择复制
 */
(function () {
  'use strict';

  var CFG = window.__SS_PROTECT__ || {};
  var WATERMARK = String(CFG.watermark || '只读内容');
  var TIP = String(CFG.tip || '只读内容受保护，禁止复制');

  // body 标记：供 CSS 关联 user-select / 打印替换 / 隐藏 Univer 右键菜单
  document.documentElement.classList.add('ss-protect-on');
  document.body.classList.add('ss-protect-on');

  // ============ 轻提示（不依赖 utils.js；存在全局 showToast 时优先复用） ============

  var lastToastAt = 0;
  function toast(msg) {
    var now = Date.now();
    if (now - lastToastAt < 1200) return; // 节流：避免连按刷屏
    lastToastAt = now;
    if (typeof window.showToast === 'function') {
      window.showToast(msg, 'warning');
      return;
    }
    var el = document.createElement('div');
    el.className = 'ss-protect-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('is-out'); }, 2200);
    setTimeout(function () { el.remove(); }, 2700);
  }

  // ============ 豁免判定：仅显式标记 data-ss-copy-ok 的可见输入框 ============
  // 不按 tagName 泛化豁免，防止 Univer 隐藏剪贴板代理 textarea 借道复制

  function isCopyOk(target) {
    if (!target || target.nodeType !== 1) return false;
    var el = target.closest ? target.closest('[data-ss-copy-ok]') : null;
    if (!el) return false;
    // 视觉上隐藏的输入框不豁免（防御代理元素伪装）
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  // ============ 1. 剪贴板 / 选择 / 拖拽拦截（capture：先于 Univer 自身监听） ============

  document.addEventListener('copy', function (e) {
    if (isCopyOk(e.target)) return;
    e.preventDefault();
    toast(TIP);
  }, true);

  document.addEventListener('cut', function (e) {
    if (isCopyOk(e.target)) return;
    e.preventDefault();
    toast(TIP);
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (isCopyOk(e.target)) return;
    e.preventDefault();
    toast(TIP);
  }, true);

  document.addEventListener('selectstart', function (e) {
    if (isCopyOk(e.target)) return;
    e.preventDefault();
  }, true);

  document.addEventListener('dragstart', function (e) {
    e.preventDefault();
  }, true);

  // ============ 2. 快捷键拦截（capture + stopPropagation：阻止 Univer 键位服务） ============

  var COPY_KEYS = ['c', 'x', 'a'];
  var BLOCK_KEYS = ['c', 'x', 'a', 'p', 's', 'u'];

  document.addEventListener('keydown', function (e) {
    var key = (e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + C/X/A/P/S/U
    if (mod && !e.shiftKey && !e.altKey && BLOCK_KEYS.indexOf(key) !== -1) {
      // 豁免输入框内的常规文本操作（Ctrl+A 全选自己的输入等）
      if (COPY_KEYS.indexOf(key) !== -1 && isCopyOk(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (key === 'p') toast('禁止打印此内容');
      else if (key === 's' || key === 'u') toast('禁止保存页面');
      else toast(TIP);
      return;
    }

    // F12 / Ctrl+Shift+I/J/C（开发者工具）
    if (key === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].indexOf(key) !== -1)) {
      e.preventDefault();
      e.stopPropagation();
      toast('开发者工具已禁用，内容受保护');
    }
  }, true);

  // ============ 3. PrintScreen 检测：尽力清空剪贴板 ============

  document.addEventListener('keyup', function (e) {
    if (e.key !== 'PrintScreen') return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText('该内容受保护，禁止截图传播').catch(function () { /* 无剪贴板权限时忽略 */ });
    }
    toast('检测到截图按键，内容受保护');
  });

  // ============ 4. 失焦遮罩：窗口失焦 / 切后台时隐藏内容 ============

  var mask = document.createElement('div');
  mask.className = 'ss-protect-mask';
  mask.setAttribute('aria-hidden', 'true');
  mask.innerHTML = '<div class="ss-protect-mask-box">' +
    '<div class="ss-protect-mask-icon">🔒</div>' +
    '<p class="ss-protect-mask-title">内容已隐藏</p>' +
    '<p class="ss-protect-mask-sub">请回到本窗口继续查看</p>' +
    '</div>';
  mask.hidden = true;
  document.body.appendChild(mask);

  window.addEventListener('blur', function () { mask.hidden = false; });
  window.addEventListener('focus', function () { mask.hidden = true; });
  document.addEventListener('visibilitychange', function () {
    mask.hidden = !document.hidden;
  });

  // ============ 5. 打印拦截：输出替换为版权提示 ============

  var notice = document.createElement('div');
  notice.className = 'ss-protect-print-notice';
  notice.textContent = '⚠️ 该内容受版权保护，禁止打印 / 导出';
  document.body.appendChild(notice);

  // ============ 6. 平铺斜向水印（SVG 平铺，pointer-events 不挡交互） ============

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="170">' +
    '<text x="160" y="92" text-anchor="middle" font-family="-apple-system, sans-serif" ' +
    'font-size="14" fill="rgba(0,0,0,0.10)" transform="rotate(-22 160 92)">' +
    escapeXml(WATERMARK) +
    '</text></svg>';

  var wm = document.createElement('div');
  wm.className = 'ss-protect-watermark';
  wm.setAttribute('aria-hidden', 'true');
  wm.style.backgroundImage =
    'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  document.body.appendChild(wm);
})();
