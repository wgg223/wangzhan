/**
 * 设置工具函数
 * 统一设置的读取、保存、缓存逻辑
 * 作用：封装 settings（站点设置）与 image_configs（图片分享配置）
 *       两张表的读写，并通过内存缓存（settingsCache）减少数据库查询，
 *       任何写入都会主动清除对应缓存保证数据一致性。
 */
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { settingsCache } = require('../config/cache');

/**
 * 获取所有设置（带缓存，60 秒 TTL）
 * @param {Object} db - 数据库实例
 * @returns {Object} key-value 对象，如 { site_name: 'xx', ... }
 * 说明：settings 表是 (setting_key, setting_value) 两列的键值表，
 *       这里一次性读出全部并转成 JS 对象缓存。
 */
function getSettings(db) {
  const cacheKey = 'settings:all';
  let settings = settingsCache.get(cacheKey);   // 先查缓存
  if (!settings) {
    try {
      const rows = queryAll(db, 'SELECT * FROM settings');
      settings = {};
      if (rows) rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
      settingsCache.set(cacheKey, settings);    // 写入缓存
    } catch (err) {
      console.error('[settings] 获取设置失败:', err.message);
      settings = {};                            // 失败时返回空对象，不阻塞页面
    }
  }
  return settings;
}

/**
 * 批量保存设置（upsert 模式：存在则更新，不存在则插入）
 * @param {Object} db - 数据库实例
 * @param {Object} settingsMap - key-value 对象（value 为 undefined 的键会被跳过）
 */
function upsertSettings(db, settingsMap) {
  for (const [key, value] of Object.entries(settingsMap)) {
    if (value !== undefined) {
      // 先查该键是否已存在
      const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
      if (existing) {
        db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);  // 更新
      } else {
        db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]); // 插入
      }
    }
  }
  saveDatabase();                       // 持久化
  settingsCache.delete('settings:all'); // 清除缓存，下次读取拿到新值
}

/**
 * 获取图片分享配置（带缓存）
 * @param {Object} db - 数据库实例
 * @returns {Object} key-value 对象
 * 说明：与 settings 同构，但数据在 image_configs 表。
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
 * @param {Object} db - 数据库实例
 * @param {Object} body - 请求体，包含各配置项（只处理白名单内的键）
 * 说明：
 *   - 只保存 configKeys 白名单中的字段，防止客户端塞入多余键；
 *   - 布尔型字段统一转成 '0'/'1' 字符串存储；
 *   - 数字型字段转字符串存储。
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
        value = String(value);                 // 数字字段转字符串
      } else {
        value = value || '';                   // 其他字段空值统一存空串
      }
      db.run('INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES (?, ?)', [key, value]);
    }
  }
  saveDatabase();
  settingsCache.delete('image_configs:all');   // 清除图片配置缓存
}

module.exports = { getSettings, upsertSettings, getImageConfigs, saveImageShareConfigs };
