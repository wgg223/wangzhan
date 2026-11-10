/**
 * 角色卡广场路由（Character Card Hub）
 * 覆盖：
 *   - /characters 广场页面（游客可只读浏览，导入需登录）；
 *   - 卡片列表 / 详情 / 分类标签聚合；
 *   - 「导入到我」：把广场卡复制成自己的私有卡（source_type='hub'，禁止导出与二次分享，防内容外溢）；
 *   - 「分享到广场」开关：仅本人自建/自导入的卡可分享，官方卡与 hub 卡不可再分享；
 *   - 上传：普通用户可上传自己的角色卡（.json/.png，落库为 source_type='external'）；
 *     管理员（aichat.manage / 超管）可批量上传，落库为官方卡（is_official=1, source_type='official'）；
 *   - 治理（管理员）：屏蔽（仅上传者可见）、下架（取消分享 / 取消官方标记）、强制删除，均支持批量；
 *   - 我的分享与统计。
 * 安全说明：
 *   - 写操作统一走 CSRF 双提交校验 + 限流；
 *   - 可见性：is_official=1 或 is_shared=1 的卡公开；其余仅作者本人可见；
 *     被屏蔽的卡（ai_role_blocks）对所有人隐藏，仅上传者本人可见，治理入口在后台；
 *   - 广场视图永不下发导出能力（can_export 由服务层按 source_type 判定，hub 卡恒为 false）。
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { getUserPermKeys, hasPermKey } = require('../middlewares/auth');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { getSettings } = require('../utils/settings');
const { renderError } = require('../utils/response');
const { logActivity } = require('../config/activity');
const characterCards = require('../services/ai-chat/characters');
const { parseCardFiles } = require('../services/ai-chat/card-import');
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

// 计算当前请求用户的权限键列表（不依赖 res.locals，供公开 GET 接口直接使用）
// super_admin 视为拥有全部权限；其余用户读 user_permissions
function permKeysFor(req) {
  const db = req.db;
  const user = req.session && req.session.user;
  if (!user) return [];
  if (user.role === 'super_admin') {
    return queryAll(db, 'SELECT perm_key FROM permissions').map(p => p.perm_key);
  }
  return getUserPermKeys(db, user.id);
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
const LIST_COLUMNS = `id, user_id, name, avatar, description, category, tags, creator, character_version, license,
  is_official, is_shared, source_type, share_token, greeting, alternate_greetings, world_book,
  import_count, view_count, shared_at, created_at`;

const SORTS = {
  hot: 'import_count DESC, view_count DESC, id DESC',
  new: 'shared_at DESC, created_at DESC, id DESC',
  views: 'view_count DESC, import_count DESC, id DESC',
  name: 'name ASC, id ASC'
};

const SCOPES = ['public', 'official', 'mine', 'shared', 'imported'];

// 是否具备角色卡治理能力（管理员）：super_admin 或持有 aichat.manage
function canManageCards(req) {
  const user = req.session && req.session.user;
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return hasPermKey(permKeysFor(req), 'aichat.manage');
}

// 批量 id 解析（数组或逗号分隔字符串 → 正整数数组，最多 limit 个）
function parseIds(body, limit) {
  const raw = Array.isArray(body.ids) ? body.ids : String(body.ids == null ? (body.id == null ? '' : body.id) : body.ids).split(',');
  const out = [];
  raw.forEach(v => {
    const n = parseInt(v, 10);
    if (n > 0 && out.indexOf(n) === -1) out.push(n);
  });
  return out.slice(0, limit || 100);
}

// 屏蔽状态查询：返回 { id: {reason, blocked_at} }
function blockMap(db, ids) {
  if (!ids || !ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT role_id, reason, blocked_at FROM ai_role_blocks WHERE role_id IN (${ph})`, ids);
  const map = {};
  rows.forEach(r => { map[r.role_id] = { reason: r.reason || '', blocked_at: r.blocked_at || '' }; });
  return map;
}

// 可见性 SQL 片段：被屏蔽的卡只有上传者本人能看到（管理员在后台治理面板查看全部）
function blockedFilterSql(user) {
  return user
    ? '(NOT EXISTS (SELECT 1 FROM ai_role_blocks blk WHERE blk.role_id = ai_roles.id) OR ai_roles.user_id = ?)'
    : 'NOT EXISTS (SELECT 1 FROM ai_role_blocks blk WHERE blk.role_id = ai_roles.id)';
}

// 卡片可见性：公开（官方或已分享）/ 本人 / 超管；被屏蔽的卡仅上传者本人可见
function canViewCard(db, row, user) {
  if (!row) return false;
  const blocked = queryOne(db, 'SELECT id FROM ai_role_blocks WHERE role_id = ?', [row.id]);
  if (blocked) return Boolean(user && row.user_id === user.id);
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
  const userPerms = permKeysFor(req);
  res.locals.userPermissions = userPerms;
  const canImport = Boolean(user) && hasPermKey(userPerms, 'aichat.use');
  const canManage = canManageCards(req);
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
    canManage,
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
    WHERE (${user ? 'is_official = 1 OR is_shared = 1 OR user_id = ?' : 'is_official = 1 OR is_shared = 1'})
      AND ${blockedFilterSql(user)}`, user ? [user.id, user.id] : []);
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

  // 被屏蔽的卡对所有人隐藏（上传者本人除外）
  where.push(blockedFilterSql(user));
  if (user) params.push(user.id);

  const q = String(req.query.q || '').trim().slice(0, 60); if (q) {
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

  const blocks = blockMap(db, rows.map(r => r.id));
  const canManage = canManageCards(req);

  res.json({
    success: true,
    data: {
      items: rows.map(r => {
        const v = characterCards.publicCardView(r, { list: true, guest: !user });
        const b = blocks[r.id];
        v.id = r.id;
        v.is_mine = user && r.user_id === user.id ? 1 : 0;
        v.is_blocked = b ? 1 : 0;
        v.block_reason = b ? b.reason : '';
        return v;
      }),
      page,
      per_page: perPage,
      total,
      pages: Math.max(Math.ceil(total / perPage), 1),
      scope,
      is_guest: !user,
      can_import: Boolean(user) && hasPermKey(permKeysFor(req), 'aichat.use'),
      can_manage: canManage ? 1 : 0
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
  if (!row || !canViewCard(db, row, user)) return res.status(404).json({ error: '角色卡不存在或已下架' });

  const block = queryOne(db, 'SELECT reason, blocked_at FROM ai_role_blocks WHERE role_id = ?', [row.id]);

  // 浏览量统计（公开卡才计，且不做去重，仅作为热度参考；被屏蔽的卡不计）
  if (!block && (row.is_official || row.is_shared)) {
    db.run('UPDATE ai_roles SET view_count = view_count + 1 WHERE id = ?', [row.id]);
    saveDatabase();
  }
  const isOwner = Boolean(user && row.user_id === user.id);
  const view = characterCards.publicCardView(row, { guest: !user });
  view.id = row.id;
  view.is_owner = isOwner ? 1 : 0;
  view.official_only = row.is_official ? 1 : 0;
  view.is_blocked = block ? 1 : 0;
  view.block_reason = block ? (block.reason || '') : '';
  view.can_manage = canManageCards(req) ? 1 : 0;
  view.can_import = Boolean(user) && !isOwner && hasPermKey(permKeysFor(req), 'aichat.use');
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
  if (!src || !canViewCard(db, src, user)) return res.status(404).json({ error: '角色卡不存在或已下架' });
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

// ==================== 上传（用户自建 / 管理员批量官方卡） ====================

const cardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.json' && ext !== '.png') return cb(new Error('仅支持 .json / .png 角色卡'));
    cb(null, true);
  }
});

const UPLOAD_LIMIT_ADMIN = 50; // 管理员批量上传上限
const UPLOAD_LIMIT_USER = 10; // 普通用户单次上传上限
const USER_CARD_CAP = 200; // 单个用户在库角色卡总量上限（防刷）

/**
 * 上传角色卡文件（.json / .png，兼容 Character Card V1/V2/V3 与 SillyTavern PNG 卡）
 * - 管理员（aichat.manage / 超管）：批量上传，落库为官方卡（is_official=1, source_type='official'），全站可见
 * - 普通用户：上传到自己的角色卡（source_type='external'，可分享、可导出），默认不公开
 */
router.post('/characters/api/cards/upload', requireAuthJson, requireAiChatJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const isAdmin = canManageCards(req);
  const maxFiles = isAdmin ? UPLOAD_LIMIT_ADMIN : UPLOAD_LIMIT_USER;

  cardUpload.array('files', maxFiles)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!hubEnabled(db)) return res.status(403).json({ error: '功能未开放' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '请选择角色卡文件（.json / .png）' });
    if (files.length > maxFiles) return res.status(400).json({ error: `单次最多上传 ${maxFiles} 个文件` });

    const parsed = parseCardFiles(files);
    const errors = parsed.errors.slice();
    const existingNames = new Set(
      queryAll(db, isAdmin ? 'SELECT name FROM ai_roles WHERE is_official = 1' : 'SELECT name FROM ai_roles WHERE user_id = ?',
        isAdmin ? [] : [user.id]).map(r => String(r.name).toLowerCase())
    );

    if (!isAdmin) {
      const own = queryOne(db, 'SELECT COUNT(*) AS c FROM ai_roles WHERE user_id = ?', [user.id]);
      if ((own ? own.c : 0) + parsed.items.length > USER_CARD_CAP) {
        return res.status(400).json({ error: `角色卡数量已达上限（${USER_CARD_CAP} 张），请先清理后再上传` });
      }
    }

    let imported = 0;
    let skipped = 0;
    const created = [];
    parsed.items.forEach(item => {
      const norm = item.norm;
      const lower = String(norm.name).toLowerCase();
      if (existingNames.has(lower)) {
        skipped++;
        errors.push(item.fileName + '：同名角色卡「' + norm.name + '」已存在，跳过');
        return;
      }
      existingNames.add(lower);
      const cols = characterCards.cardToColumns(norm);
      const payload = isAdmin
        ? Object.assign({}, cols, { is_official: 1, user_id: null, sort_order: 0, source_type: 'official', source_url: '', is_shared: 0, share_token: '' })
        : Object.assign({}, cols, { is_official: 0, user_id: user.id, sort_order: 0, source_type: 'external', source_url: '', is_shared: 0, share_token: '' });
      const columns = Object.keys(payload);
      db.run(`INSERT INTO ai_roles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(c => payload[c]));
      const inserted = queryOne(db, 'SELECT id FROM ai_roles WHERE rowid = last_insert_rowid()');
      imported++;
      created.push({ id: inserted ? inserted.id : 0, name: norm.name, fileName: item.fileName });
    });
    saveDatabase();

    created.forEach(c => logActivity(db, {
      user_id: user.id, username: user.username, action: 'create', target_type: 'character_card', target_id: c.id,
      target_title: c.name,
      detail: `${isAdmin ? '管理员批量上传官方角色卡' : '用户上传角色卡'}：${c.name}（文件 ${c.fileName}，本批成功 ${imported}，跳过 ${skipped}）`,
      ip: req.ip
    }));

    res.json({
      success: true,
      message: `已上传 ${imported} 张角色卡${skipped ? '，跳过 ' + skipped + ' 张' : ''}`,
      data: { imported, skipped, errors, official: isAdmin ? 1 : 0, created }
    });
  });
});

// ==================== 治理（管理员：屏蔽 / 下架 / 删除） ====================

// 治理能力校验（JSON 403，不 302 到登录页）
function requireManageJson(req, res, next) {
  if (canManageCards(req)) return next();
  return res.status(403).json({ error: '需要角色卡管理权限' });
}

/**
 * 屏蔽 / 解除屏蔽（支持批量）
 * 屏蔽后：广场列表与详情对所有人隐藏（含管理员），仅上传者本人可见；同时强制取消分享使旧链接失效
 * body: { ids: [1,2] | '1,2', blocked: 0|1, reason }
 */
router.post('/characters/api/cards/block', requireAuthJson, requireManageJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const ids = parseIds(req.body, 100);
  if (!ids.length) return res.status(400).json({ error: '请选择要操作的角色卡' });
  const blocked = String(req.body.blocked) === '0' || req.body.blocked === false ? 0 : 1;
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id, is_shared, is_official FROM ai_roles WHERE id IN (${ph})`, ids);
  if (!rows.length) return res.status(404).json({ error: '角色卡不存在' });

  rows.forEach(r => {
    if (blocked) {
      // 先删后插，兼容 sql.js 回退引擎（不依赖 UPSERT 语法）
      db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [r.id]);
      db.run('INSERT INTO ai_role_blocks (role_id, reason, blocked_by) VALUES (?, ?, ?)', [r.id, reason, req.session.user.id]);
      // 屏蔽即从广场消失：顺手清空分享状态，避免旧分享链接继续可用
      db.run("UPDATE ai_roles SET is_shared = 0, share_token = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
    } else {
      db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [r.id]);
    }
  });
  saveDatabase();
  rows.forEach(r => logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username, action: blocked ? 'block' : 'unblock',
    target_type: 'character_card', target_id: r.id, target_title: r.name,
    detail: `${blocked ? '屏蔽角色卡（仅上传者可见）' : '解除屏蔽'}：${r.name}（作者 user_id=${r.user_id || 0}）${blocked && reason ? '，原因：' + reason : ''}`,
    ip: req.ip
  }));
  res.json({ success: true, message: blocked ? `已屏蔽 ${rows.length} 张角色卡` : `已解除屏蔽 ${rows.length} 张角色卡`, data: { updated: rows.length, blocked } });
});

/**
 * 下架（支持批量）：用户分享卡 → 强制取消分享；官方卡 → 取消官方标记
 * 下架后卡片不再出现在广场，作者本人仍可在「我的」里看到
 * body: { ids }
 */
router.post('/characters/api/cards/takedown', requireAuthJson, requireManageJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const ids = parseIds(req.body, 100);
  if (!ids.length) return res.status(400).json({ error: '请选择要下架的角色卡' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id, is_shared, is_official FROM ai_roles WHERE id IN (${ph})`, ids);
  if (!rows.length) return res.status(404).json({ error: '角色卡不存在' });
  let unshared = 0;
  let demoted = 0;
  const skipped = [];
  rows.forEach(r => {
    if (r.is_official) {
      db.run("UPDATE ai_roles SET is_official = 0, source_type = 'self', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
      demoted++;
    } else if (r.is_shared) {
      db.run("UPDATE ai_roles SET is_shared = 0, share_token = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [r.id]);
      unshared++;
    } else {
      skipped.push(r.name);
    }
  });
  saveDatabase();
  rows.forEach(r => logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username, action: 'takedown',
    target_type: 'character_card', target_id: r.id, target_title: r.name,
    detail: `下架角色卡：${r.name}（${r.is_official ? '取消官方标记' : (r.is_shared ? '强制取消分享' : '本就未公开，无需处理')}，作者 user_id=${r.user_id || 0}）`,
    ip: req.ip
  }));
  res.json({
    success: true,
    message: `已下架 ${unshared + demoted} 张${skipped.length ? '，' + skipped.length + ' 张本就未公开' : ''}`,
    data: { updated: unshared + demoted, unshared, demoted, skipped }
  });
});

/**
 * 删除（支持批量）：管理员可删除任意卡；普通用户仅能删除自己的卡
 * 删除时解除所有会话对该卡的引用，并清理屏蔽记录
 * body: { ids }
 */
router.post('/characters/api/cards/delete', requireAuthJson, requireAiChatJson, csrfCheck, hubOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const isAdmin = canManageCards(req);
  const ids = parseIds(req.body, 100);
  if (!ids.length) return res.status(400).json({ error: '请选择要删除的角色卡' });
  const ph = ids.map(() => '?').join(',');
  const rows = queryAll(db, `SELECT id, name, user_id, is_official FROM ai_roles WHERE id IN (${ph})`, ids);
  if (!rows.length) return res.status(404).json({ error: '角色卡不存在' });

  let deleted = 0;
  const denied = [];
  rows.forEach(r => {
    const owner = Boolean(r.user_id && r.user_id === user.id);
    if (!isAdmin && !owner) { denied.push(r.name); return; }
    if (!isAdmin && r.is_official) { denied.push(r.name); return; }
    db.run('UPDATE ai_conversations SET role_id = NULL WHERE role_id = ?', [r.id]);
    db.run('DELETE FROM ai_role_blocks WHERE role_id = ?', [r.id]);
    db.run('DELETE FROM ai_roles WHERE id = ?', [r.id]);
    deleted++;
    logActivity(db, {
      user_id: user.id, username: user.username, action: 'delete', target_type: 'character_card', target_id: r.id,
      target_title: r.name,
      detail: `${isAdmin ? '管理员强制删除' : '用户删除自己的'}角色卡：${r.name}（作者 user_id=${r.user_id || 0}）`,
      ip: req.ip
    });
  });
  saveDatabase();
  if (!deleted) return res.status(403).json({ error: '没有可删除的角色卡（权限不足）' });
  res.json({
    success: true,
    message: `已删除 ${deleted} 张角色卡${denied.length ? '，' + denied.length + ' 张无权限跳过' : ''}`,
    data: { deleted, denied }
  });
});

module.exports = router;
