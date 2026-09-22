/* ===== 站点字体切换 =====
 * 切换机制：修改 <html> 上的 --font-sans CSS 变量（style.css 的 body 等元素均引用该变量），
 * 选择持久化在 localStorage('site_font')，多页面共享。
 * 字体列表：内置站点字体（@font-face 定义于 fonts.css）+ 常用系统字体（无需下载，按用户本机已安装字体渲染）。
 * 页面下拉菜单（.site-font-select）由本脚本在 DOMContentLoaded 时统一生成，保证单一数据源。
 */
(function() {
  var FONTS = [
    { key: 'default', label: '🅰️ 默认', family: '' },
    { key: 'zysdmycy', label: '子燕是动漫二次元', family: "'子燕是动漫二次元', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { key: 'bcmhtt', label: '宝灿谋会停手写体2.0', family: "'宝灿谋会停手写体2.0', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { key: 'pingfang', label: '苹方（现代无衬线）', family: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif" },
    { key: 'yahei', label: '微软雅黑', family: "'Microsoft YaHei', 'PingFang SC', 'Segoe UI', sans-serif" },
    { key: 'songti', label: '宋体（衬线）', family: "'SimSun', 'Songti SC', 'Noto Serif CJK SC', 'NSimSun', serif" },
    { key: 'heiti', label: '黑体（粗黑）', family: "'SimHei', 'Heiti SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif" },
    { key: 'kaiti', label: '楷体（手写风）', family: "'KaiTi', 'STKaiti', 'Kaiti SC', 'Noto Serif CJK SC', serif" },
    { key: 'fangsong', label: '仿宋（公文风）', family: "'FangSong', 'STFangsong', 'Noto Serif CJK SC', serif" },
    { key: 'yuanti', label: '圆体 / 等线', family: "'DengXian', 'Yuanti SC', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { key: 'lishu', label: '隶书（古典）', family: "'LiSu', 'STLiti', 'KaiTi', serif" },
    { key: 'serif', label: '英文衬线 (Georgia)', family: "'Georgia', 'Times New Roman', 'Songti SC', serif" },
    { key: 'mono', label: '等宽 (Consolas)', family: "'Consolas', 'Courier New', 'Menlo', 'DejaVu Sans Mono', monospace" }
  ];

  function getFont(key) {
    for (var i = 0; i < FONTS.length; i++) {
      if (FONTS[i].key === key) return FONTS[i];
    }
    return FONTS[0];
  }

  function apply(key) {
    var f = getFont(key);
    if (f.family) {
      document.documentElement.style.setProperty('--font-sans', f.family);
    } else {
      document.documentElement.style.removeProperty('--font-sans');
    }
    try { localStorage.setItem('site_font', f.key); } catch (e) { /* 忽略存储异常 */ }
    // 同步页面上所有字体下拉（导航栏 / 浮动栏等）
    var sels = document.querySelectorAll('.site-font-select');
    for (var i = 0; i < sels.length; i++) sels[i].value = f.key;
  }

  window.setSiteFont = apply;

  // 用 FONTS 数据源统一填充所有字体下拉框（单一数据源，避免各页面硬编码不同步）
  function populateSelects() {
    var sels = document.querySelectorAll('.site-font-select');
    for (var i = 0; i < sels.length; i++) {
      sels[i].innerHTML = '';
      for (var j = 0; j < FONTS.length; j++) {
        var opt = document.createElement('option');
        opt.value = FONTS[j].key;
        opt.textContent = FONTS[j].label;
        sels[i].appendChild(opt);
      }
    }
  }

  // 立即应用已保存的字体（避免闪烁），DOM 就绪后填充下拉框
  var saved = 'default';
  try { saved = localStorage.getItem('site_font') || 'default'; } catch (e) { /* 忽略存储异常 */ }
  apply(saved);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      populateSelects();
      apply(saved);
    });
  } else {
    populateSelects();
    apply(saved);
  }
})();
