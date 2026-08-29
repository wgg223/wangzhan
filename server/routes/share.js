const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { queryOne, queryAll, saveDatabase } = require('../config/database');
const { isAdminRole, hasFrontendPermission } = require('../middlewares/auth');
const { publicDir } = require('../config/app-root');

// 生成随机分享令牌
function createShareToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// 解析分享链接：返回 { share, source }（source 为 images / ai_image_records / ai_conversations 行）
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
  }
  return { share, source };
}

// 分享链接是否可公开展示（链接有效 + 源记录可展示）
function isShareAvailable(share, source) {
  if (!share || share.status !== 1 || !source) return false;
  if (share.source_type === 'image') return source.status === 1;
  if (share.source_type === 'ai_image') return source.status === 'success' && Boolean(source.image_path);
  if (share.source_type === 'ai_chat') return true; // 会话无审核状态，链接有效即可展示
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

// 分享图片下载（需登录，任意登录用户）
router.get('/:token/download', (req, res) => {
  const db = req.db;
  const token = req.params.token;
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/frontend/login?returnTo=' + encodeURIComponent('/share/' + token));
  }
  const resolved = resolveShare(db, token);
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
