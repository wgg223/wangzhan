const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { getProjectInfo, getProjectStats, cleanProjectFiles, deployFromGithub, getDeployStatus, isValidGithubUrl } = require('../../utils/project-utils');
const { PROJECT_DEFINITIONS, DEPENDENT_TABLES } = require('../../config/constants');

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
    return res.status(404).render('frontend/error', {
      message: '项目不存在',
      error: '',
      user: req.session.user,
      settings: res.locals.settings || {}
    });
  }

  res.render('admin/project-editor', {
    user: req.session.user,
    project: project,
    settings: res.locals.settings || {}
  });
});

// 项目列表页面
router.get('/projects', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

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
  } catch (e) { /* ignore */ }

  if (projects.length === 0) {
    projects = Object.values(PROJECT_DEFINITIONS);
  }

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

// 获取项目列表API
router.get('/projects/api/list', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

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
  } catch (e) { /* ignore */ }

  if (projects.length === 0) {
    projects = Object.values(PROJECT_DEFINITIONS);
  }

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

// 创建项目API
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

// 更新项目API
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

// 删除项目API
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

// 重置指定项目数据
router.post('/projects/api/:id/reset', isAuthenticated, isSuperAdmin, async (req, res) => {
  const db = req.db;
  const { password, confirm } = req.body;
  const projectId = req.params.id;

  if (!password) {
    return res.status(400).json({ success: false, error: '请输入管理员密码' });
  }

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

  const deletedFiles = await cleanProjectFiles(fileDirs);

  const dependentTables = tables.filter(t => DEPENDENT_TABLES.includes(t));
  const mainTables = tables.filter(t => !DEPENDENT_TABLES.includes(t));

  dependentTables.forEach(table => {
    try {
      const count = queryOne(db, 'SELECT COUNT(*) as count FROM ' + table);
      db.run('DELETE FROM ' + table);
      deletedRecords[table] = count ? count.count : 0;
    } catch (e) {
      console.error('重置项目 ' + projectId + ' - 删除表 ' + table + ' 失败:', e.message);
    }
  });

  mainTables.forEach(table => {
    try {
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

// 部署项目 - 从 GitHub 拉取代码
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

// 获取项目部署状态
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
