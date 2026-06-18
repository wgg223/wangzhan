const { queryAll } = require('../config/database');
const { settingsCache } = require('../config/cache');

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

module.exports = { getSettings, getImageConfigs };
