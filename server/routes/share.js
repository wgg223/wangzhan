/**
 * 图片/AI生图/AI对话/在线表格 分享链接路由
 * 能力：
 *   POST /share/api/create   —— 创建分享链接（需 image-share.share 权限，仅本人/管理员）
 *   POST /share/api/disable  —— 停用分享（本人/管理员）
 *   POST /share/api/enable   —— 重新启用分享（本人/管理员）
 *   GET  /share/:token       —— 公开分享页（无需登录，支持 AI 会话 / 在线 Office 只读页）
 *   GET  /share/:token/embed —— 在线 Office 嵌入页（iframe 网页嵌入）
 *   GET  /share/:token/data  —— 在线 Office 分享数据（公开 JSON，供只读页/嵌入页加载）
 *   GET  /share/:token/page-view —— 在线文档只读视图数据（服务端排版好的 HTML 片段，不含编辑器快照）
 *   GET  /share/:token/sheet-view —— 在线表格只读视图数据（服务端排好的静态表格 HTML，不含编辑器快照）
 *   GET  /share/:token/file  —— 分享图片文件流（供 <img> 与社交平台 og:image 抓取）
 *   GET  /share/:token/download —— 下载原图（需登录，任意登录用户；在线 Office 分享不支持下载）
 * 表格分享管理（创建/停用/取消）位于 server/routes/spreadsheet.js（文档管理权限），
 * 本模块仅负责公开访问入口。
 * 安全要点：
 *   - 分享创建时校验"源记录归属"（仅本人/管理员可分享）；
 *   - 源文件路径解析白名单：必须以 /uploads/ 开头且最终路径必须在 public 目录内（防穿越）；
 *   - AI 会话分享只渲染 user/assistant 且非 error 状态的消息；
 *   - 在线 Office（表格/文档/演示文稿）分享页为只读渲染，仅在线查看、禁止下载/导出，数据接口仅凭有效 token 访问。
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { queryOne, queryAll, saveDatabase } = require('../config/database');
const { isAdminRole, hasFrontendPermission } = require('../middlewares/auth');
const { doubleSubmitCookie } = require('../middlewares/security');
const { publicDir } = require('../config/app-root');
const docStore = require('../utils/spreadsheet-doc-store');
const { getClientIp } = require('../utils/client-ip');
const { renderDocFlow } = require('../utils/doc-html-renderer');
const { renderWorkbook } = require('../utils/sheet-html-renderer');

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
    // active 状态且存在文档数据：Univer 新数据 / 大文档落盘文件 / 待惰性迁移的 Luckysheet 旧数据
    // 缺 doc_file 判定会让 >10MB 的文档（doc_data 为 NULL）被误判为「链接已失效」
    return source.status === 'active' && Boolean(source.doc_data || source.doc_file || source.luckysheet_data);
  }
  return false;
}

// 在线 Office 只读分享解析：token 有效、源为在线 Office 且可展示时返回 { share, source }，否则 null
// 所有 Office 公开接口（页面 / 嵌入 / 数据 / 只读视图）共用这一道校验
function resolveOfficeShare(db, token) {
  const resolved = resolveShare(db, token);
  if (!resolved || resolved.share.source_type !== 'spreadsheet') return null;
  if (!isShareAvailable(resolved.share, resolved.source)) return null;
  return resolved;
}

// 在线 Office 分享：表格 / 文档 / 演示文稿共用 source_type='spreadsheet'，
// 由 spreadsheets.doc_type 决定使用哪套只读模板与文案
const OFFICE_TEMPLATES = {
  spreadsheet: 'share/share-spreadsheet',
  document: 'share/share-document',
  presentation: 'share/share-presentation'
};
const OFFICE_LABELS = { spreadsheet: '在线表格', document: '在线文档', presentation: '演示文稿' };

// 渲染 Office 只读分享页（embed=true 为 iframe 嵌入视图，去掉页面装饰）
function renderOfficeShare(req, res, share, source, embed) {
  const db = req.db;
  const token = req.params.token;
  const docType = OFFICE_TEMPLATES[source.doc_type] ? source.doc_type : 'spreadsheet';
  const label = OFFICE_LABELS[docType];

  let ownerName = '';
  let stats = null;
  if (!embed) {
    const owner = queryOne(db, 'SELECT nickname, username FROM users WHERE id = ?', [source.created_by]);
    ownerName = (owner && (owner.nickname || owner.username)) || '匿名';
    stats = {
      version: source.doc_version || 0,
      updatedAt: source.updated_at,
      viewCount: share.view_count || 0
    };
  }

  res.render(OFFICE_TEMPLATES[docType], {
    layout: false,
    state: 'ok',
    share,
    docType,
    typeLabel: label,
    sheet: { id: source.id, name: source.name, description: source.description },
    ownerName,
    stats,
    embed,
    clientIp: getClientIp(req),
    dataUrl: '/share/' + token + '/data',
    embedUrl: embed ? '' : '/share/' + token + '/embed',
    pageUrl: '/share/' + token,
    title: embed ? ((source.name || label) + ' - 嵌入视图') : (source.name || (label + '分享')),
    baseUrl: req.siteBaseUrl || (req.protocol + '://' + req.get('host'))
  });
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
router.post('/api/create', doubleSubmitCookie, hasFrontendPermission('image-share.share'), (req, res) => {
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

router.post('/api/disable', doubleSubmitCookie, (req, res) => manageShareStatus(req, res, false));
router.post('/api/enable', doubleSubmitCookie, (req, res) => manageShareStatus(req, res, true));

// 取消分享（删除分享记录，本人/管理员；删除后链接立即失效）
router.post('/api/delete', doubleSubmitCookie, (req, res) => {
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

  // 在线 Office（表格/文档/演示文稿）：渲染对应类型的只读分享页，数据由前端经 /share/:token/data 异步加载
  if (share.source_type === 'spreadsheet') {
    return renderOfficeShare(req, res, share, source, false);
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

// Office 嵌入页（公开，iframe 网页嵌入：去掉页面装饰，仅保留画布）
router.get('/:token/embed', (req, res) => {
  const resolved = resolveOfficeShare(req.db, req.params.token);
  if (!resolved) {
    return res.status(404).send('分享链接不存在或已失效');
  }
  // 嵌入页允许被任意站点 iframe（覆盖全局 X-Frame-Options 与 CSP frame-ancestors）
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors *");
  renderOfficeShare(req, res, resolved.share, resolved.source, true);
});

// 表格分享数据（公开 JSON，仅凭有效 token；只读快照，支持大文档异步加载）
router.get('/:token/data', (req, res) => {
  const resolved = resolveOfficeShare(req.db, req.params.token);
  if (!resolved) {
    return res.status(404).json({ error: '分享链接不存在或已失效' });
  }
  let entry;
  try {
    entry = docStore.loadDoc(req.db, resolved.share.source_id);
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
      name: resolved.source.name,
      docType: entry.docType || resolved.source.doc_type || 'spreadsheet',
      version: resolved.source.doc_version || entry.doc.rev || 1,
      updatedAt: resolved.source.updated_at,
      doc: entry.doc
    }
  });
});

// 文档只读视图数据（公开，仅凭有效 token）
// 与编辑器「阅读视图」走同一个服务端渲染层（renderDocFlow），分享页只拿排版好的 HTML 片段，
// 不再向前端下发 Univer 可编辑快照，也不加载 Office 编辑器包
router.get('/:token/page-view', (req, res) => {
  const resolved = resolveOfficeShare(req.db, req.params.token);
  if (!resolved) {
    return res.status(404).json({ error: '分享链接不存在或已失效' });
  }
  if ((resolved.source.doc_type || 'spreadsheet') !== 'document') {
    return res.status(400).json({ error: '仅文档支持只读视图' });
  }
  let entry;
  try {
    entry = docStore.loadDoc(req.db, resolved.share.source_id);
  } catch (e) {
    return res.status(500).json({ error: '文档数据加载失败' });
  }
  if (!entry || !entry.doc) {
    return res.status(404).json({ error: '文档数据为空' });
  }
  let flow;
  try {
    flow = renderDocFlow(entry.doc, {
      name: resolved.source.name,
      readingMode: true,
      includeToc: true,
      publicDir,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || '文档渲染失败' });
  }
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({
    success: true,
    data: {
      mode: 'reading',
      css: flow.css,
      sections: flow.sections,
      toc: flow.toc,
      warnings: flow.warnings
    }
  });
});

// 表格只读视图数据（公开，仅凭有效 token）：服务端排好的静态表格 HTML
// 与文档分享页同一思路——不下发可编辑快照，也不让访客加载约 14MB 的 Univer 引擎
router.get('/:token/sheet-view', (req, res) => {
  const resolved = resolveOfficeShare(req.db, req.params.token);
  if (!resolved) {
    return res.status(404).json({ error: '分享链接不存在或已失效' });
  }
  if ((resolved.source.doc_type || 'spreadsheet') !== 'spreadsheet') {
    return res.status(400).json({ error: '仅表格支持只读视图' });
  }
  let entry;
  try {
    entry = docStore.loadDoc(req.db, resolved.share.source_id);
  } catch (e) {
    return res.status(500).json({ error: '表格数据加载失败' });
  }
  let out;
  try {
    const sheetId = String(req.query.sheetId || '');
    out = renderWorkbook(entry.doc, { sheetId: sheetId || undefined });
  } catch (e) {
    return res.status(400).json({ error: e.message || '表格渲染失败' });
  }
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: { name: resolved.source.name, sheets: out.sheets, warnings: out.warnings } });
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

// 下载原图（需登录，任意登录用户；在线 Office 分享仅在线只读查看，不支持下载）
router.get('/:token/download', (req, res) => {
  const db = req.db;
  const token = req.params.token;
  const resolved = resolveShare(db, token);
  // 在线 Office 分享：仅支持在线只读查看，禁止下载/导出
  if (resolved && resolved.share.source_type === 'spreadsheet') {
    return res.status(403).send('在线 Office 分享仅支持在线查看，不支持下载');
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
