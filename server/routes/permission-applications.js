const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../config/database');
const { logActivity } = require('../config/activity');

// 简单的速率限制：每个用户每小时最多提交5个申请
const applicationRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1小时
const MAX_APPLICATIONS_PER_WINDOW = 5;

function checkRateLimit(userId) {
  const now = Date.now();
  const userRecord = applicationRateLimit.get(userId) || { count: 0, windowStart: now };

  // 如果窗口已过期，重置计数
  if (now - userRecord.windowStart > RATE_LIMIT_WINDOW) {
    userRecord.count = 0;
    userRecord.windowStart = now;
  }

  if (userRecord.count >= MAX_APPLICATIONS_PER_WINDOW) {
    return false; // 超过限制
  }

  userRecord.count++;
  applicationRateLimit.set(userId, userRecord);
  return true;
}

// 定期清理过期的速率限制记录
setInterval(() => {
  const now = Date.now();
  for (const [userId, record] of applicationRateLimit.entries()) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW) {
      applicationRateLimit.delete(userId);
    }
  }
}, 10 * 60 * 1000); // 每10分钟清理一次

// 权限分类定义
const PERMISSION_CATEGORIES = {
  'basic': { name: '前端访问', description: '网站基本功能访问权限' },
  'content': { name: '内容管理', description: '文章、小说、页面等内容的管理' },
  'community': { name: '社区与消息', description: '评论、站内信等社区功能' },
  'image': { name: '图片分享', description: '图片分享模块管理' },
  'system': { name: '系统管理', description: '用户、权限、设置等管理功能' }
};

// 获取权限分类
function getPermCategory(permKey) {
  const categoryMap = {
    'homepage.access': 'basic',
    'articles.access': 'basic',
    'novels.access': 'basic',
    'image-share.access': 'basic',
    'poem-game.access': 'basic',
    'articles.manage': 'content',
    'novels.manage': 'content',
    'pages.manage': 'content',
    'media.manage': 'content',
    'messages.manage': 'community',
    'comments.manage': 'community',
    'image-share.manage': 'image',
    'users.manage': 'system',
    'permissions.manage': 'system',
    'settings.manage': 'system',
    'data.manage': 'system',
    'leaderboard.manage': 'system'
  };
  if (categoryMap[permKey]) return categoryMap[permKey];
  if (permKey.endsWith('.access')) return 'basic';
  return 'system';
}

// 用户申请权限页面
router.get('/permissions/apply', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;

  // 获取所有可用权限
  const allPermissions = queryAll(db, 'SELECT * FROM permissions ORDER BY id ASC');

  // 获取用户已有的权限
  const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [userId]);
  const userPermKeys = userPerms.map(p => p.perm_key);

  // 获取用户待处理的申请
  const pendingApps = queryAll(db,
    'SELECT * FROM permission_applications WHERE user_id = ? AND status = ? ORDER BY created_at DESC',
    [userId, 'pending']
  );
  const pendingPermKeys = pendingApps.map(a => a.perm_key);

  // 获取用户所有申请记录
  const allApps = queryAll(db,
    'SELECT pa.*, p.perm_name, p.description FROM permission_applications pa LEFT JOIN permissions p ON pa.perm_key = p.perm_key WHERE pa.user_id = ? ORDER BY pa.created_at DESC',
    [userId]
  );

  // 按分类组织权限
  const permissionsByCategory = {};
  allPermissions.forEach(perm => {
    const category = getPermCategory(perm.perm_key);
    if (!permissionsByCategory[category]) {
      permissionsByCategory[category] = {
        ...PERMISSION_CATEGORIES[category],
        permissions: []
      };
    }
    permissionsByCategory[category].permissions.push({
      ...perm,
      isOwned: userPermKeys.includes(perm.perm_key),
      isPending: pendingPermKeys.includes(perm.perm_key)
    });
  });

  // 计算速率限制信息
  const userRecord = applicationRateLimit.get(userId);
  const rateLimitInfo = {
    remaining: userRecord ? MAX_APPLICATIONS_PER_WINDOW - userRecord.count : MAX_APPLICATIONS_PER_WINDOW,
    max: MAX_APPLICATIONS_PER_WINDOW,
    resetAt: userRecord ? new Date(userRecord.windowStart + RATE_LIMIT_WINDOW).toISOString() : null
  };

  res.render('frontend/permission-apply', {
    user: req.session.user,
    permissionsByCategory: permissionsByCategory,
    userPermKeys: userPermKeys,
    pendingPermKeys: pendingPermKeys,
    applications: allApps,
    rateLimitInfo: rateLimitInfo,
    settings: res.locals.settings || {}
  });
});

// 用户提交权限申请
router.post('/permissions/apply', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { perm_key, reason } = req.body;

  if (!perm_key) {
    return res.status(400).json({ error: '请选择要申请的权限' });
  }

  // 检查速率限制
  if (!checkRateLimit(userId)) {
    return res.status(429).json({ error: '申请过于频繁，请稍后再试' });
  }

  // 检查权限是否存在
  const perm = queryOne(db, 'SELECT * FROM permissions WHERE perm_key = ?', [perm_key]);
  if (!perm) {
    return res.status(400).json({ error: '权限不存在' });
  }

  // 检查用户是否已有此权限
  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?', [userId, perm_key]);
  if (existing) {
    return res.status(400).json({ error: '您已拥有此权限' });
  }

  // 检查是否有待处理的申请
  const pendingApp = queryOne(db,
    'SELECT id FROM permission_applications WHERE user_id = ? AND perm_key = ? AND status = ?',
    [userId, perm_key, 'pending']
  );
  if (pendingApp) {
    return res.status(400).json({ error: '您已提交此权限的申请，请等待审核' });
  }

  // 验证申请原因长度
  if (reason && reason.length > 500) {
    return res.status(400).json({ error: '申请原因不能超过500字' });
  }

  // 创建申请
  db.run(
    'INSERT INTO permission_applications (user_id, perm_key, reason) VALUES (?, ?, ?)',
    [userId, perm_key, reason || '']
  );
  saveDatabase();

  logActivity(db, {
    user_id: userId,
    username: req.session.user.username,
    action: 'apply',
    target_type: 'permission',
    target_id: 0,
    target_title: perm.perm_name,
    detail: '申请权限: ' + perm.perm_name,
    ip: req.ip
  });

  res.json({ success: true, message: '申请已提交，请等待管理员审核' });
});

// 用户取消权限申请
router.post('/permissions/cancel', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { application_id } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const app = queryOne(db,
    'SELECT * FROM permission_applications WHERE id = ? AND user_id = ? AND status = ?',
    [application_id, userId, 'pending']
  );

  if (!app) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  db.run('DELETE FROM permission_applications WHERE id = ?', [application_id]);
  saveDatabase();

  res.json({ success: true, message: '申请已取消' });
});

module.exports = router;
