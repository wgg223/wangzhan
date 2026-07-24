/**
 * 设置工具函数
 * 统一设置的读取、保存、缓存逻辑
 */
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { settingsCache } = require('../config/cache');

/**
 * 获取所有设置（带缓存）
 * @param {Object} db
 * @returns {Object} key-value 对象
 */
function getSettings(db) {
  const cacheKey = 'settings:all';
  let settings = settingsCache.get(cacheKey);
  if (!settings) {
    try {
      const rows = queryAll(db, 'SELECT * FROM settings');
      settings = {};
      if (rows) rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
      settingsCache.set(cacheKey, settings);
    } catch (err) {
      console.error('[settings] 获取设置失败:', err.message);
      settings = {};
    }
  }
  return settings;
}

/**
 * 批量保存设置（upsert 模式：存在则更新，不存在则插入）
 * @param {Object} db
 * @param {Object} settingsMap - key-value 对象
 */
function upsertSettings(db, settingsMap) {
  for (const [key, value] of Object.entries(settingsMap)) {
    if (value !== undefined) {
      const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
      if (existing) {
        db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
      } else {
        db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
      }
    }
  }
  saveDatabase();
  settingsCache.delete('settings:all');
}

/**
 * 获取图片分享配置（带缓存）
 * @param {Object} db
 * @returns {Object} key-value 对象
 */
function getImageConfigs(db) {
  const cacheKey = 'image_configs:all';
  let configs = settingsCache.get(cacheKey);
  if (!configs) {
    try {
      const rows = queryAll(db, 'SELECT * FROM image_configs');
      configs = {};
      if (rows) rows.forEach(r => { configs[r.config_key] = r.config_value; });
      settingsCache.set(cacheKey, configs);
    } catch (err) {
      console.error('[settings] 获取图片配置失败:', err.message);
      configs = {};
    }
  }
  return configs;
}

/**
 * 批量保存图片分享配置（INSERT OR REPLACE）
 * @param {Object} db
 * @param {Object} body - 请求体，包含各配置项
 */
function saveImageShareConfigs(db, body) {
  const configKeys = [
    'site_name', 'site_description', 'site_logo', 'icp_number',
    'review_enabled', 'comment_enabled', 'comment_review_enabled',
    'guest_view_enabled', 'guest_upload_enabled', 'max_size',
    'allowed_formats', 'images_per_page', 'hot_images_count'
  ];

  for (const key of configKeys) {
    if (body[key] !== undefined) {
      let value = body[key];
      // 布尔字段转为 '0'/'1'
      if (['review_enabled', 'comment_enabled', 'comment_review_enabled',
        'guest_view_enabled', 'guest_upload_enabled'].includes(key)) {
        value = value ? '1' : '0';
      } else if (['max_size', 'images_per_page', 'hot_images_count'].includes(key)) {
        value = String(value);
      } else {
        value = value || '';
      }
      db.run('INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES (?, ?)', [key, value]);
    }
  }
  saveDatabase();
  settingsCache.delete('image_configs:all');
}

module.exports = { getSettings, upsertSettings, getImageConfigs, saveImageShareConfigs };
