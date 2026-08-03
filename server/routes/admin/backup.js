const express = require('express');
const router = express.Router();
const { logActivity } = require('../../config/activity');
const fs = require('fs');
const path = require('path');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { dbUpload } = require('./upload');
const { closeDatabase, getDbPath } = require('../../config/database');
const { formatBytes } = require('../../utils/format');
const { getDirSize, copyDir, removeDir } = require('../../utils/fs-helpers');

const projectRoot = require('../../config/app-root').projectRoot;
const backupDir = path.join(projectRoot, 'backups');

// Ensure backup directory exists
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// GET - Backup management page
router.get('/backup', isAuthenticated, isSuperAdmin, (req, res) => {
  const backups = getBackupList();
  res.render('admin/backup', {
    user: req.session.user,
    userPermissions: res.locals.userPermissions || [],
    backups
  });
});

// GET - List backups
router.get('/backup/list', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const backups = getBackupList();
    res.json({ success: true, data: backups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST - Create backup
router.post('/backup/create', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const { type = 'full', name } = req.body;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = name || `backup-${type}-${timestamp}`;
    const backupPath = path.join(backupDir, backupName);

    fs.mkdirSync(backupPath, { recursive: true });

    const itemsToBackup = [];

    if (type === 'full' || type === 'database') {
      itemsToBackup.push({ src: path.join(projectRoot, 'database.sqlite'), dest: path.join(backupPath, 'database.sqlite'), name: 'database.sqlite' });
    }

    if (type === 'full' || type === 'uploads') {
      const uploadsDir = path.join(projectRoot, 'public', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        await copyDir(uploadsDir, path.join(backupPath, 'uploads'));
        itemsToBackup.push({ src: uploadsDir, dest: path.join(backupPath, 'uploads'), name: 'uploads/' });
      }
    }

    if (type === 'full' || type === 'config') {
      const configFiles = ['package.json', 'ecosystem.config.js', '.env'];
      for (const file of configFiles) {
        const src = path.join(projectRoot, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(backupPath, file));
          itemsToBackup.push({ src, dest: path.join(backupPath, file), name: file });
        }
      }
    }

    if (type === 'full') {
      const dirsToBackup = ['server', 'views', 'public/css', 'public/js'];
      for (const dir of dirsToBackup) {
        const src = path.join(projectRoot, dir);
        if (fs.existsSync(src)) {
          await copyDir(src, path.join(backupPath, dir));
          itemsToBackup.push({ src, dest: path.join(backupPath, dir), name: dir + '/' });
        }
      }
    }

    // Create metadata
    const meta = {
      name: backupName,
      type,
      createdAt: new Date().toISOString(),
      createdBy: req.session.user.username,
      items: itemsToBackup.map(i => i.name)
    };
    fs.writeFileSync(path.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, 2));

    // Log activity
    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'create_backup',
        target_type: 'system',
        target_title: '系统备份',
        detail: `创建${type === 'full' ? '完整' : type}备份: ${backupName}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[backup] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: `备份创建成功: ${backupName}`,
      backup: meta
    });
  } catch (err) {
    console.error('[backup] Create backup error:', err);
    res.status(500).json({ success: false, error: '备份创建失败: ' + err.message });
  }
});

// POST - Restore backup
router.post('/backup/restore', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const { backupName, components } = req.body;

    if (!backupName) {
      return res.status(400).json({ success: false, error: '缺少备份名称' });
    }

    const backupPath = path.join(backupDir, backupName);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: '备份不存在' });
    }

    // Read metadata
    const metaPath = path.join(backupPath, 'backup-meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }

    const restoreList = components || meta.items || [];

    for (const item of restoreList) {
      const srcPath = path.join(backupPath, item);
      const destPath = path.join(projectRoot, item);

      if (!fs.existsSync(srcPath)) continue;

      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        await copyDir(srcPath, destPath);
      } else {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
      }
    }

    // Log activity
    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'restore_backup',
        target_type: 'system',
        target_title: '系统恢复',
        detail: `从备份恢复: ${backupName}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[backup] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: `备份恢复成功: ${backupName}，建议重启服务器`
    });
  } catch (err) {
    console.error('[backup] Restore backup error:', err);
    res.status(500).json({ success: false, error: '备份恢复失败: ' + err.message });
  }
});

// POST - Upload and restore database from local file
router.post('/backup/upload-restore', isAuthenticated, isSuperAdmin, (req, res) => {
  dbUpload.single('dbfile')(req, res, function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: '文件大小超出限制（最大200MB）' });
      }
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: '请选择数据库文件' });
    }

    try {
      const uploadedPath = req.file.path;
      const dbPath = getDbPath();
      const backupCurrentPath = dbPath + '.bak.' + Date.now();

      // 备份当前数据库
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, backupCurrentPath);
      }

      // 关闭当前数据库连接
      closeDatabase();

      // 替换数据库文件
      fs.copyFileSync(uploadedPath, dbPath);

      // 清理临时文件
      try { fs.unlinkSync(uploadedPath); } catch (e) { /* ignore */ }
      // 清理 tmp 目录（如果为空）
      const tmpDir = path.dirname(uploadedPath);
      try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }

      // 记录日志
      try {
        logActivity(req.db, {
          user_id: req.session.user.id,
          username: req.session.user.username,
          action: 'restore_backup',
          target_type: 'system',
          target_title: '上传恢复数据库',
          detail: `从本地上传文件恢复数据库: ${req.file.originalname}，已备份为 ${path.basename(backupCurrentPath)}`,
          ip: req.ip
        });
      } catch (logErr) {
        console.error('[backup] logActivity error:', logErr.message);
      }

      res.json({
        success: true,
        message: '数据库已替换成功，请重启服务器以加载新数据。当前数据库已备份为 ' + path.basename(backupCurrentPath)
      });
    } catch (err) {
      console.error('[backup] Upload restore error:', err);
      res.status(500).json({ success: false, error: '上传恢复失败: ' + err.message });
    }
  });
});

// DELETE - Delete backup
router.delete('/backup/:name', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const backupName = req.params.name;
    // 防路径穿越：仅允许安全字符的备份名，且解析后必须位于 backupDir 内
    if (!/^[A-Za-z0-9._-]+$/.test(backupName)) {
      return res.status(400).json({ success: false, error: '非法备份名称' });
    }
    const backupPath = path.resolve(backupDir, backupName);
    if (backupPath !== backupDir && !backupPath.startsWith(backupDir + path.sep)) {
      return res.status(400).json({ success: false, error: '非法备份名称' });
    }

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: '备份不存在' });
    }

    await removeDir(backupPath);

    // Log activity
    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'delete_backup',
        target_type: 'system',
        target_title: '删除备份',
        detail: `删除备份: ${backupName}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[backup] logActivity error:', logErr.message);
    }

    res.json({ success: true, message: `备份已删除: ${backupName}` });
  } catch (err) {
    res.status(500).json({ success: false, error: '删除备份失败: ' + err.message });
  }
});

// GET - Download backup (creates zip)
router.get('/backup/:name/download', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const backupName = req.params.name;
    // 防路径穿越：与删除接口一致的白名单 + 目录包含校验
    if (!/^[A-Za-z0-9._-]+$/.test(backupName)) {
      return res.status(400).json({ success: false, error: '非法备份名称' });
    }
    const backupPath = path.resolve(backupDir, backupName);
    if (backupPath !== backupDir && !backupPath.startsWith(backupDir + path.sep)) {
      return res.status(400).json({ success: false, error: '非法备份名称' });
    }

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: '备份不存在' });
    }

    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addLocalFolder(backupPath, backupName);

    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${backupName}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ success: false, error: '下载备份失败: ' + err.message });
  }
});

// GET - 系统更新自动备份列表（项目根目录 backup_* 目录）
router.get('/backup/update-backups', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const updateBackups = [];
    let items = [];
    try {
      items = fs.readdirSync(projectRoot);
    } catch (e) { /* ignore */ }

    for (const item of items) {
      if (!/^backup_\d+$/.test(item)) continue;
      const itemPath = path.join(projectRoot, item);
      let stat;
      try {
        stat = fs.statSync(itemPath);
      } catch (e) { continue; }
      if (!stat.isDirectory()) continue;

      let size = 0;
      try { size = getDirSize(itemPath); } catch (e) { /* ignore */ }

      updateBackups.push({
        name: item,
        createdAt: new Date(stat.mtime).toISOString(),
        size,
        sizeFormatted: formatSize(size)
      });
    }

    updateBackups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: updateBackups });
  } catch (err) {
    res.status(500).json({ success: false, error: '获取更新自动备份失败: ' + err.message });
  }
});

// DELETE - 删除系统更新自动备份
router.delete('/backup/update-backup/:name', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const backupName = req.params.name;
    // 防路径穿越：仅允许 backup_<时间戳> 格式
    if (!/^backup_\d+$/.test(backupName)) {
      return res.status(400).json({ success: false, error: '非法备份名称' });
    }

    const backupPath = path.join(projectRoot, backupName);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: '备份不存在' });
    }

    await removeDir(backupPath);

    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'delete_backup',
        target_type: 'system',
        target_title: '删除更新自动备份',
        detail: `删除系统更新自动备份: ${backupName}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[backup] logActivity error:', logErr.message);
    }

    res.json({ success: true, message: `备份已删除: ${backupName}` });
  } catch (err) {
    res.status(500).json({ success: false, error: '删除备份失败: ' + err.message });
  }
});

// Helper functions
function getBackupList() {
  const backups = [];
  if (!fs.existsSync(backupDir)) return backups;

  const items = fs.readdirSync(backupDir);
  for (const item of items) {
    const itemPath = path.join(backupDir, item);
    if (!fs.statSync(itemPath).isDirectory()) continue;

    const metaPath = path.join(itemPath, 'backup-meta.json');
    let meta = { name: item, type: 'unknown', createdAt: 'unknown' };

    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) { /* ignore */ }
    }

    // Calculate size
    let size = 0;
    try {
      size = getDirSize(itemPath);
    } catch (e) { /* ignore */ }

    backups.push({
      ...meta,
      size,
      sizeFormatted: formatSize(size)
    });
  }

  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function formatSize(bytes) {
  return formatBytes(bytes);
}

module.exports = router;
