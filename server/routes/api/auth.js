const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, getDb, generateUid } = require('../../config/database');
const { issueToken, revokeToken } = require('../../config/tokens');
const { apiAuth } = require('../../middlewares/api-auth');
const { generateCaptcha } = require('../../config/captcha');
const { loginLimiter } = require('../../middlewares/rate-limiter');
const { verifyTOTP } = require('../../services/two-factor-auth');

const router = express.Router();

// 图形验证码（内存存储，5分钟过期，用后即焚，上限10000条防OOM）
const captchaStore = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
const MAX_CAPTCHA_STORE = 10000;

// 2FA 登录挑战（密码已验证、待 TOTP 二次确认，5分钟过期）
const totpChallengeStore = new Map();
const TOTP_CHALLENGE_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, record] of captchaStore.entries()) {
    if (record.expires < now) captchaStore.delete(id);
  }
  for (const [id, record] of totpChallengeStore.entries()) {
    if (record.expires < now) totpChallengeStore.delete(id);
  }
}, 10 * 60 * 1000);

function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    uid: u.uid,
    username: u.username,
    nickname: u.nickname || '',
    avatar: u.avatar || '/assets/images/default-avatar.png',
    role: u.role,
    status: u.status,
    email: u.email || '',
    bio: u.bio || '',
    created_at: u.created_at,
  };
}

// ============ 图形验证码 ============
router.get('/captcha', (req, res) => {
  const captcha = generateCaptcha();
  const id = crypto.randomBytes(8).toString('hex');
  // 超出上限时清理最旧条目防止 OOM
  if (captchaStore.size >= MAX_CAPTCHA_STORE) {
    const oldest = captchaStore.keys().next().value;
    captchaStore.delete(oldest);
  }
  captchaStore.set(id, { text: captcha.text, expires: Date.now() + CAPTCHA_TTL });
  res.json({ captcha_id: id, svg: captcha.data });
});

// ============ 用户协议与隐私政策（登录/注册弹窗使用） ============
router.get('/agreements', (req, res) => {
  const db = getDb();
  const agreement = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'user_agreement'");
  const privacy = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'privacy_policy'");
  res.json({
    user_agreement: agreement ? agreement.setting_value : '',
    privacy_policy: privacy ? privacy.setting_value : ''
  });
});

// ============ 注册 ============
router.post('/register', (req, res) => {
  const db = getDb();
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const nickname = (req.body.nickname || '').trim();
  const email = (req.body.email || '').trim();
  const captchaId = (req.body.captcha_id || '').toString();
  const captchaInput = (req.body.captcha || '').toString();

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
    return res.status(400).json({ error: '用户名格式不正确（2-20位，仅限字母数字下划线中文）' });
  }
  if (password.length < 8 || password.length > 64) {
    return res.status(400).json({ error: '密码长度需在 8-64 位之间' });
  }

  // 图形验证码校验
  const stored = captchaId ? captchaStore.get(captchaId) : null;
  if (!stored || stored.expires < Date.now() || stored.text.toLowerCase() !== captchaInput.trim().toLowerCase()) {
    if (captchaId) captchaStore.delete(captchaId);
    return res.status(400).json({ error: '图形验证码错误或已过期' });
  }
  captchaStore.delete(captchaId);

  const existing = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    return res.status(400).json({ error: '用户名已被占用' });
  }
  if (email) {
    const emailUser = queryOne(db, 'SELECT id FROM users WHERE email = ?', [email]);
    if (emailUser) {
      return res.status(400).json({ error: '邮箱已被使用' });
    }
  }

  const hashed = bcrypt.hashSync(password, 10);
  const uid = generateUid(db);
  db.run(
    "INSERT INTO users (uid, username, password, email, nickname, role, status, avatar, bio) VALUES (?, ?, ?, ?, ?, 'user', 'active', '/assets/images/default-avatar.png', '')",
    [uid, username, hashed, email, nickname || username]
  );

  res.json({ success: true, message: '注册成功' });
});

// ============ 登录 ============
router.post('/login', loginLimiter, (req, res) => {
  const db = getDb();
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const captchaId = (req.body.captcha_id || '').toString();
  const captchaInput = (req.body.captcha || '').toString();
  const challengeId = (req.body.totp_challenge || '').toString();
  const totpCode = (req.body.totp_code || '').toString();

  // 2FA 第二步：凭挑战直接换 token（密码与验证码已在第一步通过）
  if (challengeId) {
    const challenge = totpChallengeStore.get(challengeId);
    if (!challenge || challenge.expires < Date.now()) {
      if (challengeId) totpChallengeStore.delete(challengeId);
      return res.status(400).json({ error: '两步验证会话已过期，请重新登录' });
    }
    const u = queryOne(db, 'SELECT * FROM users WHERE id = ?', [challenge.userId]);
    if (!u || u.status !== 'active') {
      return res.status(401).json({ error: '账号不可用' });
    }
    if (!totpCode || !verifyTOTP(totpCode, u.totp_secret)) {
      return res.status(400).json({ error: '两步验证码错误' });
    }
    totpChallengeStore.delete(challengeId);
    const token = issueToken(db, u.id);
    return res.json({ token, user: sanitizeUser(u) });
  }

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  // 图形验证码校验
  const stored = captchaId ? captchaStore.get(captchaId) : null;
  if (!stored || stored.expires < Date.now() || stored.text.toLowerCase() !== captchaInput.trim().toLowerCase()) {
    if (captchaId) captchaStore.delete(captchaId);
    return res.status(400).json({ error: '图形验证码错误或已过期' });
  }
  captchaStore.delete(captchaId);

  const user = queryOne(db, 'SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
  if (!user || (user.status !== 'active')) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  // 密码校验（bcrypt，兼容 SHA-256 旧密码并自动升级）
  let loginOk = false;
  let needsShaUpgrade = false;
  if (bcrypt.compareSync(password, user.password)) {
    loginOk = true;
  } else if (user.password && user.password.length === 64 && /^[a-f0-9]{64}$/.test(user.password)) {
    const shaHash = crypto.createHash('sha256').update(password).digest('hex');
    if (shaHash === user.password) {
      loginOk = true;
      needsShaUpgrade = true;
    }
  }
  if (!loginOk) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  if (needsShaUpgrade) {
    db.run('UPDATE users SET password = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?',
      [bcrypt.hashSync(password, 10), user.id]);
  }

  // 2FA：开启两步验证后签发挑战，客户端携 totp_challenge + totp_code 二次提交
  if (user.totp_enabled === 1) {
    const newChallengeId = crypto.randomBytes(8).toString('hex');
    if (totpChallengeStore.size >= MAX_CAPTCHA_STORE) {
      const oldest = totpChallengeStore.keys().next().value;
      totpChallengeStore.delete(oldest);
    }
    totpChallengeStore.set(newChallengeId, { userId: user.id, expires: Date.now() + TOTP_CHALLENGE_TTL });
    return res.json({ requires_totp: true, totp_challenge: newChallengeId });
  }

  const token = issueToken(db, user.id);
  return res.json({ token, user: sanitizeUser(user) });
});

// ============ 当前用户 ============
router.get('/me', apiAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.apiUser) });
});

// ============ 登出 ============
router.post('/logout', apiAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  revokeToken(getDb(), token);
  res.json({ success: true });
});

// ============ 更新资料 ============
router.put('/profile', apiAuth, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;
  const nickname = (req.body.nickname !== undefined ? String(req.body.nickname).trim() : req.apiUser.nickname);
  const bio = (req.body.bio !== undefined ? String(req.body.bio).trim() : req.apiUser.bio);
  let avatar = (req.body.avatar !== undefined ? String(req.body.avatar).trim() : req.apiUser.avatar);

  if (nickname.length > 30) {
    return res.status(400).json({ error: '昵称不能超过30个字符' });
  }
  if (bio.length > 200) {
    return res.status(400).json({ error: '简介不能超过200个字符' });
  }

  // 校验 avatar 路径：必须是合法的 uploads 路径或默认头像
  if (req.body.avatar !== undefined) {
    if (avatar && !avatar.startsWith('/assets/') && !avatar.startsWith('/uploads/avatars/')) {
      return res.status(400).json({ error: '非法的头像路径' });
    }
    if (avatar && avatar.includes('..')) {
      return res.status(400).json({ error: '非法的头像路径' });
    }
  }

  db.run('UPDATE users SET nickname = ?, bio = ?, avatar = ? WHERE id = ?', [nickname, bio, avatar, userId]);
  const updated = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
  res.json({ user: sanitizeUser(updated) });
});

// ============ 修改密码 ============
router.put('/password', apiAuth, (req, res) => {
  const db = getDb();
  const oldPassword = req.body.old_password || '';
  const newPassword = req.body.new_password || '';

  if (newPassword.length < 8 || newPassword.length > 64) {
    return res.status(400).json({ error: '新密码长度需在 8-64 位之间' });
  }
  if (!bcrypt.compareSync(oldPassword, req.apiUser.password)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }

  const hashed = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?', [hashed, req.apiUser.id]);
  res.json({ success: true, message: '密码已修改' });
});

module.exports = router;
