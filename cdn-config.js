/**
 * CDN配置文件
 * 用于管理静态资源CDN加速
 * 支持从数据库或环境变量读取配置
 *
 * 版本号机制：
 *   - 默认跟随应用版本（package.json version），发版自动更换版本号 → CDN/浏览器缓存自动失效；
 *   - 后台显式修改过版本号（且非历史遗留默认值 1.0.0）时，以后台值为准。
 */

// 应用版本号：静态资源缓存破坏的默认版本（每次发版自动变化）
const appVersion = require('./package.json').version;

// 历史种子默认版本号：视为「未显式配置」，自动回退到应用版本
const LEGACY_DEFAULT_VERSION = '1.0.0';

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
      // 历史遗留默认值 1.0.0 视为「未显式配置」，自动跟随应用版本（发版即换版本号，缓存自动失效）
      this.version = settingsObj.cdn_version && settingsObj.cdn_version !== LEGACY_DEFAULT_VERSION
        ? settingsObj.cdn_version
        : appVersion;
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

  /**
   * 判断路径是否应走 CDN 加速
   * 规则：排除外链（http/https/协议相对）→ 排除动态路径（uploads/api/admin/auth/setup）
   *       → 排除非静态扩展名（扩展名忽略查询串影响）
   * @param {string} path - 资源路径（如 /css/style.css）
   * @returns {boolean}
   */
  isStatic(path) {
    if (!path || typeof path !== 'string') return false;
    // 外链（http/https/data/blob/协议相对）不处理，原样返回
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith('/')) return false;
    if (path.startsWith('//')) return false;
    // 排除动态路径
    for (const excludePath of this.excludePaths) {
      if (path.startsWith(excludePath)) return false;
    }
    // 提取扩展名（截掉查询串/锚点，避免 ?v= 干扰判断）
    const dot = path.lastIndexOf('.');
    const ext = dot > 0 ? path.substring(dot).split(/[?#]/)[0].toLowerCase() : '';
    return this.staticExtensions.includes(ext);
  },

  /**
   * 幂等追加版本号：路径已存在 v= 参数时不再重复追加（防止 ?v=a?v=b 双版本号）
   * @param {string} path - 已拼好的资源路径或完整 URL
   * @returns {string}
   */
  withVersion(path) {
    if (path.includes('v=')) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}v=${this.version}`;
  },

  // 获取CDN URL
  getUrl(path) {
    if (!this.isStatic(path)) return path;

    if (!this.enabled) {
      // CDN 未启用时也追加应用版本号做缓存破坏，避免浏览器/边缘缓存旧版 JS/CSS
      // 直接用 appVersion（部署代码版本），不受后台 cdn_version 设置影响
      return this.withVersion(path);
    }

    // 构建CDN URL
    const separator = this.baseUrl.endsWith('/') ? '' : '/';
    const cdnPath = `${this.baseUrl}${separator}${path.replace(/^\//, '')}`;
    return this.withVersion(cdnPath);
  },

  // 获取资源URL（模板辅助函数）
  asset(path) {
    return this.getUrl(path);
  },

  // 当前生效的缓存破坏版本号（后台展示/调试用）
  getEffectiveVersion() {
    return this.version;
  },

  /**
   * 获取 CDN 域名 Origin（如 https://cdn.example.com）
   * 用于 CSP 动态白名单注入：启用自定义 CDN 域名后，script/style/font 需要放行该域名
   * 未配置或解析失败时返回空串
   * @returns {string}
   */
  getOrigin() {
    if (!this.baseUrl) return '';
    try {
      return new URL(this.baseUrl).origin;
    } catch (err) {
      return this.baseUrl.replace(/\/+$/, '');
    }
  },

  // 获取配置信息
  getConfig() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      baseUrl: this.baseUrl,
      version: this.version,
      appVersion
    };
  }
};

module.exports = cdnConfig;
