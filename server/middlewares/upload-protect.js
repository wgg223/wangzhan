/**
 * 上传目录访问保护中间件
 * 拦截 /uploads/images/* 与 /uploads/ai-images/*，防止未授权直链访问图片文件；
 * 拦截 /uploads/attachments/* 与 /uploads/.chunks/*（附件与分片统一走鉴权接口下载）。
 * 必须挂载在 express.static 之前、session 与 req.db 中间件之后。
 */
const { getDb, queryOne } = require('../config/database');
const { isAdminRole } = require('./auth');

const IMAGES_PREFIX = '/uploads/images/';
const AI_IMAGES_PREFIX = '/uploads/ai-images/';
const ATTACHMENTS_PREFIX = '/uploads/attachments/';
const CHUNKS_PREFIX = '/uploads/.chunks/';

// 访问判定短缓存（TTL 30 秒）：避免每张图片请求都命中数据库
const DECISION_CACHE_TTL = 30 * 1000;
const decisionCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of decisionCache) {
    if (now > entry.expires) decisionCache.delete(key);
  }
}, 60 * 1000);

function isPublicVisibility(vis) {
  return !vis || vis === '' || vis === 'public';
}

function deny(res) {
  return res.status(403).end();
}

// images 表记录的访问规则（返回是否允许）
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
    try {
      const allowed = JSON.parse(image.allowed_user_ids || '[]');
      if (Array.isArray(allowed) && allowed.indexOf(user.id) !== -1) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

// /uploads/ai-images/*：AI 生图目录（返回是否允许）
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

// /uploads/images/*：图片分享 + 小说封面 + 文章封面/正文内嵌图（返回是否允许）
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

function protectUploads(req, res, next) {
  const pathname = req.path;

  // 附件与分片临时目录：一律禁止静态直链（下载走 /attachments/download/:id 等鉴权接口）
  if (pathname.startsWith(CHUNKS_PREFIX) || pathname.startsWith(ATTACHMENTS_PREFIX)) {
    return deny(res);
  }

  if (!pathname.startsWith(IMAGES_PREFIX) && !pathname.startsWith(AI_IMAGES_PREFIX)) {
    return next();
  }
  const db = getDb();
  if (!db) return next(); // 数据库未就绪（初始化阶段）放行

  const userId = (req.session && req.session.user && req.session.user.id) || 'guest';
  const cacheKey = `${pathname}:${userId}`;
  const cached = decisionCache.get(cacheKey);
  if (cached) {
    return cached.allowed ? next() : deny(res);
  }

  const allowed = pathname.startsWith(AI_IMAGES_PREFIX)
    ? protectAiImage(db, req, pathname)
    : protectImage(db, req, pathname);

  decisionCache.set(cacheKey, { allowed, expires: Date.now() + DECISION_CACHE_TTL });
  return allowed ? next() : deny(res);
}

module.exports = { protectUploads };
