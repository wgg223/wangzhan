const { queryAll, getDb, queryOne } = require('../config/database');

// 权限等级定义（数值越大权限越高）
const ROLE_HIERARCHY = {
  'visitor': 0,
  'user': 1,
  'admin': 8,
  'super_admin': 10
};

// 可被后台修改的角色白名单（统一改角色校验）
const ROLE_WHITELIST = ['user', 'admin', 'super_admin'];

/**
 * 检查 operator 能否对 target 执行管理操作（禁用/删除/改角色/重置密码等）。
 * 规则：不能操作自己；非超管不能操作超管；同级/高级不可动；
 * 特例：超管可操作其他超管（除自己）。
 * @returns {{ok: boolean, reason?: string}}
 */
function canOperateUser(operator, target) {
  if (!operator || !target) {
    return { ok: false, reason: '参数不完整' };
  }
  if (operator.id === target.id) {
    return { ok: false, reason: '不能操作自己的账号' };
  }
  if (target.role === 'super_admin' && operator.role !== 'super_admin') {
    return { ok: false, reason: '无权操作超级管理员' };
  }
  const opLevel = ROLE_HIERARCHY[operator.role] || 0;
  const tgtLevel = ROLE_HIERARCHY[target.role] || 0;
  if (opLevel <= tgtLevel && operator.role !== 'super_admin') {
    return { ok: false, reason: '权限不足：不能操作同级别或更高级别的用户' };
  }
  return { ok: true };
}

/**
 * 确保排除 excludeUserId 后仍至少存在一个 active 的超级管理员，
 * 用于禁用/删除/降级超管前防管理端锁死。
 * @returns {boolean}
 */
function ensureAtLeastOneActiveSuperAdmin(db, excludeUserId) {
  const rows = queryAll(
    db,
    "SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND status = 'active' AND id != ?",
    [excludeUserId]
  );
  return (rows && rows[0] && rows[0].count > 0) || false;
}

// 检查用户是否已登录
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/auth/frontend/login');
}

// 检查用户是否是超级管理员
function isSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'super_admin') {
    // 设置完整权限列表供布局模板使用
    const db = getDb();
    if (db) {
      const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
      res.locals.userPermissions = allPerms.map(p => p.perm_key);
    } else {
      res.locals.userPermissions = [];
    }
    return next();
  }
  // 无权限时静默重定向到首页，避免出现"无法访问"错误
  res.redirect('/');
}

// 检查用户是否是管理员或超级管理员
function isAdmin(req, res, next) {
  if (req.session && req.session.user &&
      (req.session.user.role === 'admin' || req.session.user.role === 'super_admin')) {
    return next();
  }
  // 无权限时静默重定向到首页，避免出现"无法访问"错误
  res.redirect('/');
}

/**
 * 权限匹配核心（v2）——供中间件与业务函数统一复用。
 * 用户拥有的权限集合 userPermKeys 与请求权限 permKey 的匹配规则：
 *  1. 精确匹配：userPermKey === permKey
 *  2. 通配符匹配：userPermKey === 模块前缀 + '.*'（如 articles.* 覆盖 articles.xxx）
 *  3. 模块全权匹配：userPermKey 以 .manage 结尾，且其前缀段与 permKey 前缀段相同
 *     （如 articles.manage 覆盖 articles.view/create/edit.own 等模块内全部子权限；
 *       novels.chapters.manage 覆盖 novels.chapters.create 等章节级子权限）
 *  4. 层级匹配：userPermKey 以 .all 结尾，覆盖同一前缀下的子权限
 *     （如 articles.edit.all 覆盖 articles.edit.own）
 * @param {string[]} userPermKeys 用户拥有的权限键数组
 * @param {string} permKey 请求校验的权限键
 * @returns {boolean}
 */
function hasPermKey(userPermKeys, permKey) {
  if (!Array.isArray(userPermKeys) || typeof permKey !== 'string') return false;
  if (userPermKeys.indexOf(permKey) !== -1) return true;
  const modulePrefix = permKey.split('.')[0];
  for (const up of userPermKeys) {
    if (typeof up !== 'string') continue;
    if (up === modulePrefix + '.*') return true;              // 通配符
    const manageMatch = up.match(/^(.*)\.manage$/);           // 模块全权
    if (manageMatch && permKey.startsWith(manageMatch[1] + '.')) return true;
    if (up.endsWith('.all') && permKey.startsWith(up.slice(0, -4))) return true; // .all 层级
  }
  return false;
}

// 查询用户有效权限键（过滤已过期的权限；expires_at 为过去时间即失效）
function getUserPermKeys(db, userId) {
  const rows = queryAll(db,
    "SELECT perm_key FROM user_permissions WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
    [userId]);
  return (rows || []).map(r => r.perm_key);
}

// 检查用户是否拥有特定权限（基于 permissions 表）
// super_admin 拥有所有权限；admin 和普通用户只拥有被授予的权限
// 匹配规则见 hasPermKey（精确 / 通配 / 模块全权 manage 包含 / .all 层级）
// 权限有效期：user_permissions.expires_at 已过期的权限自动失效
function hasPermission(permKey) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/auth/frontend/login');
    }

    const db = getDb();
    if (!db) {
      return res.status(500).send('数据库未初始化');
    }

    // super_admin 拥有所有权限
    if (req.session.user.role === 'super_admin') {
      const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
      res.locals.userPermissions = allPerms.map(p => p.perm_key);
      return next();
    }

    // 获取用户所有有效权限（自动过滤已过期）
    const userPermKeys = getUserPermKeys(db, req.session.user.id);
    res.locals.userPermissions = userPermKeys;

    // 统一匹配（精确 + 通配 + manage 全权 + .all 层级）
    if (hasPermKey(userPermKeys, permKey)) {
      return next();
    }

    // 对于AJAX/JSON请求返回JSON错误
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(403).json({ error: '非法操作：您没有执行此操作的权限' });
    }

    // 获取权限信息
    const permInfo = queryOne(db, 'SELECT perm_name, description FROM permissions WHERE perm_key = ?', [permKey]);

    // 无权限时显示友好的提示页面
    res.status(403).render('frontend/no-permission', {
      user: req.session.user,
      permKey: permKey,
      permName: permInfo ? permInfo.perm_name : permKey,
      permDesc: permInfo ? permInfo.description : '',
      settings: res.locals.settings || {}
    });
  };
}

// 检查用户是否可以访问后台
// 规则：super_admin 拥有完整权限；
//       admin 与普通用户一样由 user_permissions 表决定可访问的功能
function canAccessAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = getDb();
  if (!db) {
    return res.status(500).send('数据库未初始化');
  }

  // super_admin 拥有完整后台访问权限；admin 与普通用户一样由 user_permissions 控制
  if (req.session.user.role === 'super_admin') {
    const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
    res.locals.userPermissions = allPerms.map(p => p.perm_key);
    return next();
  }

  // 普通用户（含 admin）：功能可见性由 user_permissions 控制（自动过滤过期）
  res.locals.userPermissions = getUserPermKeys(db, req.session.user.id);
  return next();
}


/**
 * 检查用户是否可编辑某篇文章。
 * 权限化（P1-6 修复）：super_admin 可编辑任意文章；
 * 拥有 articles.edit.all（或 articles.manage）可编辑任意文章；
 * 拥有 articles.edit.own 仅可编辑自己创建的文章；
 * 无权限的 admin 不再硬编码放行（撤销权限后真正生效）。
 */
function canEditArticle(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = getDb();
  if (!db) {
    return res.status(500).send('数据库未初始化');
  }

  const user = req.session.user;
  if (user.role === 'super_admin') {
    return next();
  }

  const userPermKeys = getUserPermKeys(db, user.id);

  // 拥有"编辑全部文章"能力（含 articles.manage）→ 放行，资源归属由业务层复核
  if (hasPermKey(userPermKeys, 'articles.edit.all')) {
    return next();
  }

  // 仅拥有"编辑自己的文章"→ 校验文章归属
  if (hasPermKey(userPermKeys, 'articles.edit.own')) {
    const articleId = req.params.id || req.body.id;
    if (!articleId) {
      return res.status(400).render('frontend/error', {
        message: '请求错误',
        error: '文章ID不能为空',
        user: user,
        settings: res.locals.settings || {}
      });
    }
    const article = queryOne(db, 'SELECT author_id FROM articles WHERE id = ?', [articleId]);
    if (article && article.author_id === user.id) {
      return next();
    }
  }

  // 无权限时静默重定向到首页，避免出现"无法访问"错误
  res.redirect('/');
}

/**
 * 检查当前用户是否为管理员角色
 * 用于后台路由中判断是否需要做数据隔离（管理员能看到所有，普通用户只能看自己的）
 * 注意：业务级"管理员可管理任意内容"的兜底判断；细粒度授权场景请改用
 *       hasPermKey(userPermKeys, 'xxx.edit.all' / 'xxx.delete.all')。
 */
function isAdminRole(user) {
  return user && (user.role === 'super_admin' || user.role === 'admin');
}

/**
 * 检查用户是否能操作某篇文章（P1-6 权限化）。
 * super_admin 全权；拥有 articles.edit.all/delete.all（或 articles.manage）可操作任意文章；
 * 否则仅本人创建的文章。userPermKeys 可选：不传时回退为角色判断（旧行为）。
 */
function canManageArticle(user, article, userPermKeys) {
  if (!user || !article) return false;
  if (user.role === 'super_admin') return true;
  if (Array.isArray(userPermKeys)) {
    if (hasPermKey(userPermKeys, 'articles.edit.all') || hasPermKey(userPermKeys, 'articles.delete.all')) return true;
  } else if (isAdminRole(user)) {
    return true; // 兼容旧调用（未传入权限时保持管理员全权语义）
  }
  return article.author_id === user.id;
}

/**
 * 检查用户是否能操作某个媒体文件（P1-6 权限化）。
 * super_admin 全权；拥有 media.manage 可操作任意媒体；否则仅本人上传的文件。
 * userPermKeys 可选：不传时回退为角色判断（旧行为）。
 */
function canManageMedia(user, media, userPermKeys) {
  if (!user || !media) return false;
  if (user.role === 'super_admin') return true;
  if (Array.isArray(userPermKeys)) {
    if (hasPermKey(userPermKeys, 'media.manage')) return true;
  } else if (isAdminRole(user)) {
    return true; // 兼容旧调用
  }
  return media.uploaded_by === user.id;
}

// 获取用户所有有效权限（过滤已过期）
function getUserPermissions(userId) {
  const db = getDb();
  if (!db) return [];
  return getUserPermKeys(db, userId);
}

// 检查用户是否拥有前端页面访问权限
// super_admin 拥有所有前端权限；admin 与普通用户一样需要被授予对应权限
// 匹配规则与有效期处理同 hasPermission
function hasFrontendPermission(permKey) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      // 未登录用户可以访问主页，其他页面需要登录
      if (permKey === 'homepage.access') {
        return next();
      }
      return res.redirect('/auth/frontend/login');
    }

    const db = getDb();
    if (!db) {
      return res.status(500).send('数据库未初始化');
    }

    // super_admin 拥有所有权限
    if (req.session.user.role === 'super_admin') {
      const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
      res.locals.userPermissions = allPerms.map(p => p.perm_key);
      return next();
    }

    // 普通用户（含 admin）：检查 user_permissions 表（自动过滤过期）
    const userPermKeys = getUserPermKeys(db, req.session.user.id);
    res.locals.userPermissions = userPermKeys;

    // 统一匹配（精确 + 通配 + manage 全权 + .all 层级）
    if (hasPermKey(userPermKeys, permKey)) {
      return next();
    }

    // 对于AJAX/JSON请求返回JSON错误
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(403).json({ error: '您没有访问此功能的权限，请先申请权限' });
    }

    // 获取权限信息
    const permInfo = queryOne(db, 'SELECT perm_name, description FROM permissions WHERE perm_key = ?', [permKey]);

    // 无权限时显示友好的提示页面
    res.status(403).render('frontend/no-permission', {
      user: req.session.user,
      permKey: permKey,
      permName: permInfo ? permInfo.perm_name : permKey,
      permDesc: permInfo ? permInfo.description : '',
      settings: res.locals.settings || {}
    });
  };
}

/**
 * 密码强度校验（弱口令策略加固）
 * 规则：长度≥10、包含大写/小写/数字/特殊字符中至少3类、排除常见弱口令
 * @returns {{ok: boolean, reason?: string}}
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, reason: '密码不能为空' };
  }
  if (password.length < 10) {
    return { ok: false, reason: '密码长度不能少于10位' };
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  const classCount = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (classCount < 3) {
    return { ok: false, reason: '密码需包含大写字母、小写字母、数字、特殊字符中至少3类' };
  }
  // 常见弱口令黑名单（Top 20）
  const weakPasswords = [
    '1234567890', 'password123', 'admin12345', 'qwerty1234', 'abc1234567',
    '1111111111', '0000000000', '1231231231', 'iloveyou123', 'monkey1234',
    'dragon1234', 'master1234', 'welcome123', 'shadow1234', 'sunshine12',
    'princess12', 'football12', 'charlie123', 'whatever12', 'trustno123'
  ];
  if (weakPasswords.includes(password.toLowerCase())) {
    return { ok: false, reason: '密码过于常见，请使用更复杂的密码' };
  }
  return { ok: true };
}

module.exports = {
  isAuthenticated, isSuperAdmin, isAdmin, hasPermission, canAccessAdmin,
  getUserPermissions, getUserPermKeys, canEditArticle, ROLE_HIERARCHY, ROLE_WHITELIST,
  canOperateUser, ensureAtLeastOneActiveSuperAdmin,
  isAdminRole, canManageArticle, canManageMedia, hasFrontendPermission,
  hasPermKey, validatePassword
};
