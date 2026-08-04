const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { queryOne, queryAll, getDb, saveDatabase, getDbPath } = require('../../config/database');
const { apiAuth, apiRequireAdmin } = require('../../middlewares/api-auth');

const router = express.Router();
router.use(apiAuth, apiRequireAdmin);

const projectRoot = path.join(__dirname, '../../..');
const backupDir = path.join(projectRoot, 'backups');

function toInt(v, def = 0) {
  const n = parseInt(v);
  return isNaN(n) ? def : n;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ============ 操作日志 ============
router.get('/logs', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const offset = (page - 1) * limit;

  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM activity_logs')?.count || 0;
  const rows = queryAll(db, `
    SELECT id, user_id, username, action, target_type, target_id, target_title, detail, ip, created_at
    FROM activity_logs ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  res.json({ logs: rows || [], total, page });
});

router.delete('/logs', (req, res) => {
  const db = getDb();
  const days = Math.min(3650, Math.max(1, toInt(req.query.days, 7)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.run('DELETE FROM activity_logs WHERE created_at < ?', [cutoff]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 权限管理 ============
router.get('/users/:id/permissions', (req, res) => {
  const db = getDb();
  const userId = toInt(req.params.id);
  const allPerms = queryAll(db, 'SELECT perm_key, perm_name, description FROM permissions ORDER BY id ASC');
  const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [userId]);
  const granted = new Set((userPerms || []).map((p) => p.perm_key));

  const permissions = (allPerms || []).map((p) => ({
    perm_key: p.perm_key,
    perm_name: p.perm_name,
    description: p.description || '',
    granted: granted.has(p.perm_key),
  }));
  res.json({ permissions });
});

router.put('/users/:id/permissions', (req, res) => {
  const db = getDb();
  const userId = toInt(req.params.id);
  const permKeys = Array.isArray(req.body.perm_keys) ? req.body.perm_keys.map((k) => String(k).slice(0, 64)) : [];

  const targetUser = queryOne(db, 'SELECT id, role FROM users WHERE id = ?', [userId]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 超级管理员的 user_permissions 统一禁止修改（超管权限不依赖该表）
  if (targetUser.role === 'super_admin') {
    return res.status(403).json({ error: '无权修改超级管理员的权限' });
  }
  // 不能操作自己
  if (targetUser.id === req.apiUser.id) {
    return res.status(400).json({ error: '不能操作自己的账号' });
  }

  // perm_key 必须真实存在于 permissions 表
  const validKeys = new Set(
    (queryAll(db, 'SELECT perm_key FROM permissions') || []).map((p) => p.perm_key)
  );
  const unknownKey = permKeys.find((k) => !validKeys.has(k));
  if (unknownKey) {
    return res.status(400).json({ error: '非法的权限项：' + unknownKey });
  }

  // 普通 admin 仅允许"纯撤销"：请求集必须 ⊆ 当前已拥有集（不可授予）
  if (req.apiUser.role !== 'super_admin') {
    const currentKeys = new Set(
      (queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [userId]) || [])
        .map((p) => p.perm_key)
    );
    const granting = permKeys.find((k) => !currentKeys.has(k));
    if (granting) {
      return res.status(403).json({ error: '仅超级管理员可授予权限' });
    }
  }

  db.run('DELETE FROM user_permissions WHERE user_id = ?', [userId]);
  for (const key of permKeys) {
    db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)', [userId, key, req.apiUser.id]);
  }
  saveDatabase();
  res.json({ success: true });
});

// ============ 媒体管理 ============
router.get('/media', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const offset = (page - 1) * limit;

  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM media')?.count || 0;
  const rows = queryAll(db, `
    SELECT m.*, u.username AS uploader_name
    FROM media m LEFT JOIN users u ON m.uploaded_by = u.id
    ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  res.json({ media: rows || [], total, page });
});

router.delete('/media/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const m = queryOne(db, 'SELECT * FROM media WHERE id = ?', [id]);
  if (m && m.file_path) {
    let rel = m.file_path;
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (rel.startsWith('public/')) rel = rel.slice(7);
    const filePath = path.join(projectRoot, rel);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
    } catch (e) { /* 忽略 */ }
  }
  db.run('DELETE FROM media WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 备份管理 ============
function getBackupList() {
  if (!fs.existsSync(backupDir)) return [];
  const backups = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.zip')) continue;
    const filePath = path.join(backupDir, name);
    try {
      const stat = fs.statSync(filePath);
      const type = name.startsWith('full-') ? 'full' : (name.startsWith('db-') ? 'database' : 'config');
      backups.push({
        name,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        type,
        sizeLabel: formatSize(stat.size),
      });
    } catch (e) { /* 忽略 */ }
  }
  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

router.get('/backups', (req, res) => {
  res.json({ backups: getBackupList() });
});

router.post('/backups', (req, res) => {
  const type = (req.body.type || 'database').toString();
  try {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = `${type === 'full' ? 'full' : 'db'}-${stamp}.zip`;
    const zip = new AdmZip();

    if (type === 'full') {
      // 完整备份：数据库 + 上传文件 + 配置
      if (fs.existsSync(getDbPath())) zip.addLocalFile(getDbPath(), 'database/');
      const uploadsDir = path.join(projectRoot, 'public/uploads');
      if (fs.existsSync(uploadsDir)) zip.addLocalFolder(uploadsDir, 'uploads');
      zip.addLocalFile(path.join(projectRoot, 'config.json'), '', 'config.json');
    } else {
      // 仅数据库
      if (fs.existsSync(getDbPath())) zip.addLocalFile(getDbPath(), '', 'database.sqlite');
    }
    zip.writeZip(path.join(backupDir, name));
    res.json({ success: true, name });
  } catch (e) {
    res.status(500).json({ error: '备份失败: ' + e.message });
  }
});

router.delete('/backups/:name', (req, res) => {
  const name = path.basename(req.params.name); // 防路径穿越
  const filePath = path.join(backupDir, name);
  if (!name.endsWith('.zip')) return res.status(400).json({ error: '无效的备份名' });
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  res.json({ success: true });
});

// ============ 系统信息 ============
router.get('/system/info', (req, res) => {
  const db = getDb();
  const dbSize = fs.existsSync(getDbPath()) ? fs.statSync(getDbPath()).size : 0;
  const uploadsDir = path.join(projectRoot, 'public/uploads');
  const uploadSize = fs.existsSync(uploadsDir)
    ? fs.readdirSync(uploadsDir, { recursive: true }).reduce((acc, f) => {
        try {
          const p = path.join(uploadsDir, f.toString());
          if (fs.statSync(p).isFile()) return acc + fs.statSync(p).size;
        } catch (e) { /* 忽略 */ }
        return acc;
      }, 0)
    : 0;
  const backupSize = getBackupList().reduce((acc, b) => acc + b.size, 0);

  let tableCount = 0;
  try {
    tableCount = queryAll(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").length;
  } catch (e) { /* 忽略 */ }

  const mem = process.memoryUsage();
  const totalMem = (mem.heapTotal / 1024 / 1024).toFixed(0) + ' MB';
  const uptime = formatDuration(process.uptime());

  res.json({
    platform: process.platform + ' / ' + process.arch,
    node_version: process.version,
    uptime,
    memory: totalMem,
    cpu: (osCpuCount() || 1) + ' 核',
    db_size: formatSize(dbSize),
    db_tables: tableCount,
    upload_size: formatSize(uploadSize),
    backup_size: formatSize(backupSize),
    cache_hit_rate: '-',
  });
});

function osCpuCount() {
  try {
    return require('os').cpus().length;
  } catch (e) { return null; }
}

function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}

// ============ 维护模式 ============
router.post('/maintenance/toggle', (req, res) => {
  const db = getDb();
  const enabled = req.body.enabled === true;
  const title = (req.body.title || '系统维护中').toString().slice(0, 100);
  const message = (req.body.message || '系统正在进行维护升级，请稍后再试。').toString().slice(0, 500);

  const upsert = (key, value) => {
    const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (existing) {
      db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
    } else {
      db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
    }
  };
  upsert('maintenance_mode', enabled ? 'true' : 'false');
  upsert('maintenance_title', title);
  upsert('maintenance_message', message);
  saveDatabase();

  try {
    const { settingsCache } = require('../../config/cache');
    settingsCache.delete('settings');
  } catch (e) { /* 忽略 */ }
  res.json({ success: true, enabled });
});

module.exports = router;
