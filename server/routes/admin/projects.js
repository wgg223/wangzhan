/**
 * 项目管理路由（后台，仅超管）
 * 能力：
 *   GET  /admin/projects                  —— 项目列表页（含各表统计）
 *   GET  /admin/projects/new              —— 新建项目页
 *   GET  /admin/projects/edit/:id         —— 编辑项目页
 *   GET  /admin/projects/api/list         —— 项目列表 API
 *   GET  /admin/projects/api/:id/stats    —— 单项目统计 API
 *   POST /admin/projects/api/create       —— 创建项目（ID 格式校验 + 唯一性）
 *   PUT  /admin/projects/api/:id/update   —— 更新项目
 *   DELETE /admin/projects/api/:id/delete —— 删除项目定义（数据不清理）
 *   POST /admin/projects/api/:id/reset    —— 重置项目数据（需管理员密码 + 输入确认词；system 项目禁止）
 *   POST /admin/projects/api/:id/deploy   —— 从 GitHub 拉取部署（URL 格式白名单校验）
 *   GET  /admin/projects/api/:id/deploy-status —— 部署状态查询
 * 安全要点：重置/部署均需密码二次验证；表名经 isAllowedTable 白名单校验后再拼接 SQL，防注入。
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { getProjectInfo, getProjectStats, cleanProjectFiles, deployFromGithub, getDeployStatus, isValidGithubUrl, getAllProjectDefinitions, isAllowedTable } = require('../../utils/project-utils');
const { DEPENDENT_TABLES } = require('../../config/constants');
const { renderError } = require('../../utils/response');

// ============ 项目管理 ============

// 创建项目页面（GET）
router.get('/projects/new', isAuthenticated, isSuperAdmin, (req, res) => {
  res.render('admin/project-editor', {
    user: req.session.user,
    project: null,
    settings: res.locals.settings || {}
  });
});

// 编辑项目页面（GET）
router.get('/projects/edit/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const project = getProjectInfo(db, req.params.id);

  if (!project) {
    return renderError(res, 404, '项目不存在', req);
  }

  res.render('admin/project-editor', {
    user: req.session.user,
    project: project,
    settings: res.locals.settings || {}
  });
});

// 项目列表页面：为每个项目附加各表统计与总记录数
router.get('/projects', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  const projects = getAllProjectDefinitions(db);

  const projectsWithStats = projects.map(project => {
    const { stats, totalRecords } = getProjectStats(db, project.tables);
    return {
      ...project,
      stats,
      totalRecords,
      tables: project.tables
    };
  });

  res.render('admin/projects', {
    user: req.session.user,
    projects: projectsWithStats,
    settings: res.locals.settings || {}
  });
});

// 获取项目列表API（JSON）
router.get('/projects/api/list', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  const projects = getAllProjectDefinitions(db);

  const projectsWithStats = projects.map(project => {
    const { stats, totalRecords } = getProjectStats(db, project.tables);
    return { ...project, stats, totalRecords };
  });

  res.json({ success: true, projects: projectsWithStats });
});

// 获取单个项目统计API
router.get('/projects/api/:id/stats', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const project = getProjectInfo(db, req.params.id);

  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  const { stats, totalRecords } = getProjectStats(db, project.tables);

  res.json({
    success: true,
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      icon: project.icon,
      stats,
      totalRecords
    }
  });
});

// 创建项目API：ID 只允许字母数字下划线连字符
router.post('/projects/api/create', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const { id, name, description, tables, file_dirs, icon, github_url } = req.body;

  if (!id || !name) {
    return res.status(400).json({ success: false, error: '项目ID和名称不能为空' });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ success: false, error: '项目ID只能包含字母、数字、下划线和连字符' });
  }

  const existing = queryOne(db, 'SELECT id FROM projects WHERE id = ?', [id]);
  if (existing) {
    return res.status(400).json({ success: false, error: '项目ID已存在' });
  }

  try {
    // tables/file_dirs 以 JSON 文本存储
    db.run(
      'INSERT INTO projects (id, name, description, tables, file_dirs, icon, github_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [id, name, description || '', JSON.stringify(tables || []), JSON.stringify(file_dirs || []), icon || '📦', github_url || '']
    );
    saveDatabase();

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'create',
      target_type: 'project',
      target_id: id,
      target_title: name,
      detail: '创建项目：' + name + ' (' + id + ')',
      ip: req.ip
    });

    res.json({ success: true, message: '项目「' + name + '」创建成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: '创建项目失败: ' + err.message });
  }
});

// 更新项目API（未传字段保留原值）
router.put('/projects/api/:id/update', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const { name, description, tables, file_dirs, icon, github_url } = req.body;
  const projectId = req.params.id;

  const project = queryOne(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  try {
    db.run(
      'UPDATE projects SET name = ?, description = ?, tables = ?, file_dirs = ?, icon = ?, github_url = ? WHERE id = ?',
      [
        name || project.name,
        description !== undefined ? description : project.description,
        tables ? JSON.stringify(tables) : project.tables,
        file_dirs ? JSON.stringify(file_dirs) : project.file_dirs,
        icon || project.icon,
        github_url !== undefined ? github_url : project.github_url,
        projectId
      ]
    );
    saveDatabase();

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'update',
      target_type: 'project',
      target_id: projectId,
      target_title: name || project.name,
      detail: '更新项目：' + (name || project.name),
      ip: req.ip
    });

    res.json({ success: true, message: '项目「' + (name || project.name) + '」更新成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: '更新项目失败: ' + err.message });
  }
});

// 删除项目API（仅删除定义，不清理数据）
router.delete('/projects/api/:id/delete', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const projectId = req.params.id;

  const project = queryOne(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  try {
    db.run('DELETE FROM projects WHERE id = ?', [projectId]);
    saveDatabase();

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'delete',
      target_type: 'project',
      target_id: projectId,
      target_title: project.name,
      detail: '删除项目定义：' + project.name + '（注意：项目数据未被清除）',
      ip: req.ip
    });

    res.json({ success: true, message: '项目「' + project.name + '」已删除（数据未清除）' });
  } catch (err) {
    res.status(500).json({ success: false, error: '删除项目失败: ' + err.message });
  }
});

// 重置指定项目数据：需管理员密码 + 确认词；先删文件，再按依赖表/主表顺序清空
router.post('/projects/api/:id/reset', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const { password, confirm } = req.body;
  const projectId = req.params.id;

  if (!password) {
    return res.status(400).json({ success: false, error: '请输入管理员密码' });
  }

  // 密码二次验证（防止 CSRF/越权触发危险操作）
  const admin = queryOne(db, 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(403).json({ success: false, error: '密码验证失败' });
  }

  if (confirm !== '确认重置') {
    return res.status(400).json({ success: false, error: '请输入「确认重置」' });
  }

  const project = getProjectInfo(db, projectId);
  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  if (projectId === 'system') {
    return res.status(400).json({ success: false, error: '系统核心项目不允许重置' });
  }

  const tables = project.tables;
  const fileDirs = project.file_dirs;
  const deletedRecords = {};

  // 先清理项目关联的上传文件
  const deletedFiles = await cleanProjectFiles(fileDirs);

  // 依赖表（子表）先删，主表后删，避免外键约束失败
  const dependentTables = tables.filter(t => DEPENDENT_TABLES.includes(t));
  const mainTables = tables.filter(t => !DEPENDENT_TABLES.includes(t));

  dependentTables.forEach(table => {
    try {
      if (!isAllowedTable(table)) throw new Error('非法表名: ' + table);
      const count = queryOne(db, 'SELECT COUNT(*) as count FROM ' + table);
      db.run('DELETE FROM ' + table);
      deletedRecords[table] = count ? count.count : 0;
    } catch (e) {
      console.error('重置项目 ' + projectId + ' - 删除表 ' + table + ' 失败:', e.message);
    }
  });

  mainTables.forEach(table => {
    try {
      if (!isAllowedTable(table)) throw new Error('非法表名: ' + table);
      const count = queryOne(db, 'SELECT COUNT(*) as count FROM ' + table);
      db.run('DELETE FROM ' + table);
      deletedRecords[table] = count ? count.count : 0;
    } catch (e) {
      console.error('重置项目 ' + projectId + ' - 删除表 ' + table + ' 失败:', e.message);
    }
  });

  saveDatabase();

  const totalDeleted = Object.values(deletedRecords).reduce((a, b) => a + b, 0);
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'reset',
    target_type: 'project',
    target_id: projectId,
    target_title: project.name,
    detail: '重置了项目「' + project.name + '」，删除 ' + totalDeleted + ' 条记录，' + deletedFiles + ' 个文件',
    ip: req.ip
  });

  res.json({ success: true, message: project.name + '已重置', deletedRecords, deletedFiles });
});

// ============ GitHub 部署相关 ============

// 部署项目 - 从 GitHub 拉取代码（URL 格式白名单校验）
router.post('/projects/api/:id/deploy', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const projectId = req.params.id;
  const { github_url } = req.body;

  const project = getProjectInfo(db, projectId);
  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  const url = github_url || project.github_url;
  if (!url) {
    return res.status(400).json({ success: false, error: '请提供 GitHub 仓库 URL' });
  }

  if (!isValidGithubUrl(url)) {
    return res.status(400).json({ success: false, error: '无效的 GitHub 仓库 URL，格式应为: https://github.com/owner/repo' });
  }

  try {
    const result = await deployFromGithub(db, projectId, url);

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'deploy',
      target_type: 'project',
      target_id: projectId,
      target_title: project.name,
      detail: result.success
        ? '部署项目「' + project.name + '」成功'
        : '部署项目「' + project.name + '」失败: ' + result.message.substring(0, 100),
      ip: req.ip
    });

    if (result.success) {
      res.json({ success: true, message: result.message, output: result.output });
    } else {
      res.status(500).json({ success: false, error: result.message, output: result.output });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: '部署失败: ' + (err.message || '未知错误') });
  }
});

// 获取项目部署状态（含内存中的部署进度）
router.get('/projects/api/:id/deploy-status', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const projectId = req.params.id;

  const project = getProjectInfo(db, projectId);
  if (!project) {
    return res.status(404).json({ success: false, error: '项目不存在' });
  }

  const deployInfo = getDeployStatus(projectId);

  res.json({
    success: true,
    deploy_status: project.deploy_status || 'none',
    github_url: project.github_url || '',
    ...deployInfo
  });
});

module.exports = router;
