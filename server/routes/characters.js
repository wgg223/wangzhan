/**
 * 角色卡广场路由（Character Card Hub）
 * 覆盖：
 *   - /characters 广场页面（游客可只读浏览，导入需登录）；
 *   - 卡片列表 / 详情 / 分类标签聚合；
 *   - 「导入到我」：把广场卡复制成自己的私有卡（source_type='hub'，禁止导出与二次分享，防内容外溢）；
 *   - 「分享到广场」开关：仅本人自建/自导入的卡可分享，官方卡与 hub 卡不可再分享；
 *   - 我的分享与统计。
 * 安全说明：
 *   - 写操作统一走 CSRF 双提交校验 + 限流；
 *   - 可见性：is_official=1 或 is_shared=1 的卡公开；其余仅作者本人可见；
 *   - 广场视图永不下发导出能力（can_export 由服务层按 source_type 判定，hub 卡恒为 false）。
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { getUserPermKeys, hasPermKey } = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { getSettings } = require('../utils/settings');
const { renderError } = require('../utils/response');
const { logActivity } = require('../config/activity');
const characterCards = require('../services/ai-chat/characters');
const uiPrefs = require('../services/ai-chat/ui-prefs');

// 广场功能总开关（沿用 AI 聊天开关；关闭后游客与用户均不可访问）
function hubEnabled(db) {
  const settings = getSettings(db);
  return String(settings.ai_enabled ?? '1') !== '0';
}

// JSON 版登录校验（isAuthenticated 会 302 到登录页，接口需要 401）
function requireAuthJson(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: '请先登录后再操作' });
}

// JSON 版 AI 聊天权限校验
function requireAiChatJson(req, res, next) {
  const db = req.db;
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ error: '请先登录后再操作' });
  if (user.role === 'super_admin') {
    res.locals.userPermissions = queryAll(db, 'SELECT perm_key FROM permissions').map(p => p.perm_key);
    return next();
  }
  const keys = getUserPermKeys(db, user.id);
  res.locals.userPermissions = keys;
  if (hasPermKey(keys, 'aichat.use')) return next();
  return res.status(403).json({ error: '您没有 AI 聊天权限，请先申请权限' });
}

// CSRF 校验（与 AI 聊天模块一致：POST 头 X-CSRF-Token === session.doubleSubmitToken）
function csrfCheck(req, res, next) {
  const token = req.headers['x-csrf-token'];
  if (!token || !req.session || token !== req.session.doubleSubmitToken) {
    return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面重试' });
  }
  next();
}

const hubOpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: r => `hub:op:${r.session && r.session.user ? r.session.user.id : r.ip}`,
  message: '操作过于频繁，请稍后再试'
});

// 列表视图所需列（不含 personality/scenario/system_prompt 等长文本，避免上百张卡撑爆响应）
const LIST_COLUMNS = `id, name, avatar, description, category, tags, creator, character_version, license,
  is_official, is_shared, source_type, share_token, greeting, alternate_greetings, world_book,
  import_count, view_count, shared_at, created_at`;

const SORTS = {
  hot: 'import_count DESC, view_count DESC, id DESC',
  new: 'shared_at DESC, created_at DESC, id DESC',
  views: 'view_count DESC, import_count DESC, id DESC',
  name: 'name ASC, id ASC'
};

const SCOPES = ['public', 'official', 'mine', 'shared', 'imported'];

// 卡片可见性：公开（官方或已分享）/ 本人 / 超管
function canViewCard(row, user) {
  if (!row) return false;
  if (row.is_official || row.is_shared) return true;
  if (user && row.user_id === user.id) return true;
  return Boolean(user && user.role === 'super_admin');
}

// 按 share_token 或数字 id 解析卡片
function resolveCard(db, key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [parseInt(raw, 10)]);
  }
  return queryOne(db, 'SELECT * FROM ai_roles WHERE share_token = ?', [raw.slice(0, 64)]);
}

// ==================== 页面 ====================

/**
 * 角色卡广场页面（独立页面，不使用主站布局）
 * 游客可只读浏览；登录后可导入到自己的角色列表
 */
router.get('/characters', (req, res) => {
  const db = req.db;
  if (!hubEnabled(db)) {
    return renderError(res, 403, '角色卡广场暂未开放，请联系管理员。', req);
  }
  if (!req.session.doubleSubmitToken) {
    req.session.doubleSubmitToken = crypto.randomBytes(32).toString('hex');
  }
  const user = req.session.user || null;
  let userPerms = [];
  if (user) {
    userPerms = user.role === 'super_admin'
      ? queryAll(db, 'SELECT perm_key FROM permissions').map(p => p.perm_key)
      : getUserPermKeys(db, user.id);
  }
  res.locals.userPermissions = userPerms;
  const canImport = Boolean(user) && hasPermKey(userPerms, 'aichat.use');
  let uiSettings = uiPrefs.DEFAULTS;
  if (user) {
    const row = queryOne(db, 'SELECT ai_ui_settings FROM users WHERE id = ?', [user.id]);
    uiSettings = uiPrefs.sanitize(row && row.ai_ui_settings);
  }
  res.render('frontend/characters', {
    layout: false,
    user,
    settings: getSettings(db),
    csrfToken: req.session.doubleSubmitToken,
    canImport,
    isGuest: !user,
    uiSettings
  });
});

// ==================== 接口 ====================

/**
 * 分类与标签聚合（供筛选器使用）
 */
router.get('/characters/api/meta', (req, res) => {
  const db = req.db;
  if (!hubEnabled(db)) return res.status(403).json({ error: '功能未开放' });
  const user = req.session.user || null;
  const rows = queryAll(db, `SELECT category, tags, is_official, is_shared, user_id FROM ai_roles
    WHERE is_official = 1 OR is_shared = 1${user ? ' OR user_id = ?' : ''}`, user ? [user.id] : []);
  const categories = {};
  const tagCount = {};
  rows.forEach(r => {
    const cat = String(r.category || 'default');
    categories[cat] = (categories[cat] || 0) + 1;
    characterCards.strArray(r.tags, 30, 10).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
  });
  const tags = Object.keys(tagCount)
    .sort((a, b) => tagCount[b] - tagCount[a] || a.localeCompare(b))
    .slice(0, 40)
    .map(t => ({ tag: t, count: tagCount[t] }));
  res.json({
    success: true,
    data: {
      total: rows.length,
      categories: Object.keys(categories).sort().map(c => ({ category: c, count: categories[c] })),
      tags,
      is_guest: !user
    }
  });
});

/**
 * 卡片列表
 * query: scope(public|official|mine|shared|imported) q category tag sort(hot|new|views|name) page per_page
 */
router.get('/characters/api/cards', (req, res) => {
  const db = req.db;
  if (!hubEnabled(db)) return res.status(403).json({ error: '功能未开放' });
  const user = req.session.user || null;
  const scope = SCOPES.indexOf(String(req.query.scope || 'public')) !== -1 ? String(req.query.scope) : 'public';
  if (scope !== 'public' && scope !== 'official' && !user) {
    return res.status(401).json({ error: '请先登录后再查看个人卡片' });
  }

  const where = [];
  const params = [];
  if (scope === 'mine') {
    where.push('user_id = ?'); params.push(user.id);
  } else if (scope === 'shared') {
    where.push('user_id = ? AND is_shared = 1'); params.push(user.id);
  } else if (scope === 'imported') {
    where.push("user_id = ? AND source_type = 'hub'"); params.push(user.id);
  } else if (scope === 'official') {
    where.push('is_official = 1');
  } else {
    // 广场默认视图：官方卡 + 用户分享卡（登录用户额外能看到自己的未分享卡，便于管理）
    where.push(user ? '(is_official = 1 OR is_shared = 1 OR user_id = ?)' : '(is_official = 1 OR is_shared = 1)');
    if (user) params.push(user.id);
  }

  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    where.push('(name LIKE ? OR description LIKE ? OR creator LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const category = String(req.query.category || '').trim().slice(0, 40);
  if (category) { where.push('category = ?'); params.push(category); }
  const tag = String(req.query.tag || '').trim().slice(0, 30);
  if (tag) { where.push('tags LIKE ?'); params.push(`%"${tag}"%`); }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 24, 1), 48);
  const orderBy = SORTS[String(req.query.sort || 'hot')] || SORTS.hot;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = queryOne(db, `SELECT COUNT(*) AS c FROM ai_roles ${whereSql}`, params);
  const total = totalRow ? totalRow.c : 0;
  const rows = queryAll(db, `SELECT ${LIST_COLUMNS} FROM ai_roles ${whereSql}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params.concat([perPage, (page - 1) * perPage]));

  res.json({
    success: true,
    data: {
      items: rows.map(r => characterCards.publicCardView(r, { list: true, guest: !user })),
      page,
      per_page: perPage,
      total,
      pages: Math.max(Math.ceil(total / perPage), 1),
      scope,
      is_guest: !user,
      can_import: Boolean(user) && hasPermKey(res.locals.userPermissions || [], 'aichat.use')
    }
  });
});

/**
 * 卡片详情
 * :key 支持 share_token（公开分享链接）或数字 id
 * 游客只读预览；登录用户可见全文（但永远没有导出能力）
 */
router.get('/characters/api/cards/:key', (req, res) => {
  const db = req.db;
  if (!hubEnabled(db)) return res.status(403).json({ error: '功能未开放' });
  const user = req.session.user || null;
  const row = resolveCard(db, req.params.key);
  if (!row || !canViewCard(row, user)) return res.status(404).json({ error: '角色卡不存在或已下架' });

  // 浏览量统计（公开卡才计，且不做去重，仅作为热度参考）
  if (row.is_official || row.is_shared) {
    db.run('UPDATE ai_roles SET view_count = view_count + 1 WHERE id = ?', [row.id]);
    saveDatabase();
  }
  const isOwner = Boolean(user && row.user_id === user.id);
  const view = characterCards.publicCardView(row, { guest: !user });
  view.id = row.id;
  view.is_owner = isOwner ? 1 : 0;
  view.official_only = row.is_official ? 1 : 0;
  view.can_import = Boolean(user) && !isOwner && hasPermKey(res.locals.userPermissions || [], 'aichat.use');
  if (isOwner) {
    view.can_share = characterCards.canShareCard(row) ? 1 : 0;
    view.source_role_id = row.source_role_id || null;
    view.source_url = row.source_url || '';
    view.share_url = row.share_token ? '/characters?card=' + row.share_token : '';
  }
  res.json({ success: true, data: view });
});

/**
 * 导入到我的角色卡（仅站内使用，导入后 source_type='hub'：不可导出、不可再分享）
 * body: { token } 或 { id }
 */
router.post('/characters/api/cards/import', requireAuthJson, requireAiChatJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  if (!hubEnabled(db)) return res.status(403).json({ error: '功能未开放' });
  const user = req.session.user;
  const key = req.body.token || req.body.id || '';
  const src = resolveCard(db, key);
  if (!src || !canViewCard(src, user)) return res.status(404).json({ error: '角色卡不存在或已下架' });
  if (!(src.is_official || src.is_shared)) return res.status(403).json({ error: '该角色卡未公开分享' });
  if (src.user_id === user.id) return res.status(400).json({ error: '这是你自己的角色卡，无需导入' });

  // 单用户角色卡数量上限（与 AI 聊天模块保持一致的宽松上限）
  const countRow = queryOne(db, 'SELECT COUNT(*) AS c FROM ai_roles WHERE user_id = ?', [user.id]);
  if (countRow && countRow.c >= 500) return res.status(400).json({ error: '你的角色卡数量已达上限（500 张）' });

  let extensions = '{}';
  try { extensions = JSON.stringify(JSON.parse(src.extensions || '{}')); } catch (e) { extensions = '{}'; }
  const cols = characterCards.cardToColumns({
    name: src.name,
    avatar: characterCards.sanitizeAvatar(src.avatar),
    description: src.description,
    personality: src.personality,
    scenario: src.scenario,
    greeting: src.greeting,
    alternate_greetings: characterCards.strArray(src.alternate_greetings, 2000, 5),
    system_prompt: src.system_prompt,
    post_history_instructions: src.post_history_instructions,
    examples: src.examples,
    creator_notes: src.creator_notes,
    creator: src.creator,
    character_version: src.character_version,
    tags: characterCards.strArray(src.tags, 30, 10),
    category: src.category,
    world_book: characterCards.parseWorldBook(src),
    extensions
  });

  // 溯源：hub 来源 → 服务层与路由层双重禁止导出/再分享（防内容外溢）
  const payload = Object.assign({}, cols, {
    is_official: 0,
    user_id: user.id,
    sort_order: 0,
    source_type: 'hub',
    source_role_id: src.id,
    source_url: '', // 站内来源不留外链
    license: src.license || '' // 保留原作者许可声明
  });
  const columns = Object.keys(payload);
  db.run(`INSERT INTO ai_roles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(c => payload[c]));
  const created = queryOne(db, 'SELECT * FROM ai_roles WHERE id = last_insert_rowid()');
  db.run('UPDATE ai_roles SET import_count = import_count + 1 WHERE id = ?', [src.id]);
  saveDatabase();

  logActivity(db, {
    user_id: user.id, username: user.username, action: 'import',
    target_type: 'character_card', target_id: created.id, target_title: created.name,
    detail: `从角色卡广场导入：${created.name}（来源 #${src.id}）`, ip: req.ip
  });

  res.json({
    success: true,
    data: characterCards.chatRoleView(created, { canExport: false }),
    message: '已导入到你的角色卡，仅可在站内使用（不支持导出）'
  });
});

/**
 * 分享开关（仅本人卡；官方卡与 hub 导入卡不可分享）
 * body: { id, shared: 0|1, license?, creator_notes? }
 */
router.post('/characters/api/cards/share', requireAuthJson, requireAiChatJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const id = parseInt(req.body.id, 10);
  if (!id) return res.status(400).json({ error: '缺少角色卡 ID' });
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  if (!characterCards.canShareCard(row)) {
    return res.status(403).json({ error: '该角色卡来自广场导入，不支持二次分享' });
  }

  const shared = req.body.shared ? 1 : 0;
  if (shared) {
    // 分享前校验：至少要有名称与一段可用正文
    const hasContent = String(row.system_prompt || '').trim() || String(row.personality || '').trim() ||
      String(row.description || '').trim();
    if (!hasContent) return res.status(400).json({ error: '角色卡内容为空，无法分享' });
    let token = String(row.share_token || '').trim();
    if (!token) {
      token = characterCards.generateShareToken();
      db.run('UPDATE ai_roles SET share_token = ? WHERE id = ?', [token, id]);
    }
    const license = String(req.body.license || row.license || '').trim().slice(0, 100);
    const notes = req.body.creator_notes !== undefined
      ? String(req.body.creator_notes || '').slice(0, 1000) : row.creator_notes;
    db.run('UPDATE ai_roles SET is_shared = 1, shared_at = CURRENT_TIMESTAMP, license = ?, creator_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [license, notes, id]);
  } else {
    db.run('UPDATE ai_roles SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
  saveDatabase();
  const updated = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [id]);

  logActivity(db, {
    user_id: user.id, username: user.username, action: shared ? 'share' : 'unshare',
    target_type: 'character_card', target_id: id, target_title: updated.name,
    detail: `${shared ? '分享' : '取消分享'}角色卡：${updated.name}`, ip: req.ip
  });

  res.json({ success: true, data: characterCards.ownerCardView(updated) });
});

/**
 * 重新生成分享链接（撤销旧链接）
 */
router.post('/characters/api/cards/relink', requireAuthJson, requireAiChatJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const id = parseInt(req.body.id, 10);
  const row = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!row) return res.status(404).json({ error: '角色卡不存在' });
  if (!row.is_shared) return res.status(400).json({ error: '该角色卡未处于分享状态' });
  const token = characterCards.generateShareToken();
  db.run('UPDATE ai_roles SET share_token = ? WHERE id = ?', [token, id]);
  saveDatabase();
  const updated = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [id]);
  res.json({ success: true, data: characterCards.ownerCardView(updated), message: '分享链接已更新，旧链接立即失效' });
});

/**
 * 我的角色卡与分享统计
 */
router.get('/characters/api/mine', requireAuthJson, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const rows = queryAll(db, 'SELECT * FROM ai_roles WHERE user_id = ? ORDER BY is_shared DESC, updated_at DESC, id DESC', [user.id]);
  const stats = rows.reduce((acc, r) => {
    acc.total += 1;
    if (r.is_shared) acc.shared += 1;
    if (r.source_type === 'hub') acc.imported += 1;
    acc.imports += r.import_count || 0;
    acc.views += r.view_count || 0;
    return acc;
  }, { total: 0, shared: 0, imported: 0, imports: 0, views: 0 });
  res.json({
    success: true,
    data: {
      stats,
      items: rows.map(r => characterCards.ownerCardView(r))
    }
  });
});

module.exports = router;
