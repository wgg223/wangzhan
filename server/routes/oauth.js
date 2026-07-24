const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { queryOne, queryAll, generateUid, saveDatabase } = require('../config/database');
const { logActivity } = require('../config/activity');

// OAuth 配置
const OAUTH_CONFIGS = {
  github: {
    name: 'GitHub',
    icon: 'fab fa-github',
    color: '#333',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userApi: 'https://api.github.com/user',
    scope: 'read:user user:email'
  },
  wechat: {
    name: '微信',
    icon: 'fab fa-weixin',
    color: '#07C160',
    authUrl: 'https://open.weixin.qq.com/connect/qrconnect',
    tokenUrl: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    userApi: 'https://api.weixin.qq.com/sns/userinfo',
    scope: 'snsapi_login'
  },
  qq: {
    name: 'QQ',
    icon: 'fab fa-qq',
    color: '#12B7F5',
    authUrl: 'https://graph.qq.com/oauth2.0/authorize',
    tokenUrl: 'https://graph.qq.com/oauth2.0/token',
    userApi: 'https://graph.qq.com/user/get_user_info',
    scope: 'get_user_info'
  },
  weibo: {
    name: '微博',
    icon: 'fab fa-weibo',
    color: '#E6162D',
    authUrl: 'https://api.weibo.com/oauth2/authorize',
    tokenUrl: 'https://api.weibo.com/oauth2/access_token',
    userApi: 'https://api.weibo.com/2/users/show.json',
    scope: 'all'
  },
  google: {
    name: 'Google',
    icon: 'fab fa-google',
    color: '#4285F4',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userApi: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile'
  },
};

// 获取启用的第三方登录配置
function getEnabledProviders(db) {
  try {
    const providers = queryAll(db, 'SELECT * FROM oauth_providers WHERE is_enabled = 1 ORDER BY sort_order ASC');
    return providers.map(p => ({
      ...p,
      ...OAUTH_CONFIGS[p.provider],
      provider: p.provider,
      display_name: p.display_name || OAUTH_CONFIGS[p.provider]?.name || p.provider
    }));
  } catch (e) {
    return [];
  }
}

// 初始化默认OAuth提供商配置
function initDefaultProviders(db) {
  const defaultProviders = [
    { provider: 'github', display_name: 'GitHub', icon: 'fab fa-github', color: '#333', sort_order: 1 },
    { provider: 'wechat', display_name: '微信', icon: 'fab fa-weixin', color: '#07C160', sort_order: 2 },
    { provider: 'qq', display_name: 'QQ', icon: 'fab fa-qq', color: '#12B7F5', sort_order: 3 },
    { provider: 'weibo', display_name: '微博', icon: 'fab fa-weibo', color: '#E6162D', sort_order: 4 },
    { provider: 'google', display_name: 'Google', icon: 'fab fa-google', color: '#4285F4', sort_order: 5 }
  ];

  defaultProviders.forEach(p => {
    try {
      db.run(`INSERT OR IGNORE INTO oauth_providers (provider, display_name, icon, color, is_enabled, sort_order) 
              VALUES (?, ?, ?, ?, 0, ?)`, [p.provider, p.display_name, p.icon, p.color, p.sort_order]);
    } catch (e) { /* 忽略已存在 */ }
  });
  saveDatabase();
}

// 生成state参数防止CSRF
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// 获取OAuth授权URL
function getAuthUrl(provider, config, state, redirectUri) {
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: redirectUri,
    state: state
  });

  switch (provider) {
    case 'github':
      params.append('scope', OAUTH_CONFIGS.github.scope);
      return `${OAUTH_CONFIGS.github.authUrl}?${params.toString()}`;

    case 'wechat':
      params.append('scope', OAUTH_CONFIGS.wechat.scope);
      params.append('response_type', 'code');
      return `${OAUTH_CONFIGS.wechat.authUrl}?${params.toString()}#wechat_redirect`;

    case 'qq':
      params.append('scope', OAUTH_CONFIGS.qq.scope);
      params.append('response_type', 'code');
      return `${OAUTH_CONFIGS.qq.authUrl}?${params.toString()}`;

    case 'weibo':
      params.append('scope', OAUTH_CONFIGS.weibo.scope);
      params.append('response_type', 'code');
      return `${OAUTH_CONFIGS.weibo.authUrl}?${params.toString()}`;

    case 'google':
      params.append('scope', OAUTH_CONFIGS.google.scope);
      params.append('response_type', 'code');
      params.append('access_type', 'offline');
      return `${OAUTH_CONFIGS.google.authUrl}?${params.toString()}`;

    default:
      return null;
  }
}

// 获取access_token
async function getAccessToken(provider, config, code, redirectUri) {
  const axios = require('axios');

  try {
    switch (provider) {
      case 'github': {
        const response = await axios.post(OAUTH_CONFIGS.github.tokenUrl, {
          client_id: config.client_id,
          client_secret: config.client_secret,
          code: code,
          redirect_uri: redirectUri
        }, { headers: { Accept: 'application/json' } });
        return response.data.access_token;
      }

      case 'wechat': {
        const url = `${OAUTH_CONFIGS.wechat.tokenUrl}?appid=${config.client_id}&secret=${config.client_secret}&code=${code}&grant_type=authorization_code`;
        const response = await axios.get(url);
        return response.data.access_token;
      }

      case 'qq': {
        const url = `${OAUTH_CONFIGS.qq.tokenUrl}?client_id=${config.client_id}&client_secret=${config.client_secret}&code=${code}&redirect_uri=${redirectUri}&grant_type=authorization_code&fmt=json`;
        const response = await axios.get(url);
        return response.data.access_token;
      }

      case 'weibo': {
        const response = await axios.post(OAUTH_CONFIGS.weibo.tokenUrl, {
          client_id: config.client_id,
          client_secret: config.client_secret,
          code: code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        });
        return response.data.access_token;
      }

      case 'google': {
        const response = await axios.post(OAUTH_CONFIGS.google.tokenUrl, {
          client_id: config.client_id,
          client_secret: config.client_secret,
          code: code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        });
        return response.data.access_token;
      }

      default:
        return null;
    }
  } catch (error) {
    console.error(`[OAuth] 获取 ${provider} access_token 失败:`, error.message);
    return null;
  }
}

// 获取用户信息
async function getUserInfo(provider, config, accessToken) {
  const axios = require('axios');

  try {
    switch (provider) {
      case 'github': {
        const response = await axios.get(OAUTH_CONFIGS.github.userApi, {
          headers: { Authorization: `token ${accessToken}`, 'User-Agent': 'NodeApp' }
        });
        const data = response.data;
        return {
          open_id: String(data.id),
          nickname: data.name || data.login,
          avatar: data.avatar_url,
          email: data.email
        };
      }

      case 'wechat': {
        const url = `${OAUTH_CONFIGS.wechat.userApi}?access_token=${accessToken}&openid=${config.client_id}&lang=zh_CN`;
        const response = await axios.get(url);
        const data = response.data;
        return {
          open_id: data.openid,
          nickname: data.nickname,
          avatar: data.headimgurl,
          email: null
        };
      }

      case 'qq': {
        // QQ需要先获取openid
        const openidUrl = `https://graph.qq.com/oauth2.0/me?access_token=${accessToken}&fmt=json`;
        const openidResponse = await axios.get(openidUrl);
        const openid = openidResponse.data.openid;

        const userInfoUrl = `${OAUTH_CONFIGS.qq.userApi}?access_token=${accessToken}&openid=${openid}&oauth_consumer_key=${config.client_id}&format=json`;
        const response = await axios.get(userInfoUrl);
        const data = response.data;
        return {
          open_id: openid,
          nickname: data.nickname,
          avatar: data.figureurl_qq_2 || data.figureurl_qq,
          email: null
        };
      }

      case 'weibo': {
        const url = `${OAUTH_CONFIGS.weibo.userApi}?access_token=${accessToken}`;
        const response = await axios.get(url);
        const data = response.data;
        return {
          open_id: String(data.id),
          nickname: data.screen_name,
          avatar: data.avatar_large,
          email: null
        };
      }

      case 'google': {
        const response = await axios.get(OAUTH_CONFIGS.google.userApi, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = response.data;
        return {
          open_id: data.id,
          nickname: data.name,
          avatar: data.picture,
          email: data.email
        };
      }

      default:
        return null;
    }
  } catch (error) {
    console.error(`[OAuth] 获取 ${provider} 用户信息失败:`, error.message);
    return null;
  }
}

// ============ 路由处理 ============

// OAuth回调处理
router.get('/callback/:provider', async (req, res) => {
  const { provider } = req.params;
  const { code, state } = req.query;
  const db = req.db;

  if (!OAUTH_CONFIGS[provider]) {
    return res.status(400).send('不支持的登录方式');
  }

  // 验证state参数
  if (!req.session.oauthState || req.session.oauthState !== state) {
    return res.status(400).send('无效的请求参数');
  }

  // 清除state
  delete req.session.oauthState;

  const source = req.session.oauthSource || 'frontend';
  const redirectBase = source === 'image-share' ? '/image-share' : '/';

  // 获取OAuth配置
  const config = queryOne(db, 'SELECT * FROM oauth_providers WHERE provider = ? AND is_enabled = 1', [provider]);
  if (!config) {
    return res.redirect('/auth/' + source + '/login?error=该登录方式未启用');
  }

  // 获取redirect_uri
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`;

  // 获取access_token
  const accessToken = await getAccessToken(provider, config, code, redirectUri);
  if (!accessToken) {
    return res.redirect('/auth/' + source + '/login?error=登录失败，请重试');
  }

  // 获取用户信息
  const userInfo = await getUserInfo(provider, config, accessToken);
  if (!userInfo || !userInfo.open_id) {
    return res.redirect('/auth/' + source + '/login?error=获取用户信息失败');
  }

  // 查找已绑定的用户
  const binding = queryOne(db, 'SELECT * FROM user_oauth_bindings WHERE provider = ? AND open_id = ?', [provider, userInfo.open_id]);

  if (binding) {
    // 已绑定，直接登录
    const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [binding.user_id]);

    if (!user || user.status === 'disabled' || user.status === 0) {
      return res.redirect('/auth/' + source + '/login?error=账号已被禁用');
    }

    if (user.status === 'pending') {
      return res.redirect('/auth/' + source + '/login?error=账号未激活');
    }

    // 更新token
    db.run('UPDATE user_oauth_bindings SET access_token = ?, nickname = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [accessToken, userInfo.nickname || '', userInfo.avatar || '', binding.id]);
    saveDatabase();

    // 设置session
    req.session.user = {
      id: user.id,
      uid: user.uid || '',
      username: user.username,
      email: user.email,
      nickname: user.nickname || user.username,
      role: user.role,
      avatar: user.avatar || '/assets/images/default-avatar.png'
    };

    // 记录登录日志
    try {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action: 'oauth_login',
        target_type: 'auth',
        target_title: OAUTH_CONFIGS[provider]?.name || provider,
        detail: `用户 ${user.username} 通过 ${OAUTH_CONFIGS[provider]?.name || provider} 登录成功`,
        ip: req.ip
      });
    } catch (e) {
      // 日志记录失败不影响登录流程
    }

    return res.redirect(redirectBase);
  }

  // 未绑定，检查是否有相同邮箱的用户
  if (userInfo.email) {
    const existingUser = queryOne(db, 'SELECT * FROM users WHERE email = ?', [userInfo.email]);

    if (existingUser && existingUser.status === 'active') {
      // 自动绑定到已有用户
      db.run('INSERT INTO user_oauth_bindings (user_id, provider, open_id, access_token, nickname, avatar) VALUES (?, ?, ?, ?, ?, ?)',
        [existingUser.id, provider, userInfo.open_id, accessToken, userInfo.nickname || '', userInfo.avatar || '']);
      saveDatabase();

      // 设置session
      req.session.user = {
        id: existingUser.id,
        uid: existingUser.uid || '',
        username: existingUser.username,
        email: existingUser.email,
        nickname: existingUser.nickname || existingUser.username,
        role: existingUser.role,
        avatar: existingUser.avatar || '/assets/images/default-avatar.png'
      };

      // 记录日志
      try {
        logActivity(db, {
          user_id: existingUser.id,
          username: existingUser.username,
          action: 'oauth_bind',
          target_type: 'auth',
          target_title: OAUTH_CONFIGS[provider]?.name || provider,
          detail: `用户 ${existingUser.username} 自动绑定 ${OAUTH_CONFIGS[provider]?.name || provider} 并登录`,
          ip: req.ip
        });
      } catch (e) { /* 日志记录失败不影响登录 */ }

      return res.redirect(redirectBase);
    }
  }

  // 没有已绑定或相同邮箱的用户，创建新用户
  const username = `oauth_${provider}_${userInfo.open_id.substring(0, 8)}`;
  const hashedPassword = crypto.randomBytes(16).toString('hex');
  const uid = generateUid(db);

  // 检查用户名是否已存在
  let finalUsername = username;
  let counter = 1;
  while (queryOne(db, 'SELECT id FROM users WHERE username = ?', [finalUsername])) {
    finalUsername = `${username}_${counter}`;
    counter++;
  }

  db.run("INSERT INTO users (uid, username, password, email, nickname, role, status, avatar) VALUES (?, ?, ?, ?, ?, 'user', 'active', ?)",
    [uid, finalUsername, hashedPassword, userInfo.email || '', userInfo.nickname || finalUsername, userInfo.avatar || '/assets/images/default-avatar.png']);
  saveDatabase();

  const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [finalUsername]);
  if (!newUser) {
    return res.redirect('/auth/' + source + '/login?error=创建用户失败');
  }

  // 授予默认权限
  const defaultPerms = ['homepage.access', 'articles.access', 'novels.access', 'image-share.access', 'poem-game.access'];
  defaultPerms.forEach(perm => {
    db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [newUser.id, perm, newUser.id]);
  });

  // 绑定OAuth
  db.run('INSERT INTO user_oauth_bindings (user_id, provider, open_id, access_token, nickname, avatar) VALUES (?, ?, ?, ?, ?, ?)',
    [newUser.id, provider, userInfo.open_id, accessToken, userInfo.nickname || '', userInfo.avatar || '']);
  saveDatabase();

  // 设置session
  req.session.user = {
    id: newUser.id,
    uid: uid,
    username: finalUsername,
    email: userInfo.email || '',
    nickname: userInfo.nickname || finalUsername,
    role: 'user',
    avatar: userInfo.avatar || '/assets/images/default-avatar.png'
  };

  // 记录日志
  try {
    logActivity(db, {
      user_id: newUser.id,
      username: finalUsername,
      action: 'oauth_register',
      target_type: 'auth',
      target_title: OAUTH_CONFIGS[provider]?.name || provider,
      detail: `用户 ${finalUsername} 通过 ${OAUTH_CONFIGS[provider]?.name || provider} 注册并登录`,
      ip: req.ip
    });
  } catch (e) {
    // 日志记录失败不影响登录流程
  }

  return res.redirect(redirectBase);
});

// 获取OAuth登录URL (AJAX接口)
router.get('/auth-url/:provider', (req, res) => {
  const { provider } = req.params;
  const { source } = req.query;
  const db = req.db;

  if (!OAUTH_CONFIGS[provider]) {
    return res.status(400).json({ error: '不支持的登录方式' });
  }

  const config = queryOne(db, 'SELECT * FROM oauth_providers WHERE provider = ? AND is_enabled = 1', [provider]);
  if (!config || !config.client_id) {
    return res.status(400).json({ error: '该登录方式未配置或未启用' });
  }

  // 生成state
  const state = generateState();
  req.session.oauthState = state;
  req.session.oauthSource = source || 'frontend';

  // 获取redirect_uri
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`;

  // 生成授权URL
  const authUrl = getAuthUrl(provider, config, state, redirectUri);

  if (!authUrl) {
    return res.status(400).json({ error: '生成授权URL失败' });
  }

  res.json({ url: authUrl });
});

// 解除OAuth绑定
router.post('/unbind/:provider', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }

  const { provider } = req.params;
  const db = req.db;

  // 检查是否是最后一个登录方式
  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 检查是否设置了密码
  const hasPassword = user.password && user.password.length > 0;

  // 检查绑定数量
  const bindings = queryAll(db, 'SELECT * FROM user_oauth_bindings WHERE user_id = ?', [req.session.user.id]);

  if (!hasPassword && bindings.length <= 1) {
    return res.status(400).json({ error: '请先设置密码，否则解绑后将无法登录' });
  }

  db.run('DELETE FROM user_oauth_bindings WHERE user_id = ? AND provider = ?', [req.session.user.id, provider]);
  saveDatabase();

  // 记录日志
  try {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'oauth_unbind',
      target_type: 'auth',
      target_title: OAUTH_CONFIGS[provider]?.name || provider,
      detail: `用户 ${req.session.user.username} 解除 ${OAUTH_CONFIGS[provider]?.name || provider} 绑定`,
      ip: req.ip
    });
  } catch (e) {
    // 日志记录失败不影响解绑流程
  }

  res.json({ success: true });
});

module.exports = { router, getEnabledProviders, initDefaultProviders, OAUTH_CONFIGS };
