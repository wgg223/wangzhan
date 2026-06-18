const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const { isAuthenticated, canAccessAdmin, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, closeAndDeleteDatabase } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { getProjectStats, cleanProjectFiles } = require('../../utils/project-utils');
const { PROJECT_DEFINITIONS, DEPENDENT_TABLES, ALL_TABLES } = require('../../config/constants');
const fsSafe = require('../../utils/fs-safe');

// ============ 选择性重置 ============

router.post('/reset/selective', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const { password, types } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: '请输入管理员密码' });
  }

  if (!types || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要重置的数据类型' });
  }

  const admin = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(403).json({ success: false, error: '密码验证失败' });
  }

  const results = [];

  try {
    // 用户数据
    if (types.includes('users')) {
      db.run("DELETE FROM users WHERE role != 'super_admin'");
      db.run('DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users)');
      db.run('DELETE FROM user_follows');
      results.push('用户数据');
    }

    // 内容数据
    if (types.includes('content')) {
      db.run('DELETE FROM articles');
      db.run('DELETE FROM pages');
      db.run('DELETE FROM comments');
      db.run('DELETE FROM article_drafts');
      db.run('DELETE FROM content_versions');
      results.push('内容数据');
    }

    // 媒体文件
    if (types.includes('media')) {
      // 删除文件
      const mediaFiles = queryAll(db, 'SELECT file_path FROM media');
      for (const m of mediaFiles) {
        const filePath = path.join(__dirname, '../../public', m.file_path);
        await fsSafe.safeUnlink(filePath);
      }
      const imageFiles = queryAll(db, 'SELECT url AS file_path FROM images');
      for (const m of imageFiles) {
        const filePath = path.join(__dirname, '../../public', m.file_path);
        await fsSafe.safeUnlink(filePath);
      }
      db.run('DELETE FROM media');
      db.run('DELETE FROM images');
      db.run('DELETE FROM image_favorites');
      results.push('媒体文件');
    }

    // 社交数据
    if (types.includes('social')) {
      db.run('DELETE FROM internal_messages');
      db.run('DELETE FROM notifications');
      db.run('DELETE FROM content_likes');
      db.run('DELETE FROM media_comments');
      db.run('DELETE FROM image_comments');
      results.push('社交数据');
    }

    // 日志数据
    if (types.includes('logs')) {
      db.run('DELETE FROM activity_logs');
      results.push('日志数据');
    }

    // 标签数据
    if (types.includes('tags')) {
      db.run('DELETE FROM tags');
      db.run('DELETE FROM content_tags');
      results.push('标签数据');
    }

    saveDatabase();

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'selective_reset',
      target_type: 'system',
      target_id: null,
      target_title: '选择性重置',
      detail: '选择性重置了：' + results.join(', '),
      ip: req.ip
    });

    res.json({
      success: true,
      message: '已重置：' + results.join(', '),
      resetItems: results
    });
  } catch (err) {
    console.error('选择性重置失败:', err);
    res.status(500).json({ success: false, error: '选择性重置失败: ' + err.message });
  }
});

// ============ 重置服务器 ============

router.get('/reset', isAuthenticated, canAccessAdmin, isSuperAdmin, (req, res) => {
  const db = req.db;

  // 收集所有项目的统计数据
  const allProjectDefs = getAllProjectDefinitions(db);
  const projectStatsList = allProjectDefs.map(project => {
    const { stats, totalRecords } = getProjectStats(db, project.tables);
    return {
      id: project.id,
      name: project.name,
      icon: project.icon,
      description: project.description,
      tables: project.tables,
      file_dirs: project.file_dirs,
      stats,
      totalRecords
    };
  });

  // 全局统计
  const globalStats = {
    users: queryOne(db, "SELECT COUNT(*) as count FROM users WHERE role != 'super_admin'")?.count || 0,
    media: queryOne(db, 'SELECT COUNT(*) as count FROM media')?.count || 0,
    activity_logs: queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0,
    internal_messages: queryOne(db, 'SELECT COUNT(*) as count FROM internal_messages')?.count || 0,
    notifications: queryOne(db, 'SELECT COUNT(*) as count FROM notifications')?.count || 0,
    content_likes: queryOne(db, 'SELECT COUNT(*) as count FROM content_likes')?.count || 0,
    user_follows: queryOne(db, 'SELECT COUNT(*) as count FROM user_follows')?.count || 0,
    tags: queryOne(db, 'SELECT COUNT(*) as count FROM tags')?.count || 0,
    content_tags: queryOne(db, 'SELECT COUNT(*) as count FROM content_tags')?.count || 0,
    content_versions: queryOne(db, 'SELECT COUNT(*) as count FROM content_versions')?.count || 0,
    article_drafts: queryOne(db, 'SELECT COUNT(*) as count FROM article_drafts')?.count || 0
  };

  // 计算总记录数
  let totalRecords = 0;
  projectStatsList.forEach(p => { totalRecords += p.totalRecords; });
  Object.values(globalStats).forEach(v => { totalRecords += v; });

  res.render('admin/reset', {
    user: req.session.user,
    settings: res.locals.settings || {},
    projectStats: projectStatsList,
    globalStats: globalStats,
    totalRecords: totalRecords
  });
});

router.post('/reset/execute', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: '请输入管理员密码' });
  }

  const admin = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(403).json({ success: false, error: '密码验证失败' });
  }

  // 1. 清理所有项目关联的文件
  const allProjectDefs = getAllProjectDefinitions(db);
  let totalDeletedFiles = 0;
  for (const project of allProjectDefs) {
    const deleted = await cleanProjectFiles(project.file_dirs);
    totalDeletedFiles += deleted;
  }

  // 清理 media 表中的文件
  const mediaFiles = queryAll(db, 'SELECT file_path FROM media');
  for (const m of mediaFiles) {
    const filePath = path.join(__dirname, '../../public', m.file_path);
    await fsSafe.safeUnlink(filePath);
  }

  // 清理 novel_chapters 中的文件
  const novelFiles = queryAll(db, 'SELECT file_path FROM novel_chapters');
  for (const ch of novelFiles) {
    const filePath = path.join(__dirname, '../../public', ch.file_path);
    await fsSafe.safeUnlink(filePath);
  }

  // 清理 images 表中的文件
  const imageFiles = queryAll(db, 'SELECT url AS file_path FROM images');
  for (const m of imageFiles) {
    const filePath = path.join(__dirname, '../../public', m.file_path);
    await fsSafe.safeUnlink(filePath);
  }

  // 2. 按依赖顺序删除所有业务数据表
  // 先删除有外键依赖的子表
  const dependentTables = [...DEPENDENT_TABLES];
  dependentTables.forEach(table => {
    try { db.run('DELETE FROM ' + table); } catch (e) { /* 表可能不存在 */ }
  });

  // 删除所有项目关联的表
  const allTables = getAllTablesToReset(db);
  allTables.forEach(table => {
    try { db.run('DELETE FROM ' + table); } catch (e) { /* 表可能不存在 */ }
  });

  // 删除其他独立表
  const extraTables = [
    'media', 'media_comments',
    'article_drafts', 'tags', 'content_tags', 'content_versions',
    'internal_messages', 'notifications', 'content_likes', 'user_follows',
    'poem_leaderboard',
    'activity_logs',
    'image_categories', 'image_configs', 'image_favorites', 'image_tags', 'image_tag_relations',
    'ai_conversations', 'ai_messages', 'ai_roles', 'ai_quota', 'ai_models', 'ai_settings',
    'ai_knowledge_docs', 'ai_knowledge_chunks'
  ];
  extraTables.forEach(table => {
    try { db.run('DELETE FROM ' + table); } catch (e) { /* 表可能不存在 */ }
  });

  // 删除普通用户（保留超级管理员）
  db.run("DELETE FROM users WHERE role != 'super_admin'");
  db.run('DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users)');

  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'reset',
    target_type: 'system',
    target_id: null,
    target_title: '全部数据',
    detail: '重置了所有站点数据（保留设置和超级管理员），删除 ' + totalDeletedFiles + ' 个文件',
    ip: req.ip
  });

  res.json({ success: true, message: '所有数据已重置（网站设置和超级管理员账户保留）' });
});

// ============ 完全恢复出厂设置（删除数据库文件） ============

router.get('/reset/factory', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  // 收集所有项目的统计数据
  const allProjectDefs = getAllProjectDefinitions(db);
  const projectStatsList = allProjectDefs.map(project => {
    const { stats, totalRecords } = getProjectStats(db, project.tables);
    return {
      id: project.id,
      name: project.name,
      icon: project.icon,
      description: project.description,
      tables: project.tables,
      file_dirs: project.file_dirs,
      stats,
      totalRecords
    };
  });

  // 全局统计
  const globalStats = {
    users: queryOne(db, "SELECT COUNT(*) as count FROM users WHERE role != 'super_admin'")?.count || 0,
    media: queryOne(db, 'SELECT COUNT(*) as count FROM media')?.count || 0,
    activity_logs: queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0,
    internal_messages: queryOne(db, 'SELECT COUNT(*) as count FROM internal_messages')?.count || 0,
    notifications: queryOne(db, 'SELECT COUNT(*) as count FROM notifications')?.count || 0,
    content_likes: queryOne(db, 'SELECT COUNT(*) as count FROM content_likes')?.count || 0,
    user_follows: queryOne(db, 'SELECT COUNT(*) as count FROM user_follows')?.count || 0,
    tags: queryOne(db, 'SELECT COUNT(*) as count FROM tags')?.count || 0,
    content_tags: queryOne(db, 'SELECT COUNT(*) as count FROM content_tags')?.count || 0,
    content_versions: queryOne(db, 'SELECT COUNT(*) as count FROM content_versions')?.count || 0,
    article_drafts: queryOne(db, 'SELECT COUNT(*) as count FROM article_drafts')?.count || 0
  };

  // 计算总记录数
  let totalRecords = 0;
  projectStatsList.forEach(p => { totalRecords += p.totalRecords; });
  Object.values(globalStats).forEach(v => { totalRecords += v; });

  // 包含超级管理员的总用户数
  const totalUsers = globalStats.users + 1;

  res.render('admin/reset-factory', {
    user: req.session.user,
    settings: res.locals.settings || {},
    projectStats: projectStatsList,
    globalStats: globalStats,
    totalRecords: totalRecords,
    totalUsers: totalUsers
  });
});

router.post('/reset/factory-execute', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: '请输入管理员密码' });
  }

  const admin = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(403).json({ success: false, error: '密码验证失败' });
  }

  try {
    const mediaFiles = queryAll(db, 'SELECT url AS file_path FROM images');
    for (const m of mediaFiles) {
      const filePath = path.join(__dirname, '../../public', m.file_path);
      await fsSafe.safeUnlink(filePath);
    }

    const novelFiles = queryAll(db, 'SELECT file_path FROM novel_chapters');
    for (const ch of novelFiles) {
      const filePath = path.join(__dirname, '../../public', ch.file_path);
      await fsSafe.safeUnlink(filePath);
    }

    const deletedCount = closeAndDeleteDatabase();

    req.session.destroy((err) => {
      if (err) {
        console.error('会话销毁失败:', err);
      }
    });

    res.json({
      success: true,
      message: '✅ 恢复出厂设置成功！数据库文件已被删除。',
      detail: '已删除 ' + deletedCount + ' 个数据库相关文件。所有数据已被清除，服务器需要重启以重新初始化数据库。',
      needReboot: true
    });
  } catch (err) {
    console.error('恢复出厂设置失败:', err);
    res.status(500).json({ success: false, error: '恢复出厂设置失败: ' + err.message });
  }
});

/**
 * 获取所有项目定义（优先从数据库读取，后备使用硬编码定义）
 */
function getAllProjectDefinitions(db) {
  let projects = [];
  try {
    const dbProjects = queryAll(db, 'SELECT * FROM projects WHERE is_active = 1 ORDER BY created_at ASC');
    if (dbProjects.length > 0) {
      projects = dbProjects.map(p => ({
        ...p,
        tables: JSON.parse(p.tables),
        file_dirs: JSON.parse(p.file_dirs || '[]')
      }));
    }
  } catch (e) { /* 忽略 */ }

  if (projects.length === 0) {
    projects = Object.values(PROJECT_DEFINITIONS);
  }

  return projects;
}

/**
 * 获取所有需要重置的业务数据表（去重）
 */
function getAllTablesToReset(db) {
  const projects = getAllProjectDefinitions(db);
  const tableSet = new Set();
  projects.forEach(p => {
    p.tables.forEach(t => tableSet.add(t));
  });
  // 排除依赖表（已单独处理）
  DEPENDENT_TABLES.forEach(t => tableSet.delete(t));
  return Array.from(tableSet);
}

module.exports = router;
