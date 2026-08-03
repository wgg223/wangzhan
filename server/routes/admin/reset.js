const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, closeAndDeleteDatabase } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { getProjectStats, cleanProjectFiles, getAllProjectDefinitions } = require('../../utils/project-utils');
const { DEPENDENT_TABLES, ALL_TABLES } = require('../../config/constants');
const fsSafe = require('../../utils/fs-safe');

const PUBLIC_DIR = require('../../config/app-root').publicDir;

// 全局重置补充表：未包含在项目定义 / ALL_TABLES 中的业务表。
// 注意：这些表大多通过外键级联到 users，但显式清空更可靠，不依赖 foreign_keys 开关状态。
const EXTRA_RESET_TABLES = [
  'conversations', 'private_messages', 'user_message_settings',
  'user_oauth_bindings', 'permission_applications', 'article_attachments', 'api_tokens'
];

// 选择性重置的合法类型
const VALID_RESET_TYPES = ['users', 'content', 'media', 'social', 'logs', 'tags'];

/**
 * 将数据库中的相对路径（如 /uploads/xxx）解析为 public 目录内的绝对路径。
 * 防止 file_path 含 ../ 或绝对路径时删除 public 目录之外的文件。
 * @returns {string|null} 越界或非法时返回 null
 */
function safeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const rel = filePath.replace(/^[/\\]+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

/**
 * 按 SQL 查询出的文件路径字段逐一删除文件，返回删除数量
 */
async function deleteDbFiles(db, sql, pathColumn) {
  const rows = queryAll(db, sql);
  let deleted = 0;
  for (const row of rows) {
    const filePath = safeFilePath(row[pathColumn]);
    if (filePath && await fsSafe.safeUnlink(filePath)) {
      deleted++;
    }
  }
  return deleted;
}

/**
 * 收集所有项目的统计数据和全局统计
 */
function collectAllStats(db) {
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
    article_drafts: queryOne(db, 'SELECT COUNT(*) as count FROM article_drafts')?.count || 0,
    // 选择性重置页面使用的汇总计数（修正原先 content 项误显示媒体数的问题）
    content: queryOne(db, 'SELECT (SELECT COUNT(*) FROM articles) + (SELECT COUNT(*) FROM pages) + (SELECT COUNT(*) FROM comments) + (SELECT COUNT(*) FROM article_drafts) + (SELECT COUNT(*) FROM content_versions) AS count')?.count || 0,
    social: queryOne(db, 'SELECT (SELECT COUNT(*) FROM internal_messages) + (SELECT COUNT(*) FROM notifications) + (SELECT COUNT(*) FROM content_likes) + (SELECT COUNT(*) FROM user_follows) AS count')?.count || 0
  };

  let totalRecords = 0;
  projectStatsList.forEach(p => { totalRecords += p.totalRecords; });
  Object.values(globalStats).forEach(v => { totalRecords += v; });

  return { projectStatsList, globalStats, totalRecords };
}

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

  // 过滤非法类型，避免前端伪造任意 type
  const validTypes = types.filter(t => VALID_RESET_TYPES.includes(t));
  if (validTypes.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要重置的数据类型' });
  }

  const admin = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(403).json({ success: false, error: '密码验证失败' });
  }

  const results = [];

  try {
    // 用户数据
    if (validTypes.includes('users')) {
      db.run("DELETE FROM users WHERE role != 'super_admin'");
      db.run('DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users)');
      db.run('DELETE FROM user_follows');
      results.push('用户数据');
    }

    // 内容数据
    if (validTypes.includes('content')) {
      db.run('DELETE FROM articles');
      db.run('DELETE FROM pages');
      db.run('DELETE FROM comments');
      db.run('DELETE FROM article_drafts');
      db.run('DELETE FROM content_versions');
      results.push('内容数据');
    }

    // 媒体文件
    if (validTypes.includes('media')) {
      // 删除文件
      await deleteDbFiles(db, 'SELECT file_path FROM media', 'file_path');
      await deleteDbFiles(db, 'SELECT url AS file_path FROM images', 'file_path');
      await deleteDbFiles(db, 'SELECT file_path FROM article_attachments', 'file_path');
      db.run('DELETE FROM media');
      db.run('DELETE FROM images');
      db.run('DELETE FROM image_favorites');
      results.push('媒体文件');
    }

    // 社交数据
    if (validTypes.includes('social')) {
      db.run('DELETE FROM internal_messages');
      db.run('DELETE FROM notifications');
      db.run('DELETE FROM content_likes');
      db.run('DELETE FROM media_comments');
      db.run('DELETE FROM image_comments');
      results.push('社交数据');
    }

    // 日志数据
    if (validTypes.includes('logs')) {
      db.run('DELETE FROM activity_logs');
      results.push('日志数据');
    }

    // 标签数据
    if (validTypes.includes('tags')) {
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

router.get('/reset', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  const { projectStatsList, globalStats, totalRecords } = collectAllStats(db);

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

  // 清理 media / 小说章节 / 图片 / 文章附件中的文件
  totalDeletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM media', 'file_path');
  totalDeletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM novel_chapters', 'file_path');
  totalDeletedFiles += await deleteDbFiles(db, 'SELECT url AS file_path FROM images', 'file_path');
  totalDeletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM article_attachments', 'file_path');

  // 2. 按依赖顺序删除所有业务数据表
  // 先删除有外键依赖的子表
  const resetTables = new Set([
    ...DEPENDENT_TABLES,
    ...ALL_TABLES,
    ...EXTRA_RESET_TABLES,
    ...getAllTablesToReset(db)
  ]);
  // user_permissions 单独处理（需保留超级管理员的权限记录）
  resetTables.delete('user_permissions');

  const dependentTables = [...DEPENDENT_TABLES];
  dependentTables.forEach(table => {
    try { db.run('DELETE FROM ' + table); } catch (e) { /* 表可能不存在 */ }
  });

  // 删除其余业务表
  const otherTables = [...resetTables].filter(t => !DEPENDENT_TABLES.includes(t));
  otherTables.forEach(table => {
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

  const { projectStatsList, globalStats, totalRecords } = collectAllStats(db);

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
    // 与全局重置一致，先清理所有已上传文件（数据库删除后记录将消失，文件会成孤儿）
    let deletedFiles = 0;
    const allProjectDefs = getAllProjectDefinitions(db);
    for (const project of allProjectDefs) {
      deletedFiles += await cleanProjectFiles(project.file_dirs);
    }
    deletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM media', 'file_path');
    deletedFiles += await deleteDbFiles(db, 'SELECT url AS file_path FROM images', 'file_path');
    deletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM novel_chapters', 'file_path');
    deletedFiles += await deleteDbFiles(db, 'SELECT file_path FROM article_attachments', 'file_path');

    const deletedCount = closeAndDeleteDatabase();

    req.session.destroy((err) => {
      if (err) {
        console.error('会话销毁失败:', err);
      }
    });

    res.json({
      success: true,
      message: '✅ 恢复出厂设置成功！数据库文件已被删除。',
      detail: '已删除 ' + deletedCount + ' 个数据库相关文件，清理 ' + deletedFiles + ' 个上传文件。所有数据已被清除，服务器需要重启以重新初始化数据库。',
      needReboot: true
    });
  } catch (err) {
    console.error('恢复出厂设置失败:', err);
    res.status(500).json({ success: false, error: '恢复出厂设置失败: ' + err.message });
  }
});

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
