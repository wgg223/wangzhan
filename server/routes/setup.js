const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const {
  queryOne,
  queryAll,
  isSetupCompleted,
  markSetupCompleted,
  applyPragmaSettings,
  saveDatabase,
  closeDatabase,
  getDbPath,
  insertDefaultDataIfNeeded,
  generateUid
} = require('../config/database');
const { dbUpload } = require('./admin/upload');
const fs = require('fs');

// 数据库模式预设
const PRAGMA_PRESETS = {
  balanced: {
    label: '均衡模式（推荐）',
    description: '平衡性能与数据安全，适合大多数场景',
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
    cache_size: '-2000'
  },
  performance: {
    label: '高性能模式',
    description: '最大化写入性能，但异常断电可能导致少量数据丢失',
    journal_mode: 'WAL',
    synchronous: 'OFF',
    cache_size: '-4000'
  },
  safety: {
    label: '安全模式',
    description: '最高数据安全性，写入速度较慢',
    journal_mode: 'DELETE',
    synchronous: 'FULL',
    cache_size: '-2000'
  },
  memory: {
    label: '内存模式',
    description: '全内存运行，重启后数据丢失（仅用于测试）',
    journal_mode: 'MEMORY',
    synchronous: 'OFF',
    cache_size: '-8000'
  }
};

/**
 * 安装检查中间件 - 如果已安装则重定向到首页
 */
router.use((req, res, next) => {
  if (!req.db) {
    return res.status(500).send('数据库未初始化');
  }

  // 检查安装状态
  if (isSetupCompleted()) {
    // 已安装完成，重定向到首页
    return res.redirect('/');
  }

  next();
});

/**
 * GET /setup - 显示安装页面
 */
router.get('/', (req, res) => {
  res.render('setup/setup', { layout: false,
    error: null,
    presets: PRAGMA_PRESETS,
    formData: {
      username: '',
      email: '',
      db_mode: 'balanced',
      custom_journal_mode: 'WAL',
      custom_synchronous: 'NORMAL',
      custom_cache_size: '2000'
    }
  });
});

/**
 * POST /setup - 处理安装表单提交
 */
router.post('/', (req, res) => {
  const db = req.db;
  const { username, password, confirm_password, email, db_mode } = req.body;

  // 获取 PRAGMA 设置（根据选择的模式）
  let pragmaSettings = {};

  if (db_mode === 'custom') {
    // 自定义模式
    pragmaSettings = {
      journal_mode: req.body.custom_journal_mode || 'WAL',
      synchronous: req.body.custom_synchronous || 'NORMAL',
      cache_size: req.body.custom_cache_size || '2000'
    };
  } else if (PRAGMA_PRESETS[db_mode]) {
    pragmaSettings = PRAGMA_PRESETS[db_mode];
  } else {
    pragmaSettings = PRAGMA_PRESETS.balanced;
  }

  // 验证表单
  const validationError = validateForm({ username, password, confirm_password, email, db_mode });
  if (validationError) {
    return res.render('setup/setup', { layout: false,
      error: validationError,
      presets: PRAGMA_PRESETS,
      formData: { username, email, db_mode, ...req.body }
    });
  }

  try {
    // 1. 应用 PRAGMA 设置（必须在创建用户之前）
    applyPragmaSettings(pragmaSettings);

    // 2. 创建超级管理员账户
    const hashedPassword = bcrypt.hashSync(password, 10);
    const adminUid = generateUid(db);
    db.run(
      "INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, 'super_admin', 'active')",
      [adminUid, username, hashedPassword, email || null]
    );

    // 3. 插入默认数据（分类、设置、权限等）
    insertDefaultDataIfNeeded();

    // 4. 为超级管理员分配所有权限
    const adminUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
    if (adminUser) {
      const allPermissions = queryAll(db, 'SELECT perm_key FROM permissions');
      allPermissions.forEach(perm => {
        db.run(
          'INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
          [adminUser.id, perm.perm_key, adminUser.id]
        );
      });
    }

    // 5. 保存数据库并标记安装完成
    saveDatabase();
    markSetupCompleted();

    // 6. 自动登录
    req.session.user = {
      id: adminUser.id,
      username: adminUser.username,
      email: adminUser.email,
      nickname: adminUser.username,
      role: 'super_admin',
      avatar: '/assets/images/default-avatar.png'
    };

    // 7. 重定向到管理后台
    return res.redirect('/admin?setup=complete');
  } catch (err) {
    console.error('安装失败:', err);
    return res.render('setup/setup', { layout: false,
      error: '安装过程出错: ' + err.message,
      presets: PRAGMA_PRESETS,
      formData: { username, email, db_mode, ...req.body }
    });
  }
});

/**
 * POST /setup/restore - 上传数据库文件恢复
 */
router.post('/restore', (req, res) => {
  dbUpload.single('dbfile')(req, res, function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: '文件大小超出限制（最大200MB）' });
      }
      return res.status(400).json({ success: false, message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择数据库文件' });
    }

    try {
      const uploadedPath = req.file.path;
      const dbPath = getDbPath();

      // 关闭当前数据库连接
      closeDatabase();

      // 替换数据库文件
      fs.copyFileSync(uploadedPath, dbPath);

      // 清理临时文件
      try { fs.unlinkSync(uploadedPath); } catch (e) { /* ignore */ }
      const tmpDir = require('path').dirname(uploadedPath);
      try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }

      // 标记安装完成
      markSetupCompleted();

      res.json({ success: true, redirect: '/admin' });
    } catch (err) {
      console.error('数据库恢复失败:', err);
      res.status(500).json({ success: false, message: '数据库恢复失败: ' + err.message });
    }
  });
});

/**
 * AJAX 验证用户名是否可用
 */
router.get('/check-username', (req, res) => {
  const { username } = req.query;
  if (!username || username.length < 3 || username.length > 20) {
    return res.json({ available: false, message: '用户名长度应在3-20个字符之间' });
  }

  const existing = queryOne(req.db, 'SELECT id FROM users WHERE username = ?', [username]);
  res.json({ available: !existing });
});

/**
 * 表单验证
 */
function validateForm({ username, password, confirm_password, email, db_mode }) {
  if (!username || !password || !confirm_password) {
    return '请填写所有必填项';
  }

  if (username.length < 3 || username.length > 20) {
    return '用户名长度应在3-20个字符之间';
  }

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
    return '用户名只能包含中文、英文、数字和下划线';
  }

  if (password.length < 6) {
    return '密码长度不能少于6位';
  }

  if (password !== confirm_password) {
    return '两次输入的密码不一致';
  }

  if (email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return '邮箱格式不正确';
    }
  }

  if (!db_mode || (!PRAGMA_PRESETS[db_mode] && db_mode !== 'custom')) {
    return '请选择有效的数据库模式';
  }

  // 检查是否已有用户（防止并发安装）
  const existingUsers = queryOne(require('../config/database').getDb(),
    'SELECT COUNT(*) as count FROM users');
  if (existingUsers && existingUsers.count > 0) {
    return '系统已经初始化，不能重复安装';
  }

  return null;
}

module.exports = router;
