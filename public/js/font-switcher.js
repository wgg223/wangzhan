/* ===== 站点字体切换 =====
 * 切换机制：修改 <html> 上的 --font-sans CSS 变量（style.css 的 body 等元素均引用该变量），
 * 选择持久化在 localStorage('site_font')，多页面共享。
 */
(function() {
  var FONTS = [
    { key: 'default', label: '默认字体', family: '' },
    { key: 'zysdmycy', label: '子燕是动漫二次元', family: "'子燕是动漫二次元', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { key: 'bcmhtt', label: '宝灿谋会停手写体2.0', family: "'宝灿谋会停手写体2.0', 'PingFang SC', 'Microsoft YaHei', sans-serif" }
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
    try { localStorage.setItem('site_font', f.key); } catch (e) {}
    // 同步页面上所有字体下拉（导航栏 / 浮动栏等）
    var sels = document.querySelectorAll('.site-font-select');
    for (var i = 0; i < sels.length; i++) sels[i].value = f.key;
  }

  window.setSiteFont = apply;

  var saved = 'default';
  try { saved = localStorage.getItem('site_font') || 'default'; } catch (e) {}
  apply(saved);
})();
