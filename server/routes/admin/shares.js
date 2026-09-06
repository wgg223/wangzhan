/**
 * 分享管理路由（后台）
 * 能力：
 *   GET  /admin/shares                —— 全部用户分享列表（关键词/类型/状态筛选 + 分页）
 *   POST /admin/shares/:id/disable    —— 停用分享链接
 *   POST /admin/shares/:id/enable     —— 启用分享链接
 *   POST /admin/shares/:id/delete     —— 取消分享（删除分享记录，链接永久失效）
 * 安全要点：全程 hasPermission('shares.manage')；写操作经全局 doubleSubmitCookie CSRF 校验。
 */
const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// 分享列表查询公共部分（LEFT JOIN 源表取标题/缩略图，JOIN users 取分享人）
const SHARE_SELECT = `
  SELECT s.*,
    u.nickname AS creator_nickname, u.username AS creator_username,
    COALESCE(img.title, aiimg.prompt, conv.title, '') AS source_title,
    COALESCE(img.url, aiimg.image_path, '') AS source_path
  FROM image_shares s
  LEFT JOIN users u ON u.id = s.created_by
  LEFT JOIN images img ON s.source_type = 'image' AND img.id = s.source_id
  LEFT JOIN ai_image_records aiimg ON s.source_type = 'ai_image' AND aiimg.id = s.source_id
  LEFT JOIN ai_conversations conv ON s.source_type = 'ai_chat' AND conv.id = s.source_id
`;

// 从查询串或表单体读取筛选条件，返回 { where: [], params: [] }
function buildFilters(query) {
  const where = [];
  const params = [];
  const keyword = (query.keyword || '').trim();
  const sourceType = query.source_type || '';
  const status = query.status || '';

  if (keyword) {
    const kw = '%' + keyword + '%';
    where.push("(s.share_token LIKE ? OR u.username LIKE ? OR u.nickname LIKE ? OR COALESCE(img.title, aiimg.prompt, conv.title, '') LIKE ?)");
    params.push(kw, kw, kw, kw);
  }
  if (sourceType === 'image' || sourceType === 'ai_image' || sourceType === 'ai_chat') {
    where.push('s.source_type = ?');
    params.push(sourceType);
  }
  if (status === '1' || status === '0') {
    where.push('s.status = ?');
    params.push(parseInt(status, 10));
  }
  return { where, params };
}

// 保留筛选与分页参数的返回链接
function backToShares(req) {
  const q = Object.assign({}, req.query, req.body || {});
  const parts = [];
  if (q.keyword) parts.push('keyword=' + encodeURIComponent(q.keyword));
  if (q.source_type) parts.push('source_type=' + encodeURIComponent(q.source_type));
  if (q.status) parts.push('status=' + encodeURIComponent(q.status));
  if (q.page) parts.push('page=' + encodeURIComponent(q.page));
  return '/admin/shares' + (parts.length ? '?' + parts.join('&') : '');
}

// 分享列表页
router.get('/shares', isAuthenticated, hasPermission('shares.manage'), (req, res) => {
  const db = req.db;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const { where, params } = buildFilters(req.query);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const countRow = queryOne(db,
    'SELECT COUNT(*) AS count FROM image_shares s' +
    ' LEFT JOIN users u ON u.id = s.created_by' +
    " LEFT JOIN images img ON s.source_type = 'image' AND img.id = s.source_id" +
    " LEFT JOIN ai_image_records aiimg ON s.source_type = 'ai_image' AND aiimg.id = s.source_id" +
    " LEFT JOIN ai_conversations conv ON s.source_type = 'ai_chat' AND conv.id = s.source_id " +
    whereSql, params);
  const total = countRow ? countRow.count : 0;

  const shares = queryAll(db,
    SHARE_SELECT + ' ' + whereSql + ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?',
    params.concat([pageSize, offset]));

  res.render('admin/shares', {
    user: req.session.user,
    shares,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    filters: {
      keyword: req.query.keyword || '',
      source_type: req.query.source_type || '',
      status: req.query.status || ''
    },
    settings: res.locals.settings || {}
  });
});

// 分享操作公共逻辑（disable / enable / delete）
function manageShare(req, res, action) {
  const db = req.db;
  const shareId = parseInt(req.params.id, 10);
  const share = queryOne(db, 'SELECT * FROM image_shares WHERE id = ?', [shareId]);
  if (!share) {
    return res.status(404).json({ error: '分享记录不存在' });
  }

  if (action === 'delete') {
    db.run('DELETE FROM image_shares WHERE id = ?', [shareId]);
  } else {
    db.run('UPDATE image_shares SET status = ? WHERE id = ?', [action === 'enable' ? 1 : 0, shareId]);
  }
  saveDatabase();

  try {
    const actionText = action === 'delete' ? '取消分享' : (action === 'enable' ? '启用分享' : '停用分享');
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: action === 'delete' ? 'delete' : 'update',
      target_type: 'share',
      target_id: shareId,
      target_title: share.share_token,
      detail: actionText + '：' + share.share_token,
      ip: req.ip
    });
  } catch (e) { /* 日志失败不影响主流程 */ }

  res.redirect(backToShares(req));
}

router.post('/shares/:id/disable', isAuthenticated, hasPermission('shares.manage'), (req, res) => manageShare(req, res, 'disable'));
router.post('/shares/:id/enable', isAuthenticated, hasPermission('shares.manage'), (req, res) => manageShare(req, res, 'enable'));
router.post('/shares/:id/delete', isAuthenticated, hasPermission('shares.manage'), (req, res) => manageShare(req, res, 'delete'));

module.exports = router;
