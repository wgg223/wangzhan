/**
 * CDN配置文件
 * 用于管理静态资源CDN加速
 * 支持从数据库或环境变量读取配置
 */

const cdnConfig = {
  // 是否启用CDN
  enabled: false,

  // CDN服务商
  provider: 'custom',

  // CDN基础域名
  baseUrl: 'https://dalaowang233.top',

  // 原站域名
  originUrl: 'https://dalaowang233.top',

  // 静态资源版本号（用于缓存更新）
  version: '1.0.0',

  // 需要CDN加速的资源类型
  staticExtensions: ['.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.ico', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.eot'],

  // 不使用CDN的路径（如用户上传的动态内容）
  excludePaths: [
    '/uploads/',
    '/api/',
    '/admin/',
    '/auth/',
    '/setup/'
  ],

  // 从数据库加载配置
  loadFromDatabase(db) {
    try {
      // 使用queryAll函数（兼容better-sqlite3和sql.js）
      const { queryAll } = require('./server/config/db-helpers');
      const settings = queryAll(db, "SELECT setting_key, setting_value FROM settings WHERE setting_key IN (?, ?, ?, ?)", ['cdn_enabled', 'cdn_provider', 'cdn_base_url', 'cdn_version']);
      const settingsObj = {};
      settings.forEach(s => {
        settingsObj[s.setting_key] = s.setting_value;
      });

      this.enabled = settingsObj.cdn_enabled === '1';
      this.provider = settingsObj.cdn_provider || 'custom';
      this.baseUrl = settingsObj.cdn_base_url || 'https://dalaowang233.top';
      this.version = settingsObj.cdn_version || '1.0.0';
    } catch (err) {
      // 如果数据库查询失败，使用环境变量
      console.error('[CDN] 数据库加载失败，使用环境变量:', err.message);
      this.loadFromEnv();
    }
  },

  // 从环境变量加载配置
  loadFromEnv() {
    this.enabled = process.env.CDN_ENABLED === 'true' || false;
    this.provider = process.env.CDN_PROVIDER || 'custom';
    this.baseUrl = process.env.CDN_BASE_URL || 'https://dalaowang233.top';
    this.originUrl = process.env.ORIGIN_URL || 'https://dalaowang233.top';
    this.version = process.env.CDN_VERSION || '1.0.0';
  },

  // 获取CDN URL
  getUrl(path) {
    if (!this.enabled) {
      return path;
    }

    // 检查是否在排除路径中
    for (const excludePath of this.excludePaths) {
      if (path.startsWith(excludePath)) {
        return path;
      }
    }

    // 检查文件扩展名
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    if (!this.staticExtensions.includes(ext)) {
      return path;
    }

    // 构建CDN URL
    const separator = this.baseUrl.endsWith('/') ? '' : '/';

    return `${this.baseUrl}${separator}${path.replace(/^\//, '')}?v=${this.version}`;
  },

  // 获取资源URL（模板辅助函数）
  asset(path) {
    return this.getUrl(path);
  },

  // 获取配置信息
  getConfig() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      baseUrl: this.baseUrl,
      version: this.version
    };
  }
};

module.exports = cdnConfig;
