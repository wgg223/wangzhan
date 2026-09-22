/* ===== 站点设置：主题（跟随系统/浅色/深色）+ 语言（简体中文/English）=====
 * - 主题：localStorage('site_theme') = 'light' | 'dark' | 'system'（默认跟随系统）
 *   system 模式监听 prefers-color-scheme，系统切换时实时跟随
 * - 语言：localStorage('site_lang') = 'zh' | 'en'（默认 zh）
 *   通过 [data-i18n]（文本）、[data-i18n-placeholder]、[data-i18n-title] 应用，
 *   未收录的 key 保留页面原文（渐进式，深层页面后续可扩展）
 * - 设置面板：导航栏 ⚙️ 按钮 / 认证页右上角浮动按钮
 */
(function() {
  var THEME_KEY = 'site_theme';
  var LANG_KEY = 'site_lang';

  // ============ 多语言字典 ============
  var I18N = {
    // 导航
    'nav.home': { zh: '首页', en: 'Home' },
    'nav.articles': { zh: '文章', en: 'Articles' },
    'nav.community': { zh: '社区', en: 'Community' },
    'nav.novels': { zh: '小说', en: 'Novels' },
    'nav.images': { zh: '图片', en: 'Images' },
    'nav.aiPrompts': { zh: 'AI提示词', en: 'AI Prompts' },
    'nav.aiImage': { zh: 'AI生图', en: 'AI Images' },
    'nav.aiChat': { zh: 'AI聊天', en: 'AI Chat' },
    'nav.spreadsheet': { zh: '表格', en: 'Sheets' },
    'nav.search': { zh: '搜索', en: 'Search' },
    // 用户菜单 / 按钮
    'menu.myProfile': { zh: '👤 我的主页', en: '👤 My Profile' },
    'menu.account': { zh: '⚙️ 账号管理', en: '⚙️ Account' },
    'menu.myShares': { zh: '🔗 我的分享', en: '🔗 My Shares' },
    'menu.chat': { zh: '💬 私信', en: '💬 Messages' },
    'menu.permission': { zh: '🔐 权限申请', en: '🔐 Permissions' },
    'menu.admin': { zh: '🔧 后台管理', en: '🔧 Admin' },
    'menu.changePassword': { zh: '🔑 修改密码', en: '🔑 Change Password' },
    'menu.logout': { zh: '🚪 退出登录', en: '🚪 Logout' },
    'menu.login': { zh: '登录', en: 'Log in' },
    'menu.register': { zh: '注册', en: 'Sign up' },
    'menu.notifications': { zh: '通知', en: 'Notifications' },
    'menu.markAllRead': { zh: '全部已读', en: 'Mark all read' },
    'menu.noNotifications': { zh: '暂无通知', en: 'No notifications' },
    'menu.dm': { zh: '私信', en: 'Messages' },
    'menu.messages': { zh: '站内信', en: 'Messages' },
    // 弹窗
    'popup.messageTitle': { zh: '站内信', en: 'Message' },
    'popup.viewAllMessages': { zh: '查看所有站内信', en: 'View all messages' },
    'popup.welcome': { zh: '欢迎访问', en: 'Welcome' },
    'popup.gotIt': { zh: '我知道了', en: 'Got it' },
    'popup.privacyTitle': { zh: '用户协议与隐私政策', en: 'Terms & Privacy Policy' },
    'popup.privacyTerms': { zh: '用户协议', en: 'Terms of Service' },
    'popup.privacyPolicy': { zh: '隐私政策', en: 'Privacy Policy' },
    'popup.disagree': { zh: '不同意', en: 'Disagree' },
    'popup.agree': { zh: '同意并继续', en: 'Agree & Continue' },
    'chat.send': { zh: '发送', en: 'Send' },
    'chat.placeholder': { zh: '输入消息...', en: 'Type a message...' },
    'chat.noMessages': { zh: '暂无消息', en: 'No messages' },
    // 设置面板
    'settings.title': { zh: '设置', en: 'Settings' },
    'settings.themeMode': { zh: '主题模式', en: 'Theme' },
    'settings.themeSystem': { zh: '跟随系统', en: 'System' },
    'settings.themeLight': { zh: '浅色', en: 'Light' },
    'settings.themeDark': { zh: '深色', en: 'Dark' },
    'settings.language': { zh: '语言 / Language', en: 'Language' },
    'settings.zh': { zh: '简体中文', en: '简体中文' },
    'settings.en': { zh: 'English', en: 'English' },
    // 认证页
    'auth.loginTitle': { zh: '登录', en: 'Log in' },
    'auth.registerTitle': { zh: '注册', en: 'Sign up' },
    'auth.choiceTitle': { zh: '选择登录方式', en: 'Choose sign-in method' },
    'auth.loginSubtitle': { zh: '欢迎回来，登录您的账号', en: 'Welcome back, sign in to continue' },
    'auth.registerSubtitle': { zh: '创建一个新账号', en: 'Create a new account' },
    'auth.choiceSubtitle': { zh: '第三方账号尚未绑定本站账号', en: 'This third-party account is not linked to any local account' },
    'auth.username': { zh: '用户名', en: 'Username' },
    'auth.password': { zh: '密码', en: 'Password' },
    'auth.email': { zh: '邮箱', en: 'Email' },
    'auth.nickname': { zh: '昵称', en: 'Nickname' },
    'auth.usernamePlaceholder': { zh: '请输入用户名', en: 'Enter username' },
    'auth.passwordPlaceholder': { zh: '请输入密码', en: 'Enter password' },
    'auth.nicknamePlaceholder': { zh: '请输入昵称', en: 'Enter nickname' },
    'auth.captcha': { zh: '验证码', en: 'Captcha' },
    'auth.captchaPlaceholder': { zh: '请输入验证码', en: 'Enter captcha code' },
    'auth.showPassword': { zh: '显示密码', en: 'Show password' },
    'auth.loginBtn': { zh: '登录', en: 'Log in' },
    'auth.registerBtn': { zh: '注册', en: 'Sign up' },
    'auth.forgotPassword': { zh: '忘记密码？', en: 'Forgot password?' },
    'auth.agreeTerms': { zh: '我已阅读并同意《用户协议》', en: 'I have read and agree to the Terms' },
    'auth.agreePrivacy': { zh: '我已阅读并同意《隐私政策》', en: 'I have read and agree to the Privacy Policy' },
    'auth.noAccount': { zh: '还没有账号？', en: "Don't have an account?" },
    'auth.hasAccount': { zh: '已有账号？', en: 'Already have an account?' },
    'auth.backToLogin': { zh: '返回登录', en: 'Back to login' },
    'auth.backToHome': { zh: '返回首页', en: 'Back to home' },
    'auth.directLogin': { zh: '直接登录（自动创建账号）', en: 'Log in directly (auto-create)' },
    'auth.registerNew': { zh: '注册新账号（填写注册信息）', en: 'Register new account' },
    'auth.registerNow': { zh: '立即注册', en: 'Sign up now' },
    'auth.loginNow': { zh: '立即登录', en: 'Log in now' },
    'auth.backToImageShare': { zh: '返回图片分享', en: 'Back to image share' },
    'auth.confirmPassword': { zh: '确认密码', en: 'Confirm password' },
    'auth.confirmPasswordPlaceholder': { zh: '请再次输入密码', en: 'Re-enter password' },
    'auth.usernameRule': { zh: '3-20个字符', en: '3-20 characters' },
    'auth.nicknameOptional': { zh: '选填', en: 'Optional' },
    'auth.emailPlaceholder': { zh: '请输入邮箱地址（格式如：username@domain.com）', en: 'Enter email address' },
    'auth.verifyAndRegister': { zh: '验证并注册', en: 'Verify & sign up' },
    'auth.backStep': { zh: '返回上一步', en: 'Back' },
    'auth.remember': { zh: '记住登录（30 天内免登录）', en: 'Remember me (30 days)' }
  };

  // ============ 工具 ============
  function getStorage(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null || v === undefined || v === '' ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function setStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  // ============ 主题（三态：浅色 / 深色 / 跟随系统）============
  function getTheme() {
    // 兼容旧 key 'theme'（历史 light/dark），无则默认跟随系统
    var t = getStorage(THEME_KEY, '');
    if (t !== 'light' && t !== 'dark' && t !== 'system') {
      var legacy = getStorage('theme', '');
      t = (legacy === 'light' || legacy === 'dark') ? legacy : 'system';
    }
    return t;
  }

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applySiteTheme(theme) {
    var t = theme || getTheme();
    var dark = t === 'dark' || (t === 'system' && systemPrefersDark());
    if (dark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    // 同步浏览器主题色
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#6366f1');
    // 更新面板选中态
    var options = document.querySelectorAll('[data-theme-option]');
    for (var i = 0; i < options.length; i++) {
      options[i].classList.toggle('active', options[i].getAttribute('data-theme-option') === t);
    }
    setStorage(THEME_KEY, t);
  }

  // ============ 语言 ============
  function getLang() {
    var l = getStorage(LANG_KEY, 'zh');
    return (l === 'en') ? 'en' : 'zh';
  }

  function translate(key) {
    var lang = getLang();
    var entry = I18N[key];
    if (!entry) return null;
    return entry[lang] !== undefined ? entry[lang] : entry.zh;
  }

  function applySiteLang(lang) {
    var l = lang || getLang();
    setStorage(LANG_KEY, l);
    document.documentElement.setAttribute('lang', l === 'en' ? 'en' : 'zh-CN');
    // [data-i18n] 文本（仅替换叶子节点，保护含链接/图标等子元素的结构）
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].children.length > 0) continue;
      var text = translate(nodes[i].getAttribute('data-i18n'));
      if (text !== null) nodes[i].textContent = text;
    }
    // [data-i18n-placeholder]
    var phs = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phs.length; j++) {
      var ph = translate(phs[j].getAttribute('data-i18n-placeholder'));
      if (ph !== null) phs[j].setAttribute('placeholder', ph);
    }
    // [data-i18n-title]
    var titles = document.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < titles.length; k++) {
      var t = translate(titles[k].getAttribute('data-i18n-title'));
      if (t !== null) titles[k].setAttribute('title', t);
    }
    // 更新面板语言选项选中态
    var opts = document.querySelectorAll('[data-lang-option]');
    for (var m = 0; m < opts.length; m++) {
      opts[m].classList.toggle('active', opts[m].getAttribute('data-lang-option') === l);
    }
  }

  // ============ 设置面板交互 ============
  function initSettingsPanel() {
    // 支持导航栏按钮与认证页浮动按钮（同一面板结构可多实例：按钮 data-settings-btn，面板 id settingsPanel）
    var btns = document.querySelectorAll('[data-settings-btn]');
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;

    function isOpen() { return !panel.hasAttribute('hidden'); }
    function open() {
      panel.removeAttribute('hidden');
      // 面板随按钮定位：按钮与面板须在同一相对定位容器内（.nav-settings / .auth-settings-wrap）
    }
    function close() { panel.setAttribute('hidden', ''); }
    function toggle() { isOpen() ? close() : open(); }

    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function(e) {
        e.stopPropagation();
        toggle();
      });
    }

    // 主题选项
    panel.addEventListener('click', function(e) {
      var themeOpt = e.target.closest ? e.target.closest('[data-theme-option]') : null;
      if (themeOpt) {
        applySiteTheme(themeOpt.getAttribute('data-theme-option'));
        return;
      }
      var langOpt = e.target.closest ? e.target.closest('[data-lang-option]') : null;
      if (langOpt) {
        applySiteLang(langOpt.getAttribute('data-lang-option'));
      }
    });

    // 点击外部 / Esc 关闭
    document.addEventListener('click', function(e) {
      if (!isOpen()) return;
      if (e.target.closest('[data-settings-btn]') || e.target.closest('#settingsPanel')) return;
      close();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });
  }

  // ============ 初始化 ============
  // 主题立即应用（脚本位于 head，防闪烁）
  applySiteTheme(getTheme());
  // 系统主题变化实时跟随
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', function() {
        if (getTheme() === 'system') applySiteTheme('system');
      });
    } else if (mq.addListener) {
      mq.addListener(function() {
        if (getTheme() === 'system') applySiteTheme('system');
      });
    }
  }

  function onReady() {
    applySiteLang(getLang());
    initSettingsPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  // 暴露给其他脚本
  window.SiteSettings = {
    getTheme: getTheme,
    applyTheme: applySiteTheme,
    getLang: getLang,
    applyLang: applySiteLang,
    t: translate
  };
  window.applySiteTheme = applySiteTheme;
  window.applySiteLang = applySiteLang;
})();
