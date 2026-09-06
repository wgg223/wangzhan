/**
 * 上传目录访问保护中间件
 * 拦截 /uploads/images/* 与 /uploads/ai-images/*，防止未授权直链访问图片文件；
 * 拦截 /uploads/attachments/* 与 /uploads/.chunks/*（附件与分片统一走鉴权接口下载）。
 * 必须挂载在 express.static 之前、session 与 req.db 中间件之后。
 * 性能：访问判定带 30 秒短缓存，避免每张图片请求都查数据库。
 */
const { getDb, queryOne } = require('../config/database');
const { isAdminRole } = require('./auth');

const IMAGES_PREFIX = '/uploads/images/';      // 图片分享目录
const AI_IMAGES_PREFIX = '/uploads/ai-images/';// AI 生图目录
const ATTACHMENTS_PREFIX = '/uploads/attachments/'; // 附件目录
const CHUNKS_PREFIX = '/uploads/.chunks/';     // 分片上传临时目录

// 访问判定短缓存（TTL 30 秒）：避免每张图片请求都命中数据库
const DECISION_CACHE_TTL = 30 * 1000;
const decisionCache = new Map();

// 每分钟清理一次过期缓存条目
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of decisionCache) {
    if (now > entry.expires) decisionCache.delete(key);
  }
}, 60 * 1000);

/**
 * 判断可见性是否等于"公开"
 * @param {string} vis - 图片 visibility 字段
 * @returns {boolean} 空值或 'public' 视为公开
 */
function isPublicVisibility(vis) {
  return !vis || vis === '' || vis === 'public';
}

/**
 * 返回 403 拒绝访问
 * @param {Object} res - Express 响应对象
 */
function deny(res) {
  return res.status(403).end();
}

/**
 * images 表记录的访问规则（返回是否允许）
 * @param {Object} db - 数据库实例
 * @param {Object} req - Express 请求对象（含 session）
 * @param {Object} image - 图片记录
 * @returns {boolean} true=允许访问
 * 规则：
 *   - 游客：已通过审核 + 公开可见 + 所属分类游客可见；
 *   - 管理员或图片本人：直接放行（含待审核）；
 *   - 其他登录用户：需已审核 + 公开，或 visibility='selected' 且在被授权列表中。
 */
function checkImageAccess(db, req, image) {
  const user = req.session.user;
  if (!user) {
    // 游客：已通过审核 + 公开可见 + 所属分类游客可见
    if (image.status === 1 && isPublicVisibility(image.visibility)) {
      const cate = queryOne(db, 'SELECT is_guest FROM image_categories WHERE id = ? AND status = 1', [image.cate_id]);
      if (cate && cate.is_guest === 1) return true;
    }
    return false;
  }
  // 管理员或本人（含待审核图片）
  if (isAdminRole(user) || user.id === image.user_id) return true;
  // 其他登录用户：需已通过审核
  if (image.status !== 1) return false;
  if (isPublicVisibility(image.visibility)) return true;
  if (image.visibility === 'selected') {
    // 指定可见：解析 allowed_user_ids JSON 列表，判断当前用户是否在其中
    try {
      const allowed = JSON.parse(image.allowed_user_ids || '[]');
      if (Array.isArray(allowed) && allowed.indexOf(user.id) !== -1) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/**
 * /uploads/ai-images/*：AI 生图目录访问判定（返回是否允许）
 * @param {Object} db - 数据库实例
 * @param {Object} req - Express 请求对象
 * @param {string} url - 请求路径
 * @returns {boolean}
 * 规则：
 *   1. 命中 ai_image_records（生成结果图或参考图）→ 仅管理员/本人可访问；
 *   2. 命中分享到图片分享的 images 记录 → 走 checkImageAccess 规则；
 *   3. 目录内查不到任何记录 → 拒绝。
 */
function protectAiImage(db, req, url) {
  // 1. AI 生成记录（结果图或图生图参考图）
  const record = queryOne(db, 'SELECT * FROM ai_image_records WHERE image_path = ? OR reference_image = ?', [url, url]);
  if (record) {
    const user = req.session.user;
    if (user && (isAdminRole(user) || user.id === record.user_id)) return true;
    return false;
  }
  // 2. 分享到图片分享的 AI 图
  const image = queryOne(db, 'SELECT * FROM images WHERE url = ?', [url]);
  if (image) return checkImageAccess(db, req, image);
  // 3. 目录内查不到记录 → 拒绝
  return false;
}

/**
 * /uploads/images/*：图片分享 + 小说封面 + 文章封面/正文内嵌图访问判定（返回是否允许）
 * @param {Object} db - 数据库实例
 * @param {Object} req - Express 请求对象
 * @param {string} url - 请求路径
 * @returns {boolean}
 * 规则：
 *   1. 命中图片分享记录 → 走 checkImageAccess；
 *   2. 已发布小说的封面 → 放行；
 *   3. 已发布文章的封面 → 放行；
 *   4. 其余（文章正文内嵌图、后台通用上传、历史孤儿文件）→ 放行（宽松策略）。
 */
function protectImage(db, req, url) {
  // 1. 图片分享记录
  const image = queryOne(db, 'SELECT * FROM images WHERE url = ?', [url]);
  if (image) return checkImageAccess(db, req, image);
  // 2. 已发布小说封面
  const novel = queryOne(db, "SELECT id FROM novels WHERE cover_image = ? AND status = 'published'", [url]);
  if (novel) return true;
  // 3. 已发布文章封面
  const article = queryOne(db, "SELECT id FROM articles WHERE cover_image = ? AND status = 'published'", [url]);
  if (article) return true;
  // 4. 其余（文章正文内嵌图、后台通用上传、历史孤儿文件）放行
  return true;
}

/**
 * 上传目录保护中间件入口
 * 流程：附件/分片目录直接拒绝 → 非受保护目录放行 → 数据库未就绪放行 →
 *       查短缓存 → 未命中则调用对应判定函数并写缓存 → 按结果放行/拒绝。
 */
function protectUploads(req, res, next) {
  const pathname = req.path;

  // 附件与分片临时目录：一律禁止静态直链（下载走 /attachments/download/:id 等鉴权接口）
  if (pathname.startsWith(CHUNKS_PREFIX) || pathname.startsWith(ATTACHMENTS_PREFIX)) {
    return deny(res);
  }

  // 非受保护目录（/uploads 下其他内容如默认头像、小说上传目录）直接放行
  if (!pathname.startsWith(IMAGES_PREFIX) && !pathname.startsWith(AI_IMAGES_PREFIX)) {
    return next();
  }
  const db = getDb();
  if (!db) return next(); // 数据库未就绪（初始化阶段）放行

  // 短缓存：key = 路径:用户ID，30 秒内相同判定直接复用
  const userId = (req.session && req.session.user && req.session.user.id) || 'guest';
  const cacheKey = `${pathname}:${userId}`;
  const cached = decisionCache.get(cacheKey);
  if (cached) {
    return cached.allowed ? next() : deny(res);
  }

  // 按目录调用对应判定函数
  const allowed = pathname.startsWith(AI_IMAGES_PREFIX)
    ? protectAiImage(db, req, pathname)
    : protectImage(db, req, pathname);

  decisionCache.set(cacheKey, { allowed, expires: Date.now() + DECISION_CACHE_TTL });
  return allowed ? next() : deny(res);
}

module.exports = { protectUploads };
