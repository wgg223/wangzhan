const { queryAll, getDb, queryOne } = require('../config/database');

// 权限等级定义（数值越大权限越高）
const ROLE_HIERARCHY = {
  'visitor': 0,
  'user': 1,
  'admin': 8,
  'super_admin': 10
};

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

// 检查用户是否拥有特定权限（基于 permissions 表）
// super_admin 拥有所有权限；admin 和普通用户只拥有被授予的权限
// 支持精确匹配和层级匹配：
// - 精确匹配：'articles.view' 只匹配 'articles.view'
// - 通配符匹配：用户有 'articles.*' 可匹配任意 articles 权限
// - 层级匹配：用户有 'articles.edit.all' 可匹配 'articles.edit.own'（高权限包含低权限）
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

    // admin 角色拥有所有后台权限
    if (req.session.user.role === 'admin') {
      const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
      res.locals.userPermissions = allPerms.map(p => p.perm_key);
      return next();
    }

    // 获取用户所有权限
    const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
    const userPermKeys = userPerms.map(p => p.perm_key);
    res.locals.userPermissions = userPermKeys;

    // 精确匹配检查
    if (userPermKeys.indexOf(permKey) !== -1) {
      return next();
    }

    // 通配符匹配：用户有 'articles.*' 可匹配任意 articles.xxx 权限
    const parts = permKey.split('.');
    const wildcardKey = parts[0] + '.*';
    if (userPermKeys.indexOf(wildcardKey) !== -1) {
      return next();
    }

    // 层级匹配：高权限包含低权限
    // 例如：用户有 'articles.edit.all' 可匹配 'articles.edit.own'
    // 规则：如果用户拥有的权限以请求权限为前缀，且后面是 'all' 或更高级别，则通过
    const hasHigherPerm = userPermKeys.some(userPerm => {
      // 检查用户权限是否是请求权限的上级
      // 例如：userPerm = 'articles.edit.all', permKey = 'articles.edit.own'
      if (permKey.startsWith(userPerm.replace(/\.all$/, '.'))) {
        return true;
      }
      return false;
    });
    if (hasHigherPerm) {
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
//       admin 拥有所有后台权限；
//       普通用户只拥有被授予的权限功能
function canAccessAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = getDb();
  if (!db) {
    return res.status(500).send('数据库未初始化');
  }

  // super_admin 和 admin 拥有完整后台访问权限
  if (req.session.user.role === 'super_admin' || req.session.user.role === 'admin') {
    const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
    res.locals.userPermissions = allPerms.map(p => p.perm_key);
    return next();
  }

  // 普通用户：功能可见性由 user_permissions 控制
  const userPerms = queryAll(db,
    'SELECT perm_key FROM user_permissions WHERE user_id = ?',
    [req.session.user.id]
  );
  res.locals.userPermissions = userPerms.map(p => p.perm_key);
  return next();
}


// 检查用户是否可编辑某篇文章（作者本人或管理员以上）
function canEditArticle(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login');
  }

  const db = getDb();
  if (!db) {
    return res.status(500).send('数据库未初始化');
  }

  // 管理员和超级管理员可编辑任何文章
  if (req.session.user.role === 'super_admin' || req.session.user.role === 'admin') {
    return next();
  }

  // 普通用户只能编辑自己的文章
  const articleId = req.params.id || req.body.id;
  if (!articleId) {
    return res.status(400).render('frontend/error', {
      message: '请求错误',
      error: '文章ID不能为空',
      user: req.session ? req.session.user || null : null,
      settings: res.locals.settings || {}
    });
  }

  const article = queryOne(db, 'SELECT author_id FROM articles WHERE id = ?', [articleId]);
  if (article && article.author_id === req.session.user.id) {
    return next();
  }

  // 无权限时静默重定向到首页，避免出现"无法访问"错误
  res.redirect('/');
}

/**
 * 检查当前用户是否为管理员角色
 * 用于后台路由中判断是否需要做数据隔离（管理员能看到所有，普通用户只能看自己的）
 */
function isAdminRole(user) {
  return user && (user.role === 'super_admin' || user.role === 'admin');
}

/**
 * 检查用户是否能操作某篇文章（作者本人或管理员以上）
 */
function canManageArticle(user, article) {
  if (!user || !article) return false;
  if (isAdminRole(user)) return true;
  return article.author_id === user.id;
}

/**
 * 检查用户是否能操作某个媒体文件（上传者本人或管理员以上）
 */
function canManageMedia(user, media) {
  if (!user || !media) return false;
  if (isAdminRole(user)) return true;
  return media.uploaded_by === user.id;
}

// 获取用户所有权限
function getUserPermissions(userId) {
  const db = getDb();
  if (!db) return [];
  const result = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [userId]);
  return result.map(r => r.perm_key);
}

// 检查用户是否拥有前端页面访问权限
// super_admin 和 admin 拥有所有前端权限；普通用户需要被授予对应权限
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

    // admin 拥有所有前端权限
    if (req.session.user.role === 'admin') {
      const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
      res.locals.userPermissions = allPerms.map(p => p.perm_key);
      return next();
    }

    // 普通用户：检查 user_permissions 表
    const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
    const userPermKeys = userPerms.map(p => p.perm_key);
    res.locals.userPermissions = userPermKeys;

    // 精确匹配
    if (userPermKeys.indexOf(permKey) !== -1) {
      return next();
    }

    // 通配符匹配
    const parts = permKey.split('.');
    const wildcardKey = parts[0] + '.*';
    if (userPermKeys.indexOf(wildcardKey) !== -1) {
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

module.exports = {
  isAuthenticated, isSuperAdmin, isAdmin, hasPermission, canAccessAdmin,
  getUserPermissions, canEditArticle, ROLE_HIERARCHY,
  isAdminRole, canManageArticle, canManageMedia, hasFrontendPermission
};
