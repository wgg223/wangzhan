const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { testSmtpConfig } = require('../../config/mailer');
const { encrypt } = require('../../config/crypto-secure');
const { settingsCache } = require('../../config/cache');
const { upload } = require('./upload');
const cdnConfig = require('../../../cdn-config');

// ============ 网站设置 ============

router.get('/settings', isAuthenticated, hasPermission('settings.manage'), (req, res) => {
  const db = req.db;
  const settings = queryAll(db, 'SELECT * FROM settings');
  const settingsObj = {};
  settings.forEach(s => {
    settingsObj[s.setting_key] = s.setting_value;
  });

  // 获取用户权限
  const userPermissions = queryAll(db, 'SELECT permission_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
  const permissions = userPermissions.map(p => p.permission_key);

  res.render('admin/settings', {
    user: req.session.user,
    settings: settingsObj,
    success: req.query.success === '1',
    userPermissions: permissions
  });
});

router.post('/settings', isAuthenticated, hasPermission('settings.manage'), (req, res) => {
  const db = req.db;
  const { site_name, site_description, icp_number, icp_link, footer_text, logo, user_agreement, privacy_policy, delete_account_agreement, welcome_popup_enabled, welcome_popup_title, welcome_popup_content } = req.body;

  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [site_name || '', 'site_name']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [site_description || '', 'site_description']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [icp_number || '', 'icp_beian']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.police_beian || '', 'police_beian']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [icp_number || '', 'icp_number']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [icp_link || 'https://beian.miit.gov.cn/', 'icp_link']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [footer_text || '', 'footer_text']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [logo || '', 'logo']);
  // 保存用户协议与隐私政策
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [user_agreement || '', 'user_agreement']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [privacy_policy || '', 'privacy_policy']);
  // 保存账户注销协议
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [delete_account_agreement || '', 'delete_account_agreement']);

  // 保存站内信弹窗设置
  const popupEnabled = req.body.message_popup_enabled === '1' ? '1' : '0';
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['message_popup_enabled', popupEnabled]);

  // 保存欢迎弹窗设置
  const welcomePopupEnabled = req.body.welcome_popup_enabled === '1' ? '1' : '0';
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['welcome_popup_enabled', welcomePopupEnabled]);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [welcome_popup_title || '欢迎访问', 'welcome_popup_title']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [welcome_popup_content || '', 'welcome_popup_content']);

  // 保存SMTP配置
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_host || '', 'smtp_host']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_port || '465', 'smtp_port']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_secure || 'true', 'smtp_secure']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_user || '', 'smtp_user']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [encrypt(req.body.smtp_pass || ''), 'smtp_pass']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_from_name || '', 'smtp_from_name']);
  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [req.body.smtp_from_email || '', 'smtp_from_email']);

  // 保存CDN配置
  const cdnEnabled = req.body.cdn_enabled === '1' ? '1' : '0';
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['cdn_enabled', cdnEnabled]);
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['cdn_provider', req.body.cdn_provider || 'custom']);
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['cdn_base_url', req.body.cdn_base_url || 'https://dalaowang233.top']);
  db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', ['cdn_version', req.body.cdn_version || '1.0.0']);

  saveDatabase();
  settingsCache.delete('settings');

  // 重新加载CDN配置
  cdnConfig.loadFromDatabase(db);

  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'settings', target_id: null, target_title: '网站设置', detail: '更新了网站基本设置、SMTP配置和CDN配置', ip: req.ip });
  res.redirect('/admin/settings?success=1');
});

// ============ SMTP 配置测试 ============

// 测试SMTP连接
router.post('/settings/test-smtp', isAuthenticated, hasPermission('settings.manage'), async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass } = req.body;

  if (!smtp_host || !smtp_user || !smtp_pass) {
    return res.status(400).json({ success: false, error: '请填写完整的SMTP配置信息（服务器地址、用户名、密码）' });
  }

  try {
    const result = await testSmtpConfig({
      host: smtp_host,
      port: parseInt(smtp_port) || 465,
      secure: smtp_secure === 'true' || smtp_port === '465',
      user: smtp_user,
      pass: smtp_pass
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============ CDN 配置测试 ============

// 测试CDN连接
router.post('/settings/test-cdn', isAuthenticated, hasPermission('settings.manage'), async (req, res) => {
  const { cdn_base_url } = req.body;

  if (!cdn_base_url) {
    return res.status(400).json({ success: false, error: '请填写CDN域名' });
  }

  const https = require('https');
  const http = require('http');
  const url = require('url');

  try {
    const parsedUrl = new URL(cdn_base_url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const testUrl = `${cdn_base_url}/css/style.css`;

    const result = await new Promise((resolve, reject) => {
      const req = protocol.get(testUrl, { timeout: 10000 }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            cacheStatus: response.headers['cf-cache-status'] || response.headers['x-cache-status'] || 'N/A',
            server: response.headers['server'] || 'N/A'
          });
        });
      });

      req.on('error', (error) => {
        reject(new Error(`连接失败: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('连接超时'));
      });
    });

    const isCloudflare = result.server === 'cloudflare';
    const message = `CDN连接成功${isCloudflare ? '（Cloudflare）' : ''}，状态码: ${result.statusCode}，缓存状态: ${result.cacheStatus}`;

    res.json({ success: true, message: message });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/upload-background', isAuthenticated, hasPermission('settings.manage'), upload.single('background'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const db = req.db;
  const filePath = '/uploads/' + req.file.filename;

  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [filePath, 'background_image']);

  saveDatabase();
  res.json({ success: true, path: filePath });
});

router.post('/upload-logo', isAuthenticated, hasPermission('settings.manage'), upload.single('logo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const db = req.db;
  const filePath = '/uploads/' + req.file.filename;

  db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [filePath, 'logo']);

  saveDatabase();
  res.json({ success: true, path: filePath });
});

// ============ 系统配置备份与恢复 ============
const fs = require('fs');
const path = require('path');

router.get('/settings/backup', isAuthenticated, hasPermission('data.manage'), (req, res) => {
  const db = req.db;
  try {
    const settings = queryAll(db, 'SELECT * FROM settings');
    const backupDir = path.join(__dirname, '../../../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `settings-backup-${timestamp}.json`;
    const filepath = path.join(backupDir, filename);

    const backupData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      exportedBy: req.session.user.username,
      settings: settings
    };

    fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2), 'utf-8');

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'backup',
      target_type: 'settings',
      detail: '创建系统配置备份: ' + filename,
      ip: req.ip
    });

    res.json({ success: true, message: '配置备份成功', filename: filename, filepath: filepath });
  } catch (err) {
    res.status(500).json({ error: '备份失败: ' + err.message });
  }
});

router.get('/settings/backup/list', isAuthenticated, hasPermission('data.manage'), (req, res) => {
  const backupDir = path.join(__dirname, '../../../backups');
  try {
    if (!fs.existsSync(backupDir)) {
      return res.json({ success: true, backups: [] });
    }
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('settings-backup-') && f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return {
          filename: f,
          size: stats.size,
          createdAt: stats.birthtime || stats.mtime
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, backups: files });
  } catch (err) {
    res.status(500).json({ error: '获取备份列表失败: ' + err.message });
  }
});

router.post('/settings/backup/restore', isAuthenticated, hasPermission('data.manage'), (req, res) => {
  const db = req.db;
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).json({ error: '请指定备份文件' });
  }

  const backupDir = path.join(__dirname, '../../../backups');
  const filepath = path.join(backupDir, filename);

  // 安全检查：防止路径遍历
  if (!filepath.startsWith(backupDir)) {
    return res.status(400).json({ error: '无效的备份文件路径' });
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '备份文件不存在' });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    if (!data.settings || !Array.isArray(data.settings)) {
      return res.status(400).json({ error: '备份文件格式无效' });
    }

    let restored = 0;
    db.run('BEGIN TRANSACTION');
    try {
      data.settings.forEach(function(setting) {
        if (setting.setting_key && setting.setting_value !== undefined) {
          db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?',
            [setting.setting_value, setting.setting_key]);
          restored++;
        }
      });
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      throw e;
    }

    saveDatabase();
    settingsCache.delete('settings');

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'restore',
      target_type: 'settings',
      detail: '从备份恢复配置: ' + filename + ' (恢复 ' + restored + ' 项)',
      ip: req.ip
    });

    res.json({ success: true, message: '配置恢复成功', restored: restored });
  } catch (err) {
    res.status(500).json({ error: '恢复失败: ' + err.message });
  }
});

router.delete('/settings/backup/:filename', isAuthenticated, hasPermission('data.manage'), (req, res) => {
  const backupDir = path.join(__dirname, '../../../backups');
  const filename = req.params.filename;
  const filepath = path.join(backupDir, filename);

  if (!filepath.startsWith(backupDir)) {
    return res.status(400).json({ error: '无效的备份文件路径' });
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '备份文件不存在' });
  }

  try {
    fs.unlinkSync(filepath);
    res.json({ success: true, message: '备份文件已删除' });
  } catch (err) {
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
});

module.exports = router;
