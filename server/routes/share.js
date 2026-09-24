/**
 * 图片/AI生图/AI对话/在线表格 分享链接路由
 * 能力：
 *   POST /share/api/create   —— 创建分享链接（需 image-share.share 权限，仅本人/管理员）
 *   POST /share/api/disable  —— 停用分享（本人/管理员）
 *   POST /share/api/enable   —— 重新启用分享（本人/管理员）
 *   GET  /share/:token       —— 公开分享页（无需登录，支持 AI 会话 / 在线表格只读页）
 *   GET  /share/:token/embed —— 表格嵌入页（iframe 网页嵌入）
 *   GET  /share/:token/data  —— 表格分享数据（公开 JSON，供只读页/嵌入页加载）
 *   GET  /share/:token/file  —— 分享图片文件流（供 <img> 与社交平台 og:image 抓取）
 *   GET  /share/:token/download —— 下载原图（需登录，任意登录用户；在线表格分享不支持下载）
 * 表格分享管理（创建/停用/取消）位于 server/routes/spreadsheet.js（文档管理权限），
 * 本模块仅负责公开访问入口。
 * 安全要点：
 *   - 分享创建时校验"源记录归属"（仅本人/管理员可分享）；
 *   - 源文件路径解析白名单：必须以 /uploads/ 开头且最终路径必须在 public 目录内（防穿越）；
 *   - AI 会话分享只渲染 user/assistant 且非 error 状态的消息；
 *   - 表格分享页为只读渲染，仅在线查看、禁止下载/导出，数据接口仅凭有效 token 访问。
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { queryOne, queryAll, saveDatabase } = require('../config/database');
const { isAdminRole, hasFrontendPermission } = require('../middlewares/auth');
const { publicDir } = require('../config/app-root');
const docStore = require('../utils/spreadsheet-doc-store');
const { getClientIp } = require('../utils/client-ip');

// 生成随机分享令牌
function createShareToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// 解析分享链接：返回 { share, source }（source 为 images / ai_image_records / ai_conversations / spreadsheets 行）
function resolveShare(db, token) {
  const share = queryOne(db, 'SELECT * FROM image_shares WHERE share_token = ?', [token]);
  if (!share) return null;
  let source = null;
  if (share.source_type === 'image') {
    source = queryOne(db, 'SELECT * FROM images WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'ai_image') {
    source = queryOne(db, 'SELECT * FROM ai_image_records WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'ai_chat') {
    source = queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'spreadsheet') {
    source = queryOne(db, 'SELECT * FROM spreadsheets WHERE id = ?', [share.source_id]);
  }
  return { share, source };
}

// 分享链接是否可公开展示（链接有效 + 源记录可展示）
function isShareAvailable(share, source) {
  if (!share || share.status !== 1 || !source) return false;
  if (share.source_type === 'image') return source.status === 1;
  if (share.source_type === 'ai_image') return source.status === 'success' && Boolean(source.image_path);
  if (share.source_type === 'ai_chat') return true; // 会话无审核状态，链接有效即可展示
  if (share.source_type === 'spreadsheet') {
    // active 状态且存在文档数据（Univer 新数据或待惰性迁移的 Luckysheet 旧数据）
    return source.status === 'active' && Boolean(source.doc_data || source.luckysheet_data);
  }
  return false;
}

// 源文件 web 路径（/uploads/...）
function sourceWebPath(share, source) {
  return share.source_type === 'image' ? source.url : source.image_path;
}

// 源文件绝对路径（白名单：必须位于 public 目录内）
function resolveFilePath(webPath) {
  if (!webPath || !webPath.startsWith('/uploads/')) return null;
  const abs = path.normalize(path.join(publicDir, webPath.replace(/^\//, '')));
  if (!abs.startsWith(path.normalize(publicDir) + path.sep)) return null;
  return abs;
}

// 分享源的所有者是否有权管理（本人/管理员）
function canManageSource(db, user, share) {
  if (!user) return false;
  if (isAdminRole(user)) return true;
  if (share.created_by === user.id) return true;
  let source = null;
  if (share.source_type === 'image') {
    source = queryOne(db, 'SELECT user_id FROM images WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'ai_image') {
    source = queryOne(db, 'SELECT user_id FROM ai_image_records WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'ai_chat') {
    source = queryOne(db, 'SELECT user_id FROM ai_conversations WHERE id = ?', [share.source_id]);
  } else if (share.source_type === 'spreadsheet') {
    source = queryOne(db, 'SELECT created_by AS user_id FROM spreadsheets WHERE id = ?', [share.source_id]);
  }
  return source && source.user_id === user.id;
}

// ============ API（创建 / 停用 / 启用） ============

// 创建分享链接（需 image-share.share 权限，仅本人/管理员可分享自己的图）
router.post('/api/create', hasFrontendPermission('image-share.share'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const sourceType = req.body.source_type;
  const sourceId = parseInt(req.body.source_id, 10);

  if ((sourceType !== 'image' && sourceType !== 'ai_image' && sourceType !== 'ai_chat') || !sourceId) {
    return res.status(400).json({ error: '参数错误' });
  }

  let source;
  if (sourceType === 'image') {
    source = queryOne(db, 'SELECT * FROM images WHERE id = ?', [sourceId]);
    if (!source) return res.status(404).json({ error: '图片不存在' });
    if (source.user_id !== user.id && !isAdminRole(user)) {
      return res.status(403).json({ error: '无权分享该图片' });
    }
    if (source.status !== 1) {
      return res.status(400).json({ error: '图片未通过审核，无法创建分享链接' });
    }
  } else if (sourceType === 'ai_image') {
    source = queryOne(db, 'SELECT * FROM ai_image_records WHERE id = ?', [sourceId]);
    if (!source) return res.status(404).json({ error: '生成记录不存在' });
    if (source.user_id !== user.id && !isAdminRole(user)) {
      return res.status(403).json({ error: '无权分享该图片' });
    }
    if (source.status !== 'success' || !source.image_path) {
      return res.status(400).json({ error: '该记录没有可分享的图片' });
    }
  } else if (sourceType === 'ai_chat') {
    source = queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [sourceId]);
    if (!source) return res.status(404).json({ error: '会话不存在' });
    if (source.user_id !== user.id && !isAdminRole(user)) {
      return res.status(403).json({ error: '无权分享该会话' });
    }
  } else {
    return res.status(400).json({ error: '参数错误' });
  }

  // 已存在分享则复用（停用的重新启用）
  let share = queryOne(db, 'SELECT * FROM image_shares WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
  if (!share) {
    const token = createShareToken();
    db.run('INSERT INTO image_shares (source_type, source_id, share_token, status, created_by) VALUES (?, ?, ?, 1, ?)',
      [sourceType, sourceId, token, user.id]);
    share = queryOne(db, 'SELECT * FROM image_shares WHERE share_token = ?', [token]);
  } else if (share.status !== 1) {
    db.run('UPDATE image_shares SET status = 1 WHERE id = ?', [share.id]);
    share.status = 1;
  }
  saveDatabase();

  res.json({ success: true, token: share.share_token, url: '/share/' + share.share_token });
});

// 停用 / 启用分享链接（本人/管理员）
function manageShareStatus(req, res, enabled) {
  const db = req.db;
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: '请先登录' });

  const token = (req.body.token || '').trim();
  const share = queryOne(db, 'SELECT * FROM image_shares WHERE share_token = ?', [token]);
  if (!share) return res.status(404).json({ error: '分享链接不存在' });
  if (!canManageSource(db, user, share)) {
    return res.status(403).json({ error: '无权操作该分享链接' });
  }

  db.run('UPDATE image_shares SET status = ? WHERE id = ?', [enabled ? 1 : 0, share.id]);
  saveDatabase();
  res.json({ success: true });
}

router.post('/api/disable', (req, res) => manageShareStatus(req, res, false));
router.post('/api/enable', (req, res) => manageShareStatus(req, res, true));

// 取消分享（删除分享记录，本人/管理员；删除后链接立即失效）
router.post('/api/delete', (req, res) => {
  const db = req.db;
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: '请先登录' });

  const token = (req.body.token || '').trim();
  const share = queryOne(db, 'SELECT * FROM image_shares WHERE share_token = ?', [token]);
  if (!share) return res.status(404).json({ error: '分享链接不存在' });
  if (!canManageSource(db, user, share)) {
    return res.status(403).json({ error: '无权操作该分享链接' });
  }

  db.run('DELETE FROM image_shares WHERE id = ?', [share.id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 公开分享页 ============

// 分享页（公开，无需登录）
router.get('/:token', (req, res) => {
  const db = req.db;
  const token = req.params.token;
  const resolved = resolveShare(db, token);
  const baseUrl = req.siteBaseUrl || (req.protocol + '://' + req.get('host'));

  if (!resolved || !isShareAvailable(resolved.share, resolved.source)) {
    return res.render('share/share-detail', {
      layout: false,
      state: 'gone',
      user: req.session.user || null,
      baseUrl
    });
  }

  const { share, source } = resolved;
  db.run('UPDATE image_shares SET view_count = view_count + 1 WHERE id = ?', [share.id]);
  saveDatabase();

  // AI 聊天会话：渲染只读对话分享页
  if (share.source_type === 'ai_chat') {
    const role = source.role_id
      ? queryOne(db, 'SELECT name FROM ai_roles WHERE id = ?', [source.role_id])
      : null;
    const messages = queryAll(db, `SELECT role, content, status FROM ai_messages
      WHERE conversation_id = ? AND branch_id = 0 AND role IN ('user','assistant') AND status NOT IN ('error')
      ORDER BY id ASC`, [source.id]);
    const owner = queryOne(db, 'SELECT nickname, username FROM users WHERE id = ?', [source.user_id]);
    const ownerName = (owner && (owner.nickname || owner.username)) || '匿名';
    return res.render('share/share-chat', {
      layout: false,
      state: 'ok',
      share,
      conversation: source,
      messages,
      roleName: role ? role.name : 'AI',
      ownerName,
      pageUrl: '/share/' + token,
      title: source.title || 'AI 对话分享',
      baseUrl
    });
  }

  // 在线表格：渲染只读分享页（数据由前端经 /share/:token/data 异步加载）
  if (share.source_type === 'spreadsheet') {
    const owner = queryOne(db, 'SELECT nickname, username FROM users WHERE id = ?', [source.created_by]);
    const ownerName = (owner && (owner.nickname || owner.username)) || '匿名';
    const stats = {
      version: source.doc_version || 0,
      updatedAt: source.updated_at,
      viewCount: share.view_count || 0
    };
    return res.render('share/share-spreadsheet', {
      layout: false,
      state: 'ok',
      share,
      sheet: { id: source.id, name: source.name, description: source.description },
      ownerName,
      stats,
      embed: false,
      clientIp: getClientIp(req),
      dataUrl: '/share/' + token + '/data',
      embedUrl: '/share/' + token + '/embed',
      pageUrl: '/share/' + token,
      title: source.name || '在线表格分享',
      baseUrl
    });
  }

  let title, description;
  if (share.source_type === 'image') {
    title = source.title || '';
    description = source.description || '';
  } else {
    title = (source.prompt || '').slice(0, 50) || 'AI生图';
    description = source.prompt || '';
  }
  const owner = queryOne(db, 'SELECT nickname, username FROM users WHERE id = ?', [source.user_id]);
  const ownerName = (owner && (owner.nickname || owner.username)) || '匿名';

  res.render('share/share-detail', {
    layout: false,
    state: 'ok',
    share,
    source,
    title,
    description,
    ownerName,
    imageUrl: '/share/' + token + '/file',
    downloadUrl: '/share/' + token + '/download',
    pageUrl: '/share/' + token,
    absoluteImageUrl: baseUrl + '/share/' + token + '/file',
    user: req.session.user || null,
    baseUrl
  });
});

// 表格嵌入页（公开，iframe 网页嵌入：去掉页面装饰，仅保留表格画布）
router.get('/:token/embed', (req, res) => {
  const db = req.db;
  const resolved = resolveShare(db, req.params.token);
  if (!resolved || !isShareAvailable(resolved.share, resolved.source) || resolved.share.source_type !== 'spreadsheet') {
    return res.status(404).send('分享链接不存在或已失效');
  }
  const { share, source } = resolved;
  // 嵌入页允许被任意站点 iframe（覆盖全局 X-Frame-Options 与 CSP frame-ancestors）
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors *");
  res.render('share/share-spreadsheet', {
    layout: false,
    state: 'ok',
    share,
    sheet: { id: source.id, name: source.name, description: source.description },
    ownerName: '',
    stats: null,
    embed: true,
    clientIp: getClientIp(req),
    dataUrl: '/share/' + req.params.token + '/data',
    embedUrl: '',
    pageUrl: '/share/' + req.params.token,
    title: (source.name || '在线表格') + ' - 嵌入视图',
    baseUrl: req.siteBaseUrl || (req.protocol + '://' + req.get('host'))
  });
});

// 表格分享数据（公开 JSON，仅凭有效 token；只读快照，支持大文档异步加载）
router.get('/:token/data', (req, res) => {
  const db = req.db;
  const resolved = resolveShare(db, req.params.token);
  if (!resolved || !isShareAvailable(resolved.share, resolved.source) || resolved.share.source_type !== 'spreadsheet') {
    return res.status(404).json({ error: '分享链接不存在或已失效' });
  }
  let entry;
  try {
    entry = docStore.loadDoc(db, resolved.share.source_id);
  } catch (e) {
    return res.status(500).json({ error: '文档数据加载失败' });
  }
  if (!entry || !entry.doc) {
    return res.status(404).json({ error: '文档数据为空' });
  }
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({
    success: true,
    data: {
      id: resolved.source.id,
      name: resolved.source.name,
      version: resolved.source.doc_version || entry.doc.rev || 1,
      updatedAt: resolved.source.updated_at,
      doc: entry.doc
    }
  });
});

// 分享图片文件流（公开，供页面 <img> 与微信/QQ og:image 抓取）
router.get('/:token/file', (req, res) => {
  const db = req.db;
  const resolved = resolveShare(db, req.params.token);
  if (!resolved || !isShareAvailable(resolved.share, resolved.source)) {
    return res.status(404).end();
  }
  const abs = resolveFilePath(sourceWebPath(resolved.share, resolved.source));
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).end();
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(abs);
});

// 下载原图（需登录，任意登录用户；在线表格分享仅在线只读查看，不支持下载）
router.get('/:token/download', (req, res) => {
  const db = req.db;
  const token = req.params.token;
  const resolved = resolveShare(db, token);
  // 在线表格分享：仅支持在线只读查看，禁止下载/导出
  if (resolved && resolved.share.source_type === 'spreadsheet') {
    return res.status(403).send('在线表格分享仅支持在线查看，不支持下载');
  }
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login?returnTo=' + encodeURIComponent('/share/' + token));
  }
  if (!resolved || !isShareAvailable(resolved.share, resolved.source)) {
    return res.redirect('/share/' + token);
  }

  const abs = resolveFilePath(sourceWebPath(resolved.share, resolved.source));
  if (!abs || !fs.existsSync(abs)) {
    return res.redirect('/share/' + token);
  }

  db.run('UPDATE image_shares SET download_count = download_count + 1 WHERE id = ?', [resolved.share.id]);
  saveDatabase();

  const baseName = resolved.share.source_type === 'image'
    ? (resolved.source.title || '图片')
    : ((resolved.source.prompt || 'AI生图').slice(0, 50) || 'AI生图');
  res.download(abs, baseName + path.extname(abs));
});

module.exports = router;
