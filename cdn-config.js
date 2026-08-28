/**
 * CDN配置文件
 * 用于管理静态资源CDN加速
 * 支持从数据库或环境变量读取配置
 */

// 应用版本号：静态资源缓存破坏的默认版本（每次发版自动变化）
const appVersion = require('./package.json').version;

const cdnConfig = {
  // 是否启用CDN
  enabled: false,

  // CDN服务商
  provider: 'custom',

  // CDN基础域名（需在 .env 或后台设置中配置）
  baseUrl: '',

  // 原站域名（需在 .env 或后台设置中配置）
  originUrl: '',

  // 静态资源版本号（用于缓存更新；默认跟随应用版本，发版自动换版本）
  version: appVersion,

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
      const settings = queryAll(db, 'SELECT setting_key, setting_value FROM settings WHERE setting_key IN (?, ?, ?, ?)', ['cdn_enabled', 'cdn_provider', 'cdn_base_url', 'cdn_version']);
      const settingsObj = {};
      settings.forEach(s => {
        settingsObj[s.setting_key] = s.setting_value;
      });

      this.enabled = settingsObj.cdn_enabled === '1';
      this.provider = settingsObj.cdn_provider || 'custom';
      this.baseUrl = settingsObj.cdn_base_url || '';
      this.version = settingsObj.cdn_version || appVersion;
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
    this.baseUrl = process.env.CDN_BASE_URL || '';
    this.originUrl = process.env.ORIGIN_URL || '';
    this.version = process.env.CDN_VERSION || appVersion;
  },

  // 获取CDN URL
  getUrl(path) {
    // 排除路径不参与版本化（用户上传、接口等动态内容）
    for (const excludePath of this.excludePaths) {
      if (path.startsWith(excludePath)) {
        return path;
      }
    }

    // 检查文件扩展名
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    const isStatic = this.staticExtensions.includes(ext);

    if (!this.enabled) {
      // CDN 未启用时也追加应用版本号做缓存破坏，避免浏览器/边缘缓存旧版 JS/CSS
      // 直接用 appVersion（部署代码版本），不受后台 cdn_version 设置影响
      return isStatic ? `${path}?v=${appVersion}` : path;
    }

    if (!isStatic) {
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
