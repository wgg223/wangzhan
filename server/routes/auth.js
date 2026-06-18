const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { generateCaptcha, verifyCaptcha } = require('../config/captcha');
const { createRateLimiter, loginLimiter } = require('../middlewares/rate-limiter');

// ============ 频率限制器 ============
const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '注册请求过于频繁，请15分钟后再试'
});
const sendCodeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: '验证码发送过于频繁，请15分钟后再试'
});
const resetPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '密码重置尝试过多，请15分钟后再试'
});
const changePasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '修改密码尝试过多，请15分钟后再试'
});

// 支持的邮箱域名白名单（主流邮箱服务商）
const ALLOWED_EMAIL_DOMAINS = [
  'qq.com',
  '163.com',
  '126.com',
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.jp',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'mail.ru',
  'yandex.com',
  'foxmail.com',
  'sina.com',
  'sohu.com',
  'tom.com',
  'aliyun.com',
  '189.cn'
];

// 辅助函数：检查邮箱域名是否在白名单中
function isEmailAllowed(email) {
  const match = email.match(/@([\w.-]+)$/);
  if (!match) return false;
  const domain = match[1].toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

const { saveDatabase, queryOne, queryAll, generateUid } = require('../config/database');
const { logActivity } = require('../config/activity');
const { createNotification } = require('./community');
const logger = require('../utils/logger');
const { ROLE_HIERARCHY } = require('../middlewares/auth');
const { getSettings, getImageConfigs } = require('../utils/settings');

// 辅助函数：生成随机验证码
function generateCode() {
  return crypto.randomBytes(4).toString('hex');
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 辅助函数：检查SMTP是否配置
function isSmtpConfigured(db) {
  try {
    const { queryOne } = require('../config/database');
    const smtpHost = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'smtp_host'");
    const smtpUser = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'smtp_user'");
    const smtpPass = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'smtp_pass'");
    return smtpHost && smtpHost.setting_value && smtpUser && smtpUser.setting_value && smtpPass && smtpPass.setting_value;
  } catch (err) {
    return false;
  }
}

// 辅助函数：发送邮件验证码
function sendEmailCode(db, email, code, callback) {
  try {
    const { sendMail, buildResetPasswordEmail } = require('../config/mailer');
    sendMail(db, {
      to: email,
      subject: '密码重置验证码',
      html: buildResetPasswordEmail(code)
    })
      .then(() => { callback(null); })
      .catch((err) => { console.error('邮件发送失败:', err.message); callback(err); });
  } catch (err) {
    console.error('邮件模块加载失败:', err.message);
    callback(err);
  }
}

// 辅助函数：发送注册验证码邮件
function sendRegisterVerifyCode(db, email, code, username, callback) {
  try {
    const { sendMail, buildRegisterVerificationEmail } = require('../config/mailer');
    sendMail(db, {
      to: email,
      subject: '注册验证码',
      html: buildRegisterVerificationEmail(code, username)
    })
      .then(() => { callback(null); })
      .catch((err) => { console.error('注册验证码邮件发送失败:', err.message); callback(err); });
  } catch (err) {
    console.error('邮件模块加载失败:', err.message);
    callback(err);
  }
}

// 辅助函数：获取站点名称
function getSiteName(db, source) {
  if (source === 'image-share') {
    const config = getImageConfigs(db);
    return config.site_name || '图片分享';
  }
  const settings = getSettings(db);
  return settings.site_name || '我的站点';
}

// 辅助函数：根据模式获取标题和副标题
function getModeInfo(mode, source, step) {
  const info = {
    'login': { title: '用户登录', subtitle: '欢迎回来，请登录您的账号' },
    'register': { title: '用户注册', subtitle: '创建一个新账号' },
    'forgot-password': {
      title: step === 'verify' ? '验证码已发送' : '忘记密码',
      subtitle: step === 'verify' ? '请查收邮箱中的验证码并重置密码' : '输入邮箱获取验证码重置密码'
    },
    'change-password': { title: '修改密码', subtitle: '更新您的密码' },
    'force-change-password': { title: '需要修改密码', subtitle: '请设置一个新密码后继续使用' }
  };
  return info[mode] || info['login'];
}

// ============================================================
// 兼容路由重定向 - 无 source 参数时默认使用 frontend
// ============================================================

// 旧 /auth/login 重定向到 /auth/frontend/login
router.get('/login', (req, res) => {
  return res.redirect('/auth/frontend/login');
});

// 旧 /auth/register 重定向到 /auth/frontend/register
router.get('/register', (req, res) => {
  return res.redirect('/auth/frontend/register');
});

// 兼容 /auth/change-password -> /auth/frontend/change-password
router.get('/change-password', (req, res) => {
  return res.redirect('/auth/frontend/change-password');
});

// 兼容 /auth/change-username -> /auth/frontend/change-username
router.get('/change-username', (req, res) => {
  return res.redirect('/auth/frontend/change-username');
});

// ============================================================
// 统一认证页面入口
// ============================================================

// 登录页面
router.get('/:source/login', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  const modeInfo = getModeInfo('login', source);
  res.render('auth/auth-page', {
    source,
    mode: 'login',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: null,
    user: req.session.user || null,
    username: '',
    step: null,
    email: '',
    userAgreement: '',
    privacyPolicy: ''
  });
});

// 注册页面
router.get('/:source/register', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  const modeInfo = getModeInfo('register', source);

  let userAgreement = '';
  let privacyPolicy = '';
  if (source === 'frontend') {
    const agreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'user_agreement'");
    const privacy = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'privacy_policy'");
    userAgreement = agreement ? agreement.setting_value : '';
    privacyPolicy = privacy ? privacy.setting_value : '';
  }

  // 判断是否是验证码步骤（从注册信息提交后跳转）
  const step = req.query.step || null;
  const tempUsername = req.session.tempRegister ? req.session.tempRegister.username : '';
  const tempEmail = req.session.tempRegister ? req.session.tempRegister.email : '';
  const smtpConfigured = isSmtpConfigured(db);

  // 如果是从基本信息页面进入且有暂存数据，显示验证码步骤
  let showStep = null;
  if (step === 'verify' && req.session.tempRegister) {
    showStep = 'verify';
  } else if (step === 'verify' && !req.session.tempRegister) {
    // 没有暂存数据，回到信息填写
    showStep = 'info';
  } else {
    showStep = 'info';
  }

  // 生成图形验证码（仅信息填写步骤时生成）
  let captchaSvg = '';
  if (showStep === 'info') {
    const captcha = generateCaptcha();
    req.session.captchaText = captcha.text;
    req.session.captchaExpires = Date.now() + 5 * 60 * 1000;
    captchaSvg = captcha.data;
  }

  res.render('auth/auth-page', {
    source,
    mode: 'register',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: null,
    user: req.session.user || null,
    username: tempUsername,
    step: showStep,
    email: tempEmail,
    userAgreement,
    privacyPolicy,
    smtpConfigured,
    captchaSvg
  });
});

// 忘记密码页面
router.get('/:source/forgot-password', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  const modeInfo = getModeInfo('forgot-password', source, 'email');

  // 生成图形验证码
  const captcha = generateCaptcha();
  req.session.captchaText = captcha.text;
  req.session.captchaExpires = Date.now() + 5 * 60 * 1000;

  res.render('auth/auth-page', {
    source,
    mode: 'forgot-password',
    step: 'email',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: null,
    user: req.session.user || null,
    username: '',
    email: '',
    userAgreement: '',
    privacyPolicy: '',
    captchaSvg: captcha.data
  });
});

// 修改密码页面
router.get('/:source/change-password', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  const modeInfo = getModeInfo('change-password', source);
  res.render('auth/auth-page', {
    source,
    mode: 'change-password',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: null,
    user: req.session.user || null,
    username: '',
    step: null,
    email: '',
    userAgreement: '',
    privacyPolicy: ''
  });
});

// 修改用户名页面
router.get('/:source/change-username', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  if (!req.session.user) {
    return res.redirect('/auth/' + source + '/login');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  res.render('auth/auth-page', {
    source,
    mode: 'change-username',
    modeTitle: '修改用户名',
    modeSubtitle: '设置一个新的用户名',
    siteName,
    error: null,
    success: null,
    user: req.session.user,
    username: '',
    step: null,
    email: '',
    userAgreement: '',
    privacyPolicy: ''
  });
});

// 强制修改密码页面
router.get('/:source/force-change-password', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  if (!req.session.user) {
    return res.redirect('/auth/' + source + '/login');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);
  const modeInfo = getModeInfo('force-change-password', source);
  res.render('auth/auth-page', {
    source,
    mode: 'force-change-password',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: null,
    user: req.session.user,
    username: '',
    step: null,
    email: '',
    userAgreement: '',
    privacyPolicy: ''
  });
});

// ============================================================
// 统一认证处理 - POST
// ============================================================

// 处理登录
router.post('/:source/login', loginLimiter, loginAnomalyDetection, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const { username, password } = req.body;
  const db = req.db;
  const siteName = getSiteName(db, source);

  function renderLogin(errorMsg) {
    const modeInfo = getModeInfo('login', source);
    res.render('auth/auth-page', {
      source,
      mode: 'login',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: null,
      user: null,
      username: username || '',
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (!username || !password) {
    return renderLogin('请输入用户名和密码');
  }

  const user = queryOne(db, 'SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    // 记录登录失败日志 - 用户不存在
    try {
      logActivity(db, {
        user_id: 0,
        username: username || '未知',
        action: 'login_fail',
        target_type: 'auth',
        target_title: source === 'image-share' ? '图片分享' : '主站',
        detail: `用户 ${username} 登录失败 - 用户不存在`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderLogin('用户名或密码错误');
  }

  // 检查账号状态：disabled（含已注销）、pending
  if (user.status === 'disabled' || user.status === 0) {
    // 检查是否有 deactivated_at 字段，判断是否因注销而被禁用
    const deactivated = user.deactivated_at && user.deactivated_at !== null;
    const errorMsg = deactivated ? '该账号已注销，无法登录' : '账号已被禁用';

    // 记录登录失败日志
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'login_fail',
        target_type: 'auth',
        target_title: source === 'image-share' ? '图片分享' : '主站',
        detail: `用户 ${user.username} 登录失败 - ${deactivated ? '账号已注销' : '账号已被禁用'}`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderLogin(errorMsg);
  }
  if (user.status === 'pending') {
    // 记录登录失败日志 - 账户未激活
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'login_fail',
        target_type: 'auth',
        target_title: source === 'image-share' ? '图片分享' : '主站',
        detail: `用户 ${user.username} 登录失败 - 账户未激活`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderLogin('账户未激活或已被禁用，请联系管理员审核');
  }

  // 兼容 SHA-256 和 bcrypt（SHA-256 密码登录后自动升级为 bcrypt）
  let loginOk = false;
  let needsShaUpgrade = false;
  if (bcrypt.compareSync(password, user.password)) {
    loginOk = true;
  } else if (crypto.createHash('sha256').update(password).digest('hex') === user.password) {
    loginOk = true;
    needsShaUpgrade = true;
  }

  if (!loginOk) {
    // 记录登录失败日志 - 密码错误
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'login_fail',
        target_type: 'auth',
        target_title: source === 'image-share' ? '图片分享' : '主站',
        detail: `用户 ${user.username} 登录失败 - 密码错误`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderLogin('用户名或密码错误');
  }

  // SHA-256 密码自动升级为 bcrypt
  if (needsShaUpgrade) {
    try {
      const newHash = bcrypt.hashSync(password, 10);
      db.run('UPDATE users SET password = ? WHERE id = ?', [newHash, user.id]);
      saveDatabase();
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'password_sha',
        target_type: 'password',
        target_title: '密码升级',
        detail: `用户 ${user.username} 的 SHA-256 密码已自动升级为 bcrypt`,
        ip: req.ip
      });
    } catch (upgradeErr) {
      console.error('[auth] SHA-256密码升级失败:', upgradeErr.message);
    }
  }

  // 记录登录成功日志
  try {
    logActivity(db, {
      user_id: user.id,
      username: user.username,
      action: 'login',
      target_type: 'auth',
      target_title: source === 'image-share' ? '图片分享' : '主站',
      detail: `用户 ${user.username} 登录成功`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  req.session.user = {
    id: user.id,
    uid: user.uid || '',
    username: user.username,
    email: user.email,
    nickname: user.nickname || user.username,
    role: user.role,
    avatar: user.avatar || '/assets/images/default-avatar.png'
  };

  delete req.session.doubleSubmitToken;

  // 如果用户被标记为需要修改密码，重定向到修改密码页面
  if (user.must_change_password === 1) {
    db.run('UPDATE users SET must_change_password = 0 WHERE id = ?', [user.id]);
    saveDatabase();
    return res.redirect('/auth/' + source + '/force-change-password');
  }

  // 根据来源重定向
  if (source === 'image-share') {
    return res.redirect('/image-share');
  }

  // 登录后统一跳转至前台首页，不再默认进入后台
  // 用户仍可通过导航或直接访问 /admin 进入后台管理界面
  // 后台访问权限由 canAccessAdmin 中间件控制，无权限选项自动隐藏
  return res.redirect('/');
});

// 处理注册
router.post('/:source/register', registerLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const { username, password, email, confirm_password, agree, nickname, code } = req.body;
  const db = req.db;
  const siteName = getSiteName(db, source);

  let userAgreement = '';
  let privacyPolicy = '';
  if (source === 'frontend') {
    const agreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'user_agreement'");
    const privacy = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'privacy_policy'");
    userAgreement = agreement ? agreement.setting_value : '';
    privacyPolicy = privacy ? privacy.setting_value : '';
  }

  // 检查是否是验证码验证提交（有code字段表示是第二步）
  if (code) {
    // 验证码验证步骤
    const modeInfo = getModeInfo('register', source);

    if (!req.session.tempRegister) {
      return res.redirect('/auth/' + source + '/register');
    }

    const tempData = req.session.tempRegister;

    if (code !== tempData.verifyCode) {
      // 记录注册验证码错误日志
      try {
        logActivity(db, {
          user_id: 0,
          username: tempData.username || '匿名',
          action: 'register_verify',
          target_type: 'auth',
          target_title: '邮箱验证',
          detail: `用户 ${tempData.username} 注册邮箱验证失败 - 验证码错误 (邮箱: ${tempData.email})`,
          ip: req.ip
        });
      } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
      return res.render('auth/auth-page', {
        source,
        mode: 'register',
        modeTitle: modeInfo.title,
        modeSubtitle: modeInfo.subtitle,
        siteName,
        error: '验证码错误',
        success: null,
        user: null,
        username: tempData.username,
        step: 'verify',
        email: tempData.email,
        userAgreement,
        privacyPolicy,
        smtpConfigured: true
      });
    }

    const now = new Date();
    const expires = new Date(tempData.codeExpires);
    if (now > expires) {
      // 记录验证码过期日志
      try {
        logActivity(db, {
          user_id: 0,
          username: tempData.username || '匿名',
          action: 'register_verify',
          target_type: 'auth',
          target_title: '邮箱验证',
          detail: `用户 ${tempData.username} 注册邮箱验证失败 - 验证码已过期 (邮箱: ${tempData.email})`,
          ip: req.ip
        });
      } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
      // 验证码过期，回到信息填写页
      delete req.session.tempRegister;
      const modeInfoRegister = getModeInfo('register', source);
      return res.render('auth/auth-page', {
        source,
        mode: 'register',
        modeTitle: modeInfoRegister.title,
        modeSubtitle: modeInfoRegister.subtitle,
        siteName,
        error: '验证码已过期，请重新填写信息注册',
        success: null,
        user: null,
        username: '',
        step: 'info',
        email: '',
        userAgreement,
        privacyPolicy,
        smtpConfigured: isSmtpConfigured(db)
      });
    }

    // 验证通过，创建用户（状态为 active 自动激活）
    const hashedPassword = bcrypt.hashSync(tempData.password, 10);
    const uid1 = generateUid(db);
    db.run("INSERT INTO users (uid, username, password, email, nickname, role, status, avatar) VALUES (?, ?, ?, ?, ?, 'user', 'active', '/assets/images/default-avatar.png')",
      [uid1, tempData.username, hashedPassword, tempData.email, tempData.nickname || tempData.username]);
    saveDatabase();

    // 为新用户授予主页访问权限
    const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [tempData.username]);
    if (newUser) {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [newUser.id, 'homepage.access', newUser.id]);
      saveDatabase();
    }

    // 记录注册成功日志（SMTP验证通过）
    try {
      logActivity(db, {
        user_id: 0,
        username: tempData.username,
        action: 'register_success',
        target_type: 'auth',
        target_title: '用户注册',
        detail: `用户 ${tempData.username} 注册成功 (邮箱: ${tempData.email}) - SMTP验证激活`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

    // 清除暂存数据
    delete req.session.tempRegister;

    const modeInfoLogin = getModeInfo('login', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'login',
      modeTitle: modeInfoLogin.title,
      modeSubtitle: modeInfoLogin.subtitle,
      siteName,
      error: null,
      success: '注册成功，请登录',
      user: null,
      username: tempData.username,
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  // 以下是第一步：信息填写步骤
  function renderRegister(errorMsg, step) {
    const modeInfo = getModeInfo('register', source);
    // 每次渲染信息步骤时重新生成图形验证码
    const captcha = generateCaptcha();
    req.session.captchaText = captcha.text;
    req.session.captchaExpires = Date.now() + 5 * 60 * 1000;
    res.render('auth/auth-page', {
      source,
      mode: 'register',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: null,
      user: null,
      username: username || '',
      step: step || null,
      email: email || '',
      userAgreement,
      privacyPolicy,
      smtpConfigured: isSmtpConfigured(db),
      captchaSvg: captcha.data
    });
  }

  // 主站点需要同意用户协议
  if (source === 'frontend') {
    if (agree !== '1' && agree !== 'on') {
      return renderRegister('请阅读并同意用户协议和隐私政策', 'info');
    }
  }

  if (!username || !password || !email) {
    return renderRegister('请填写所有必填项', 'info');
  }

  if (password !== confirm_password) {
    return renderRegister('两次输入的密码不一致', 'info');
  }

  if (password.length < 6) {
    return renderRegister('密码长度不能少于6位', 'info');
  }

  if (username.length < 3 || username.length > 20) {
    return renderRegister('用户名长度应在3-20个字符之间', 'info');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return renderRegister('邮箱格式不正确', 'info');
  }

  // 邮箱域名白名单验证
  if (!isEmailAllowed(email)) {
    // 记录被拦截的邮箱域名到活动日志
    try {
      const emailDomain = email.match(/@([\w.-]+)$/);
      logActivity(db, {
        user_id: 0,
        username: username || '匿名',
        action: 'email_domain_blocked',
        target_type: 'system',
        target_title: emailDomain ? emailDomain[1] : email,
        detail: `注册时使用被拦截的邮箱: ${email}`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderRegister('不支持该邮箱域名，请使用常见邮箱（如QQ邮箱、163邮箱、谷歌邮箱等）', 'info');
  }

  // 图形验证码验证
  const { captcha } = req.body;
  const storedCaptcha = req.session.captchaText;
  const captchaExpires = req.session.captchaExpires;
  if (!storedCaptcha || !captchaExpires || Date.now() > captchaExpires || !verifyCaptcha(captcha, storedCaptcha)) {
    // 记录图形验证码失败到活动日志
    try {
      logActivity(db, {
        user_id: 0,
        username: username || '匿名',
        action: 'captcha_fail',
        target_type: 'system',
        target_title: '注册',
        detail: `用户 ${username} 图形验证码验证失败 (邮箱: ${email})`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderRegister('图形验证码错误或已过期', 'info');
  }
  // 验证通过后清除 session 中的验证码
  delete req.session.captchaText;
  delete req.session.captchaExpires;

  // 检查用户名是否已存在（包括已注销/已禁用的用户）
  const existingUser = queryOne(db, 'SELECT id, status FROM users WHERE username = ?', [username]);
  if (existingUser) {
    if (existingUser.status === 'disabled') {
      return renderRegister('该用户名已被注册且账号已注销，不可重新使用', 'info');
    }
    return renderRegister('用户名已存在', 'info');
  }

  const existingEmail = queryOne(db, 'SELECT id FROM users WHERE email = ?', [email]);
  if (existingEmail) {
    return renderRegister('邮箱已被注册', 'info');
  }

  if (source === 'image-share') {
    // 图片分享注册直接激活
    const hashedPassword = bcrypt.hashSync(password, 10);
    const uid2 = generateUid(db);
    db.run("INSERT INTO users (uid, username, password, email, nickname, role, status, avatar) VALUES (?, ?, ?, ?, ?, 'user', 'active', '/assets/images/default-avatar.png')",
      [uid2, username, hashedPassword, email, nickname || username]);
    saveDatabase();

    // 为新用户授予主页访问权限
    const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
    if (newUser) {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [newUser.id, 'homepage.access', newUser.id]);
      saveDatabase();
    }

    // 记录图片分享注册成功日志
    try {
      logActivity(db, {
        user_id: 0,
        username: username,
        action: 'register_success',
        target_type: 'auth',
        target_title: '图片分享注册',
        detail: `用户 ${username} 注册成功 (邮箱: ${email}) - 图片分享直接激活`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

    const modeInfo = getModeInfo('login', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'login',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: null,
      success: '注册成功，请登录',
      user: null,
      username: username,
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  // 主站点：检查是否配置了SMTP
  const smtpConfigured = isSmtpConfigured(db);

  if (!smtpConfigured) {
    // 未配置SMTP，回退到管理员审核模式
    const hashedPassword = bcrypt.hashSync(password, 10);
    const uid3 = generateUid(db);
    db.run('INSERT INTO users (uid, username, password, email, role, status, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uid3, username, hashedPassword, email, 'user', 'pending', '/assets/images/default-avatar.png']);
    saveDatabase();

    // 记录注册成功日志（管理员审核模式）
    try {
      logActivity(db, {
        user_id: 0,
        username: username,
        action: 'register_info',
        target_type: 'auth',
        target_title: '用户注册',
        detail: `用户 ${username} 注册成功 (邮箱: ${email}) - 待管理员审核`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

    const modeInfo = getModeInfo('login', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'login',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: null,
      success: '注册成功！请等待管理员审核后登录',
      user: null,
      username: username,
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  // 配置了SMTP，发送验证码
  const verifyCode = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // 暂存注册信息到session
  req.session.tempRegister = {
    username: username,
    email: email,
    password: password,
    nickname: nickname || username,
    verifyCode: verifyCode,
    codeExpires: expires
  };

  // 记录注册信息填写完成，发送验证码
  try {
    logActivity(db, {
      user_id: 0,
      username: username,
      action: 'register_info',
      target_type: 'auth',
      target_title: '用户注册',
      detail: `用户 ${username} 填写注册信息完成，发送验证码到 ${email}`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  sendRegisterVerifyCode(db, email, verifyCode, username, (err) => {
    if (err) {
      if (!logger.isProd) logger.debug(`[dev] 注册验证码已生成 for ${username}`);
      // 即使邮件发送失败，在开发模式下也跳转到验证步骤
      const modeInfo = getModeInfo('register', source);
      return res.render('auth/auth-page', {
        source,
        mode: 'register',
        modeTitle: modeInfo.title,
        modeSubtitle: '验证码已发送（开发模式）',
        siteName,
        error: null,
        success: '邮件发送失败，但在开发模式下验证码已输出到控制台',
        user: null,
        username: username,
        step: 'verify',
        email: email,
        userAgreement,
        privacyPolicy,
        smtpConfigured: true
      });
    }
    // 跳转到验证码步骤
    const modeInfo = getModeInfo('register', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'register',
      modeTitle: modeInfo.title,
      modeSubtitle: '请查收邮箱中的验证码',
      siteName,
      error: null,
      success: '验证码已发送到您的邮箱，请查收',
      user: null,
      username: username,
      step: 'verify',
      email: email,
      userAgreement,
      privacyPolicy,
      smtpConfigured: true
    });
  });
});

// 注册 - 重新发送验证码
router.post('/:source/register/resend-code', sendCodeLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const siteName = getSiteName(db, source);

  if (!req.session.tempRegister) {
    return res.redirect('/auth/' + source + '/register');
  }

  const tempData = req.session.tempRegister;
  const code = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // 更新验证码
  req.session.tempRegister.verifyCode = code;
  req.session.tempRegister.codeExpires = expires;

  // 记录重新发送验证码日志
  try {
    logActivity(db, {
      user_id: 0,
      username: tempData.username || '匿名',
      action: 'email_resend',
      target_type: 'email',
      target_title: '注册验证码',
      detail: `用户 ${tempData.username} 重新发送注册验证码到 ${tempData.email}`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  sendRegisterVerifyCode(db, tempData.email, code, tempData.username, (err) => {
    if (err) {
      if (!logger.isProd) logger.debug(`[dev] 重新生成验证码 for ${tempData.username}`);
    }
    const modeInfo = getModeInfo('register', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'register',
      modeTitle: modeInfo.title,
      modeSubtitle: '验证码已重新发送',
      siteName,
      error: null,
      success: '验证码已重新发送到您的邮箱，请查收',
      user: null,
      username: tempData.username,
      step: 'verify',
      email: tempData.email,
      userAgreement: '',
      privacyPolicy: '',
      smtpConfigured: true
    });
  });
});

// 忘记密码 - 发送验证码
router.post('/:source/forgot-password/send-code', sendCodeLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const { email, captcha } = req.body;
  const siteName = getSiteName(db, source);

  function renderForgotPassword(step, errorMsg, successMsg) {
    const modeInfo = getModeInfo('forgot-password', source, step);
    // 如果返回邮箱步骤，重新生成图形验证码
    let captchaSvg = '';
    if (step === 'email') {
      const newCaptcha = generateCaptcha();
      req.session.captchaText = newCaptcha.text;
      req.session.captchaExpires = Date.now() + 5 * 60 * 1000;
      captchaSvg = newCaptcha.data;
    }
    return res.render('auth/auth-page', {
      source,
      mode: 'forgot-password',
      step,
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: successMsg,
      user: req.session.user || null,
      username: '',
      email: email || '',
      userAgreement: '',
      privacyPolicy: '',
      captchaSvg
    });
  }

  if (!email) {
    return renderForgotPassword('email', '请输入邮箱地址', null);
  }

  // 图形验证码验证
  const storedCaptcha = req.session.captchaText;
  const captchaExpires = req.session.captchaExpires;
  if (!storedCaptcha || !captchaExpires || Date.now() > captchaExpires || !verifyCaptcha(captcha, storedCaptcha)) {
    // 记录图形验证码失败日志
    try {
      logActivity(db, {
        user_id: 0,
        username: '匿名',
        action: 'captcha_fail',
        target_type: 'system',
        target_title: '忘记密码',
        detail: `忘记密码时图形验证码验证失败 (邮箱: ${email})`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderForgotPassword('email', '图形验证码错误或已过期', null);
  }
  // 验证通过后清除 session 中的验证码
  delete req.session.captchaText;
  delete req.session.captchaExpires;

  const user = queryOne(db, 'SELECT id, username FROM users WHERE email = ?', [email]);
  if (!user) {
    // 记录忘记密码失败日志 - 邮箱未注册
    try {
      logActivity(db, {
        user_id: 0,
        username: '匿名',
        action: 'forgot_send_code',
        target_type: 'password',
        target_title: '忘记密码',
        detail: `忘记密码发送验证码失败 - 邮箱 ${email} 未注册`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderForgotPassword('email', '该邮箱未注册', null);
  }

  const code = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.run('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
    [code, expires, user.id]);
  saveDatabase();

  // 记录忘记密码发送验证码日志
  try {
    logActivity(db, {
      user_id: user.id,
      username: user.username,
      action: 'forgot_send_code',
      target_type: 'password',
      target_title: '忘记密码',
      detail: `用户 ${user.username} 发送密码重置验证码到 ${email}`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  sendEmailCode(db, email, code, (err) => {
    if (err) {
      if (!logger.isProd) logger.debug(`[dev] 忘记密码验证码已生成 for ${user.username}`);
      return renderForgotPassword('verify', null, '邮件发送失败，请联系管理员或稍后重试');
    }
    renderForgotPassword('verify', null, '验证码已发送到您的邮箱，请查收');
  });
});

// 忘记密码 - 验证并重置
router.post('/:source/forgot-password/reset', resetPasswordLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const { email, code, new_password, confirm_password } = req.body;
  const siteName = getSiteName(db, source);

  function renderVerify(errorMsg, successMsg) {
    const modeInfo = getModeInfo('forgot-password', source, 'verify');
    return res.render('auth/auth-page', {
      source,
      mode: 'forgot-password',
      step: 'verify',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: successMsg,
      user: req.session.user || null,
      username: '',
      email: email || '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (!email || !code || !new_password || !confirm_password) {
    return renderVerify('请填写所有字段', null);
  }

  if (new_password.length < 6) {
    return renderVerify('密码长度不能少于6位', null);
  }

  if (new_password !== confirm_password) {
    return renderVerify('两次输入的密码不一致', null);
  }

  const user = queryOne(db, 'SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    const modeInfo = getModeInfo('forgot-password', source, 'email');
    return res.render('auth/auth-page', {
      source,
      mode: 'forgot-password',
      step: 'email',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: '邮箱不存在',
      success: null,
      user: req.session.user || null,
      username: '',
      email: email || '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (user.reset_token !== code) {
    // 记录验证码错误日志
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'forgot_reset',
        target_type: 'password',
        target_title: '忘记密码',
        detail: `用户 ${user.username} 重置密码失败 - 验证码错误`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderVerify('验证码错误', null);
  }

  const now = new Date();
  const expires = new Date(user.reset_token_expires);
  if (now > expires) {
    // 记录验证码过期日志
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'forgot_reset',
        target_type: 'password',
        target_title: '忘记密码',
        detail: `用户 ${user.username} 重置密码失败 - 验证码已过期`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderVerify('验证码已过期，请重新获取', null);
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
    [hashedPassword, user.id]);
  saveDatabase();

  // 记录密码重置成功日志
  try {
    logActivity(db, {
      user_id: user.id,
      username: user.username,
      action: 'forgot_reset',
      target_type: 'password',
      target_title: '忘记密码',
      detail: `用户 ${user.username} 通过邮箱验证重置密码成功`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  const modeInfo = getModeInfo('login', source);
  res.render('auth/auth-page', {
    source,
    mode: 'login',
    modeTitle: modeInfo.title,
    modeSubtitle: modeInfo.subtitle,
    siteName,
    error: null,
    success: '密码重置成功！请使用新密码登录',
    user: null,
    username: '',
    step: null,
    email: '',
    userAgreement: '',
    privacyPolicy: ''
  });
});

// 修改密码
router.post('/:source/change-password', changePasswordLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  const db = req.db;
  const { username, current_password, new_password, confirm_password } = req.body;
  const siteName = getSiteName(db, source);

  function renderChangePassword(errorMsg, successMsg) {
    const modeInfo = getModeInfo('change-password', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'change-password',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: successMsg,
      user: req.session.user || null,
      username: '',
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (!new_password || new_password.length < 6) {
    return renderChangePassword('新密码长度不能少于6位', null);
  }

  if (new_password !== confirm_password) {
    return renderChangePassword('两次输入的新密码不一致', null);
  }

  let targetUser = null;
  if (req.session.user) {
    targetUser = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  } else {
    if (!username) {
      return renderChangePassword('请提供用户名', null);
    }
    targetUser = queryOne(db, 'SELECT * FROM users WHERE username = ?', [username]);
    if (!targetUser) {
      return renderChangePassword('用户名不存在', null);
    }
  }

  if (!bcrypt.compareSync(current_password, targetUser.password)) {
    // 记录修改密码失败日志 - 密码错误
    try {
      logActivity(db, {
        user_id: targetUser.id,
        username: targetUser.username,
        action: 'change_password',
        target_type: 'password',
        target_title: '修改密码',
        detail: `用户 ${targetUser.username} 修改密码失败 - 当前密码错误`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderChangePassword('当前密码错误', null);
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, targetUser.id]);
  saveDatabase();

  // 记录修改密码成功日志
  try {
    logActivity(db, {
      user_id: targetUser.id,
      username: targetUser.username,
      action: 'change_password',
      target_type: 'password',
      target_title: '修改密码',
      detail: `用户 ${targetUser.username} 修改密码成功`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  // 通知用户密码已修改
  try {
    createNotification(db, {
      userId: targetUser.id,
      type: 'account',
      title: '密码已修改',
      content: '您的密码已成功修改。如非本人操作，请立即联系管理员。',
      fromUserId: null,
      targetType: 'account',
      targetId: ''
    });
  } catch (notifErr) { console.error('[auth] 通知创建失败:', notifErr.message); }

  renderChangePassword(null, '密码修改成功！请使用新密码登录');
});

// 修改用户名
router.post('/:source/change-username', (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  if (!req.session.user) {
    return res.redirect('/auth/' + source + '/login');
  }
  const db = req.db;
  const { new_username, password } = req.body;
  const siteName = getSiteName(db, source);

  function renderChangeUsername(errorMsg, successMsg) {
    return res.render('auth/auth-page', {
      source,
      mode: 'change-username',
      modeTitle: '修改用户名',
      modeSubtitle: '设置一个新的用户名',
      siteName,
      error: errorMsg,
      success: successMsg,
      user: req.session.user,
      username: new_username || '',
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (!new_username || !password) {
    return renderChangeUsername('请填写所有字段', null);
  }

  if (new_username.length < 3 || new_username.length > 20) {
    return renderChangeUsername('用户名长度应在3-20个字符之间', null);
  }

  // 检查用户名是否包含非法字符（只允许字母、数字、下划线、中文）
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(new_username)) {
    return renderChangeUsername('用户名只能包含中文、字母、数字和下划线', null);
  }

  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!user) {
    return renderChangeUsername('用户不存在', null);
  }

  // 验证密码
  if (!bcrypt.compareSync(password, user.password)) {
    // 记录修改用户名失败日志
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'change_username',
        target_type: 'profile',
        target_title: '修改用户名',
        detail: `用户 ${user.username} 修改用户名失败 - 密码错误`,
        ip: req.ip
      });
    } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
    return renderChangeUsername('密码错误', null);
  }

  // 检查新用户名是否已被使用
  const existingUser = queryOne(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [new_username, user.id]);
  if (existingUser) {
    return renderChangeUsername('该用户名已被使用', null);
  }

  // 更新用户名
  db.run('UPDATE users SET username = ? WHERE id = ?', [new_username, user.id]);
  saveDatabase();

  // 更新 session 中的用户名
  req.session.user.username = new_username;

  // 记录修改用户名成功日志
  try {
    logActivity(db, {
      user_id: user.id,
      username: new_username,
      action: 'change_username',
      target_type: 'profile',
      target_title: '修改用户名',
      detail: `用户 ${user.username} 修改用户名为 ${new_username}`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  renderChangeUsername(null, '用户名修改成功！');
});

// 强制修改密码
router.post('/:source/force-change-password', changePasswordLimiter, (req, res) => {
  const { source } = req.params;
  if (!['frontend', 'image-share'].includes(source)) {
    return res.redirect('/');
  }
  if (!req.session.user) {
    return res.redirect('/auth/' + source + '/login');
  }
  const db = req.db;
  const { new_password, confirm_password } = req.body;
  const siteName = getSiteName(db, source);

  function renderForceChange(errorMsg) {
    const modeInfo = getModeInfo('force-change-password', source);
    return res.render('auth/auth-page', {
      source,
      mode: 'force-change-password',
      modeTitle: modeInfo.title,
      modeSubtitle: modeInfo.subtitle,
      siteName,
      error: errorMsg,
      success: null,
      user: req.session.user,
      username: '',
      step: null,
      email: '',
      userAgreement: '',
      privacyPolicy: ''
    });
  }

  if (!new_password || !confirm_password) {
    return renderForceChange('请填写所有字段');
  }

  if (new_password.length < 6) {
    return renderForceChange('密码长度不能少于6位');
  }

  if (new_password !== confirm_password) {
    return renderForceChange('两次输入的密码不一致');
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?',
    [hashedPassword, req.session.user.id]);
  saveDatabase();

  // 记录强制修改密码成功日志
  try {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'force_change_password',
      target_type: 'password',
      target_title: '强制修改密码',
      detail: `用户 ${req.session.user.username} 完成强制修改密码`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  // 根据来源重定向
  if (source === 'image-share') {
    return res.redirect('/image-share');
  }
  return res.redirect('/');
});

// ============================================================
// 管理员重置用户密码
// ============================================================

router.post('/admin-reset-password/:userId', resetPasswordLimiter, (req, res) => {
  if (!req.session.user || (req.session.user.role !== 'admin' && req.session.user.role !== 'super_admin')) {
    return res.status(403).json({ error: '权限不足' });
  }

  const db = req.db;
  const userId = req.params.userId;

  if (parseInt(userId) === req.session.user.id) {
    return res.status(400).json({ error: '不能重置自己的密码，请使用修改密码功能' });
  }

  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // === 角色层次检查：admin不能重置super_admin的密码 ===
  const currentUserRole = ROLE_HIERARCHY[req.session.user.role] || 0;
  const targetUserRole = ROLE_HIERARCHY[user.role] || 0;
  if (targetUserRole >= currentUserRole && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足：不能操作同级别或更高级别的用户' });
  }


  const newPassword = crypto.randomBytes(4).toString('hex');
  const hashedPassword = bcrypt.hashSync(newPassword, 10);

  db.run('UPDATE users SET password = ?, must_change_password = 1, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
    [hashedPassword, userId]);
  saveDatabase();

  // 记录管理员重置密码日志
  try {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'change_password',
      target_type: 'password',
      target_title: '管理员重置密码',
      detail: `管理员 ${req.session.user.username} 重置了用户 ${user.username} 的密码`,
      ip: req.ip
    });
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }

  res.json({
    success: true,
    message: '密码已重置',
    newPassword: newPassword,
    username: user.username
  });
});


// ============================================================
// 图形验证码
// ============================================================

// 生成图形验证码（SVG格式）
router.get('/captcha', (req, res) => {
  const captcha = generateCaptcha();

  // 将验证码文本存入 session，有效期5分钟
  req.session.captchaText = captcha.text;
  req.session.captchaExpires = Date.now() + 5 * 60 * 1000;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(captcha.data);
});

// 获取图形验证码（JSON格式，包含base64编码的SVG）
router.get('/captcha/json', (req, res) => {
  const captcha = generateCaptcha();

  // 将验证码文本存入 session，有效期5分钟
  req.session.captchaText = captcha.text;
  req.session.captchaExpires = Date.now() + 5 * 60 * 1000;

  const svgBase64 = Buffer.from(captcha.data).toString('base64');
  res.json({
    svg: `data:image/svg+xml;base64,${svgBase64}`,
    expires: req.session.captchaExpires
  });
});

// ============================================================
// 登出
// ============================================================

router.get('/logout', (req, res) => {
  // 记录登出日志
  try {
    if (req.session.user) {
      const db = req.db;
      if (db) {
        logActivity(db, {
          user_id: req.session.user.id,
          username: req.session.user.username,
          action: 'logout',
          target_type: 'auth',
          target_title: '用户登出',
          detail: `用户 ${req.session.user.username} 登出系统`,
          ip: req.ip
        });
      }
    }
  } catch (logErr) { console.error('[auth] logActivity 错误:', logErr.message); }
  
  const redirectUrl = req.session.user?.role === 'super_admin' || req.session.user?.role === 'admin'
    ? '/auth/frontend/login'
    : '/';
  
  req.session.destroy(() => {
    res.redirect(redirectUrl);
  });
});

// ============================================================
// 注销账号
// ============================================================

// 注销账号页面
router.get('/delete-account', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = req.db;
  const user = req.session.user;

  const deleteAccountAgreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'delete_account_agreement'");
  const agreementContent = deleteAccountAgreement ? deleteAccountAgreement.setting_value : '';

  // 检查是否有邮箱验证token
  const token = req.query.token;
  let tokenValid = false;
  if (token) {
    const row = queryOne(db, 'SELECT * FROM users WHERE id = ? AND delete_token = ?', [user.id, token]);
    if (row) {
      const now = new Date();
      const expires = new Date(row.delete_token_expires);
      if (now <= expires) {
        tokenValid = true;
      }
    }
  }

  // 获取当前步骤
  const step = req.query.step || (tokenValid ? 'verify' : 'confirm');
  const smtpConfigured = isSmtpConfigured(db);
  const userHasEmail = user.email && user.email.trim() !== '';

  res.render('frontend/delete-account', {
    user: user,
    settings: res.locals.settings || {},
    error: null,
    success: null,
    step: step,
    agreementContent: agreementContent,
    smtpConfigured: smtpConfigured,
    userHasEmail: userHasEmail
  });
});

// 注销账号 - 发送邮箱验证码
router.post('/delete-account/send-code', sendCodeLimiter, (req, res) => {
  if (!req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = req.db;
  const user = req.session.user;

  if (user.role === 'super_admin') {
    return res.render('frontend/delete-account', {
      user: user,
      settings: res.locals.settings || {},
      error: '超级管理员账户不可注销。如需注销，请先将角色变更为普通管理员后再操作。',
      success: null,
      step: 'confirm',
      agreementContent: '',
      smtpConfigured: false,
      userHasEmail: false
    });
  }

  const code = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.run('UPDATE users SET delete_token = ?, delete_token_expires = ? WHERE id = ?',
    [code, expires, user.id]);
  saveDatabase();

  const deleteAccountAgreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'delete_account_agreement'");
  const agreementContent = deleteAccountAgreement ? deleteAccountAgreement.setting_value : '';

  const { sendMail, buildDeleteAccountEmail } = require('../config/mailer');
  const siteName = res.locals.settings.site_name || '本站';
  const siteUrl = process.env.SITE_URL || `http://${req.headers.host}`;

  sendMail(db, {
    to: user.email,
    subject: `【${siteName}】账号注销确认`,
    html: buildDeleteAccountEmail(code, user.username, siteUrl)
  })
    .then(() => {
      res.render('frontend/delete-account', {
        user: user,
        settings: res.locals.settings || {},
        error: null,
        success: '验证码已发送到您的邮箱，请查收',
        step: 'verify',
        agreementContent: agreementContent,
        smtpConfigured: true,
        userHasEmail: true
      });
    })
    .catch((err) => {
      res.render('frontend/delete-account', {
        user: user,
        settings: res.locals.settings || {},
        error: null,
        success: '邮件发送失败，但验证码已生成，请查看控制台',
        step: 'verify',
        agreementContent: agreementContent,
        smtpConfigured: true,
        userHasEmail: true
      });
      if (!logger.isProd) logger.debug(`[dev] 注销验证码 for ${user.username}: ${code}`);
    });
});

// 注销账号处理
router.post('/delete-account', (req, res) => {
  const db = req.db;
  const user = req.session.user;

  if (!user) {
    return res.redirect('/auth/frontend/login');
  }

  const deleteAccountAgreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'delete_account_agreement'");
  const agreementContent = deleteAccountAgreement ? deleteAccountAgreement.setting_value : '';

  const smtpConfigured = isSmtpConfigured(db);
  const userHasEmail = user.email && user.email.trim() !== '';

  function renderDelete(errorMsg, successMsg, step) {
    return res.render('frontend/delete-account', {
      user: user,
      settings: res.locals.settings || {},
      error: errorMsg,
      success: successMsg,
      step: step || 'confirm',
      agreementContent: agreementContent,
      smtpConfigured: smtpConfigured,
      userHasEmail: userHasEmail
    });
  }

  // 超级管理员不可注销
  if (user.role === 'super_admin') {
    return renderDelete('超级管理员账户不可注销。如需注销，请先将角色变更为普通管理员后再操作。', null, 'confirm');
  }

  const { password, confirm, agree, code } = req.body;

  // 如果有验证码，说明是邮箱验证步骤
  if (code) {
    const row = queryOne(db, 'SELECT * FROM users WHERE id = ?', [user.id]);
    if (!row) {
      return renderDelete('用户不存在', null, 'confirm');
    }

    if (row.delete_token !== code) {
      return renderDelete('验证码错误，请重新输入', null, 'verify');
    }

    const now = new Date();
    const expires = new Date(row.delete_token_expires);
    if (now > expires) {
      return renderDelete('验证码已过期，请重新获取', null, 'confirm');
    }

    // 验证通过，执行逻辑注销（禁用账号）
    return performDeleteAccount(db, user, req, res, agreementContent, smtpConfigured, userHasEmail);
  }

  // 第一步：确认身份
  if (confirm !== '我已知晓风险，确认注销账号') {
    return renderDelete('请输入正确的确认文字', null, 'confirm');
  }

  // 检查是否同意注销协议
  if (agreementContent && agree !== '1' && agree !== 'on') {
    return renderDelete('请阅读并同意账户注销协议', null, 'confirm');
  }

  const row = queryOne(db, 'SELECT password FROM users WHERE id = ?', [user.id]);
  if (!row) {
    return renderDelete('用户不存在', null, 'confirm');
  }

  if (!bcrypt.compareSync(password, row.password)) {
    return renderDelete('密码错误', null, 'confirm');
  }

  // 如果配置了SMTP且用户有邮箱，发送验证码进入第二步
  if (smtpConfigured && userHasEmail) {
    const verifyCode = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.run('UPDATE users SET delete_token = ?, delete_token_expires = ? WHERE id = ?',
      [verifyCode, expires, user.id]);
    saveDatabase();

    const { sendMail, buildDeleteAccountEmail } = require('../config/mailer');
    const siteName = res.locals.settings.site_name || '本站';
    const siteUrl = process.env.SITE_URL || `http://${req.headers.host}`;

    sendMail(db, {
      to: user.email,
      subject: `【${siteName}】账号注销确认`,
      html: buildDeleteAccountEmail(verifyCode, user.username, siteUrl)
    })
      .then(() => {
        return renderDelete(null, '验证码已发送到您的邮箱，请查收邮件并输入验证码完成注销', 'verify');
      })
      .catch((err) => {
        if (!logger.isProd) logger.debug(`[dev] 注销验证码 for ${user.username}: ${verifyCode}`);
        return renderDelete(null, '邮件发送失败，但验证码已生成，请查看控制台', 'verify');
      });
  } else {
    // 未配置SMTP或用户无邮箱，直接执行逻辑注销
    return performDeleteAccount(db, user, req, res, agreementContent, smtpConfigured, userHasEmail);
  }
});

// 辅助函数：执行账户注销（逻辑删除：禁用账号而非物理删除）
function performDeleteAccount(db, user, req, res, agreementContent, smtpConfigured, userHasEmail) {
  try {
    const uid = user.id;

    // 改为禁用账号而非物理删除，保留用户所有数据
    db.run("UPDATE users SET status = 'disabled', deactivated_at = CURRENT_TIMESTAMP, delete_token = NULL, delete_token_expires = NULL WHERE id = ?", [uid]);
    saveDatabase();

    logActivity(db, {
      user_id: uid,
      username: user.username,
      action: 'delete_account',
      target_type: 'user_account',
      target_title: user.username,
      detail: `用户 ${user.username} 自行注销了账号（账号已禁用，数据保留）`,
      ip: req.ip
    });

    // 发送注销成功通知邮件（异步发送，不阻塞流程）
    if (smtpConfigured && userHasEmail) {
      try {
        const { sendMail, buildAccountDeactivatedEmail } = require('../config/mailer');
        const siteName = res.locals.settings?.site_name || '本站';
        sendMail(db, {
          to: user.email,
          subject: `【${siteName}】账号已成功注销`,
          html: buildAccountDeactivatedEmail(user.username, siteName)
        }).catch(err => {
          console.error('[auth] 注销通知邮件发送失败:', err.message);
        });
      } catch (mailErr) {
        console.error('[auth] 邮件模块加载失败:', mailErr.message);
      }
    }

    // 销毁会话并显示注销成功页面
    req.session.destroy((err) => {
      if (err) {
        console.error('[auth] session.destroy 失败:', err.message);
      }
      return res.render('frontend/delete-account-success', {
        user: user,
        settings: res.locals.settings || {},
        siteName: res.locals.settings?.site_name || '本站'
      });
    });

  } catch (err) {
    console.error('[auth] performDeleteAccount 错误:', err.message);
    return res.render('frontend/delete-account', {
      user: user,
      settings: res.locals.settings || {},
      error: '注销失败，请稍后重试',
      success: null,
      step: 'confirm',
      agreementContent: agreementContent,
      smtpConfigured: smtpConfigured,
      userHasEmail: userHasEmail
    });
  }
}

// ============================================================
// 双因素认证 (2FA/TOTP)
// ============================================================
const { generateSecret, generateTOTPUri, verifyTOTP } = require('../services/two-factor-auth');

// 获取 2FA 状态
router.get('/2fa/status', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const db = req.db;
  const user = queryOne(db, 'SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
  res.json({
    enabled: user ? !!user.totp_enabled : false,
    hasSecret: user ? !!user.totp_secret : false
  });
});

// 生成 2FA 密钥 (开启第一步)
router.post('/2fa/setup', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const db = req.db;
  const secret = generateSecret();
  const uri = generateTOTPUri(secret, req.session.user.username, res.locals.settings?.site_name || 'MyWebsite');

  // 临时保存密钥，待验证后正式启用
  req.session.pendingTotpSecret = secret;

  res.json({
    secret: secret,
    uri: uri,
    qrcode: uri  // 前端可用此生成二维码
  });
});

// 验证并启用 2FA
router.post('/2fa/verify', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const { token } = req.body;
  const secret = req.session.pendingTotpSecret;

  if (!token) {
    return res.status(400).json({ error: '请输入验证码' });
  }
  if (!secret) {
    return res.status(400).json({ error: '请先获取密钥' });
  }

  if (!verifyTOTP(token, secret)) {
    return res.status(400).json({ error: '验证码无效，请重试' });
  }

  const db = req.db;
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [secret, req.session.user.id]);
  saveDatabase();

  delete req.session.pendingTotpSecret;

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'enable_2fa',
    target_type: 'auth',
    detail: '用户启用了双因素认证',
    ip: req.ip
  });

  res.json({ success: true, message: '双因素认证已启用' });
});

// 关闭 2FA
router.post('/2fa/disable', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const { token } = req.body;
  const db = req.db;
  const user = queryOne(db, 'SELECT totp_secret FROM users WHERE id = ?', [req.session.user.id]);

  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: '双因素认证未启用' });
  }

  if (!token || !verifyTOTP(token, user.totp_secret)) {
    return res.status(400).json({ error: '验证码无效' });
  }

  db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [req.session.user.id]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'disable_2fa',
    target_type: 'auth',
    detail: '用户关闭了双因素认证',
    ip: req.ip
  });

  res.json({ success: true, message: '双因素认证已关闭' });
});

// ============================================================
// 登录异常检测中间件
// ============================================================
function loginAnomalyDetection(req, res, next) {
  const db = req.db;
  const ip = req.ip;
  const username = req.body?.username;

  // 检查该 IP 最近失败的登录次数
  const recentFails = queryOne(db,
    "SELECT COUNT(*) as count FROM activity_logs WHERE ip = ? AND action = 'login_fail' AND created_at >= datetime('now', '-1 hour')",
    [ip]
  )?.count || 0;

  // 检查该用户名最近失败的登录次数
  let userFails = 0;
  if (username) {
    userFails = queryOne(db,
      "SELECT COUNT(*) as count FROM activity_logs WHERE username = ? AND action = 'login_fail' AND created_at >= datetime('now', '-1 hour')",
      [username]
    )?.count || 0;
  }

  // 异常检测规则
  const anomalies = [];

  if (recentFails >= 10) {
    anomalies.push(`IP ${ip} 一小时内登录失败 ${recentFails} 次`);
  }
  if (userFails >= 5) {
    anomalies.push(`用户 ${username} 一小时内登录失败 ${userFails} 次`);
  }

  if (anomalies.length > 0) {
    // 记录异常
    try {
      logActivity(db, {
        user_id: 0,
        username: username || '未知',
        action: 'login_anomaly',
        target_type: 'auth',
        detail: '登录异常检测: ' + anomalies.join('; '),
        ip: ip
      });
    } catch (e) { /* ignore */ }

    // 如果失败次数过多，添加额外延迟
    if (recentFails >= 20) {
      return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
    }
  }

  next();
}

// 获取登录异常报告 (管理员)
router.get('/admin/login-anomalies', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足' });
  }
  const db = req.db;

  // 最近24小时的登录异常
  const anomalies = queryAll(db,
    `SELECT * FROM activity_logs
     WHERE action = 'login_anomaly'
     AND created_at >= datetime('now', '-1 day')
     ORDER BY created_at DESC
     LIMIT 50`
  ) || [];

  // 登录失败最多的 IP
  const topIps = queryAll(db,
    `SELECT ip, COUNT(*) as count, MAX(created_at) as last_attempt
     FROM activity_logs
     WHERE action = 'login_fail'
     AND created_at >= datetime('now', '-24 hours')
     GROUP BY ip
     HAVING count >= 5
     ORDER BY count DESC
     LIMIT 20`
  ) || [];

  res.json({ anomalies, topIps });
});

module.exports = router;
