/**
 * AI 提示词管理路由（后台）
 * 权限模型：prompts.view（查看）与 prompts.manage（管理）两级；
 *           admin/super_admin 默认全量。编辑按钮由 canManage 控制。
 * 模块：
 *   GET  /admin/prompts                    —— 总览页（板块/分类/提示词/评论）
 *   POST /admin/prompts/sections/{save,delete/:id}    —— 板块增删改
 *   POST /admin/prompts/categories/{save,delete/:id}  —— 分类增删改（校验所属板块存在）
 *   GET  /admin/prompts/prompts/{new,edit/:id}        —— 提示词编辑器
 *   POST /admin/prompts/prompts/{save,delete/:id}     —— 提示词增删改
 *   POST /admin/prompts/comments/{approve,delete}/:id —— 评论审核/删除
 *   GET  /admin/prompts/export              —— 全量导出 CSV（含 BOM）
 *   GET  /admin/prompts/import-template     —— 导入模板（含说明与示例行）
 *   POST /admin/prompts/import              —— CSV 导入（板块/分类按名复用、重复跳过、# 开头跳过）
 * 说明：所有变更会 clearPromptsCache() 清理前台 ai_prompts_* 缓存，即时生效。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission, getUserPermissions } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { renderError } = require('../../utils/response');
const { queryCache } = require('../../config/cache');

// ============ AI提示词管理（板块/分类/提示词） ============

// 前台 ai_prompts_* 缓存前缀清理
function clearPromptsCache() {
  queryCache.deleteByPrefix('ai_prompts');
}

// 查询权限中间件：prompts.view 或 prompts.manage 均可查看
function requireView(req, res, next) {
  const user = req.session.user;
  if (user.role === 'super_admin' || user.role === 'admin') {
    res.locals.userPermissions = queryAll(req.db, 'SELECT perm_key FROM permissions').map(p => p.perm_key);
    return next();
  }
  const perms = getUserPermissions(user.id);
  res.locals.userPermissions = perms;
  if (perms.indexOf('prompts.view') !== -1 || perms.indexOf('prompts.manage') !== -1 || perms.indexOf('prompts.*') !== -1) {
    return next();
  }
  return res.status(403).json({ error: '您没有查询提示词的权限' });
}

// 当前用户是否具备管理权限（用于视图控制编辑按钮）
function canManage(user, perms) {
  if (user.role === 'super_admin' || user.role === 'admin') return true;
  return perms.indexOf('prompts.manage') !== -1 || perms.indexOf('prompts.*') !== -1;
}

// 取数组字段首元素（防御重复表单字段）
function first(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

// 从 Markdown 原文生成纯文本摘要（去除 # * ` > _ ~ - 等标记符，压缩空白，取前100字）
function makeExcerpt(content) {
  return (content || '').replace(/[#*`>_~\-()![\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ============ 管理总览页（查询权限） ============

// 总览页：四表联查（板块带分类数与提示词数、分类带提示词数、提示词带归属名、评论带待审优先）
router.get('/prompts', isAuthenticated, requireView, (req, res) => {
  const db = req.db;

  const sections = queryAll(db, `
    SELECT s.*, COUNT(DISTINCT c.id) AS category_count, COUNT(p.id) AS prompt_count
    FROM prompt_sections s
    LEFT JOIN prompt_categories c ON c.section_id = s.id
    LEFT JOIN prompts p ON p.category_id = c.id
    GROUP BY s.id ORDER BY s.sort_order ASC, s.id ASC`);

  const categories = queryAll(db, `
    SELECT c.*, s.name AS section_name,
      (SELECT COUNT(*) FROM prompts p WHERE p.category_id = c.id) AS prompt_count
    FROM prompt_categories c
    LEFT JOIN prompt_sections s ON c.section_id = s.id
    ORDER BY s.sort_order ASC, c.sort_order ASC, c.id ASC`);

  const prompts = queryAll(db, `
    SELECT p.*, c.name AS category_name, s.name AS section_name
    FROM prompts p
    LEFT JOIN prompt_categories c ON p.category_id = c.id
    LEFT JOIN prompt_sections s ON c.section_id = s.id
    ORDER BY p.sort_order ASC, p.id DESC`);

  // 评论：待审优先，再按时间倒序
  const comments = queryAll(db, `
    SELECT pc.*, p.title AS prompt_title, u.username
    FROM prompt_comments pc
    LEFT JOIN prompts p ON pc.prompt_id = p.id
    LEFT JOIN users u ON pc.user_id = u.id
    ORDER BY pc.status = 'pending' DESC, pc.created_at DESC, pc.id DESC`);

  res.render('admin/prompts', {
    user: req.session.user,
    settings: res.locals.settings || {},
    sections: sections,
    categories: categories,
    prompts: prompts,
    comments: comments,
    canManage: canManage(req.session.user, res.locals.userPermissions || [])
  });
});

// ============ 板块管理 ============

// 保存板块（有 id 更新，无 id 新建）
router.post('/prompts/sections/save', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const id = first(req.body.id);
  const name = first(req.body.name);
  const icon = first(req.body.icon);
  const description = first(req.body.description);
  const sortOrder = parseInt(first(req.body.sort_order), 10) || 0;
  const isActive = req.body.is_active === '1' || req.body.is_active === 1 ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: '板块名称不能为空' });
  }

  if (id) {
    db.run('UPDATE prompt_sections SET name=?, icon=?, description=?, sort_order=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [name, icon, description, sortOrder, isActive, id]);
  } else {
    db.run('INSERT INTO prompt_sections (name, icon, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
      [name, icon, description, sortOrder, isActive]);
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'prompt_section', target_id: id ? parseInt(id, 10) : null, target_title: name, detail: (id ? '更新' : '创建') + '提示词板块：' + name, ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// 删除板块（外键级联删除其分类与提示词）
router.post('/prompts/sections/delete/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const section = queryOne(db, 'SELECT name FROM prompt_sections WHERE id = ?', [req.params.id]);

  if (!section) {
    return res.status(404).json({ error: '板块不存在' });
  }

  db.run('DELETE FROM prompt_sections WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'prompt_section', target_id: parseInt(req.params.id, 10), target_title: section.name, detail: '删除提示词板块：' + section.name + '（级联删除其分类与提示词）', ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// ============ 分类管理 ============

// 保存分类（校验所属板块真实存在）
router.post('/prompts/categories/save', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const id = first(req.body.id);
  const sectionId = first(req.body.section_id);
  const name = first(req.body.name);
  const description = first(req.body.description);
  const sortOrder = parseInt(first(req.body.sort_order), 10) || 0;
  const isActive = req.body.is_active === '1' || req.body.is_active === 1 ? 1 : 0;

  if (!sectionId) {
    return res.status(400).json({ error: '请选择所属板块' });
  }
  if (!name) {
    return res.status(400).json({ error: '分类名称不能为空' });
  }
  const section = queryOne(db, 'SELECT id FROM prompt_sections WHERE id = ?', [sectionId]);
  if (!section) {
    return res.status(400).json({ error: '所属板块不存在' });
  }

  if (id) {
    db.run('UPDATE prompt_categories SET section_id=?, name=?, description=?, sort_order=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [sectionId, name, description, sortOrder, isActive, id]);
  } else {
    db.run('INSERT INTO prompt_categories (section_id, name, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
      [sectionId, name, description, sortOrder, isActive]);
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'prompt_category', target_id: id ? parseInt(id, 10) : null, target_title: name, detail: (id ? '更新' : '创建') + '提示词分类：' + name, ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// 删除分类（级联删除其提示词）
router.post('/prompts/categories/delete/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const category = queryOne(db, 'SELECT name FROM prompt_categories WHERE id = ?', [req.params.id]);

  if (!category) {
    return res.status(404).json({ error: '分类不存在' });
  }

  db.run('DELETE FROM prompt_categories WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'prompt_category', target_id: parseInt(req.params.id, 10), target_title: category.name, detail: '删除提示词分类：' + category.name + '（级联删除其提示词）', ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// ============ 提示词管理 ============

// 编辑器页公共数据：板块（含各自分类）
function getEditorData(db) {
  const sections = queryAll(db, 'SELECT * FROM prompt_sections ORDER BY sort_order ASC, id ASC');
  const categories = queryAll(db, 'SELECT * FROM prompt_categories ORDER BY sort_order ASC, id ASC');
  const sectionsWithCats = sections.map(function(s) {
    s.categories = categories.filter(function(c) { return c.section_id === s.id; });
    return s;
  });
  return sectionsWithCats;
}

// 新建提示词页
router.get('/prompts/prompts/new', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  res.render('admin/prompt-editor', {
    user: req.session.user,
    settings: res.locals.settings || {},
    prompt: null,
    sections: getEditorData(req.db)
  });
});

// 编辑提示词页
router.get('/prompts/prompts/edit/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const prompt = queryOne(db, 'SELECT * FROM prompts WHERE id = ?', [req.params.id]);

  if (!prompt) {
    return renderError(res, 404, '提示词不存在', req);
  }

  res.render('admin/prompt-editor', {
    user: req.session.user,
    settings: res.locals.settings || {},
    prompt: prompt,
    sections: getEditorData(db)
  });
});

// 保存提示词（摘要为空时自动从内容截取）
router.post('/prompts/prompts/save', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const id = first(req.body.id);
  const categoryId = first(req.body.category_id);
  const title = first(req.body.title);
  const content = first(req.body.content);
  const excerpt = first(req.body.excerpt);
  const sortOrder = parseInt(first(req.body.sort_order), 10) || 0;
  const isActive = req.body.is_active === '1' || req.body.is_active === 1 ? 1 : 0;

  if (!title) {
    return res.status(400).json({ error: '提示词标题不能为空' });
  }
  if (!categoryId) {
    return res.status(400).json({ error: '请选择所属分类' });
  }
  if (!content) {
    return res.status(400).json({ error: '提示词内容不能为空' });
  }
  const category = queryOne(db, 'SELECT id FROM prompt_categories WHERE id = ?', [categoryId]);
  if (!category) {
    return res.status(400).json({ error: '所属分类不存在' });
  }

  const safeExcerpt = excerpt || makeExcerpt(content);
  let promptId = id;

  if (id) {
    db.run('UPDATE prompts SET category_id=?, title=?, content=?, excerpt=?, sort_order=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [categoryId, title, content, safeExcerpt, sortOrder, isActive, id]);
  } else {
    db.run('INSERT INTO prompts (category_id, title, content, excerpt, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [categoryId, title, content, safeExcerpt, sortOrder, isActive]);
    // 回查新记录 ID（供 AJAX 继续编辑）
    const newPrompt = queryOne(db, 'SELECT id FROM prompts WHERE title = ? AND category_id = ? ORDER BY id DESC LIMIT 1',
      [title, categoryId]);
    if (newPrompt) promptId = newPrompt.id;
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'prompt', target_id: id ? parseInt(id, 10) : null, target_title: title, detail: (id ? '更新' : '创建') + '提示词：' + title, ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, promptId: promptId });
  }
  res.redirect('/admin/prompts');
});

// 删除提示词
router.post('/prompts/prompts/delete/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const prompt = queryOne(db, 'SELECT title FROM prompts WHERE id = ?', [req.params.id]);

  if (!prompt) {
    return res.status(404).json({ error: '提示词不存在' });
  }

  db.run('DELETE FROM prompts WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'prompt', target_id: parseInt(req.params.id, 10), target_title: prompt.title, detail: '删除提示词：' + prompt.title, ip: req.ip });
  clearPromptsCache();

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// ============ 评论管理 ============

// 通过评论审核
router.post('/prompts/comments/approve/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT * FROM prompt_comments WHERE id = ?', [req.params.id]);
  if (!comment) {
    return res.status(404).json({ error: '评论不存在' });
  }
  db.run("UPDATE prompt_comments SET status = 'approved' WHERE id = ?", [comment.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'prompt_comment', target_id: comment.id, target_title: '评论审核', detail: '通过提示词评论（ID ' + comment.id + '）', ip: req.ip });
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// 删除评论
router.post('/prompts/comments/delete/:id', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT * FROM prompt_comments WHERE id = ?', [req.params.id]);
  if (!comment) {
    return res.status(404).json({ error: '评论不存在' });
  }
  db.run('DELETE FROM prompt_comments WHERE id = ?', [comment.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'prompt_comment', target_id: comment.id, target_title: '评论删除', detail: '删除提示词评论（ID ' + comment.id + '）', ip: req.ip });
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true });
  }
  res.redirect('/admin/prompts');
});

// ============ 导入 / 导出 ============

const { CSV_HEADERS, toCsv, parseCsv } = require('../../utils/csv');

// 导出全部提示词为 CSV（查询权限；BOM 保证 Excel 中文正常）
router.get('/prompts/export', isAuthenticated, requireView, (req, res) => {
  const db = req.db;
  const prompts = queryAll(db, `
    SELECT s.name AS section_name, s.icon AS section_icon, s.description AS section_desc,
      c.name AS category_name, c.description AS category_desc,
      p.title, p.content, p.excerpt, p.sort_order, p.is_active
    FROM prompts p
    JOIN prompt_categories c ON p.category_id = c.id
    JOIN prompt_sections s ON c.section_id = s.id
    ORDER BY s.sort_order ASC, c.sort_order ASC, p.sort_order ASC, p.id ASC`);

  const rows = [CSV_HEADERS];
  prompts.forEach(function(p) {
    rows.push([
      p.section_name, p.section_icon || '', p.section_desc || '',
      p.category_name, p.category_desc || '',
      p.title, p.content, p.excerpt || '', p.sort_order, p.is_active
    ]);
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prompts-' + dateStr + '.csv"');
  res.send('\uFEFF' + toCsv(rows));
});

// 下载导入模板（使用说明 + 表头 + 多条示例）（查询权限）
router.get('/prompts/import-template', isAuthenticated, requireView, (req, res) => {
  const rows = [
    ['# 使用说明：用 Excel / WPS 打开本文件，按示例行格式填写后保存为 CSV 再导入。'],
    ['# 必填列：板块、分类、标题、内容；其余列选填。以 # 开头的行（本说明）不会导入。'],
    ['# 板块：同名板块自动复用，不会重复创建；板块图标/描述有值时将更新已有板块。'],
    ['# 分类：同板块下同名分类自动复用；分类描述有值时将更新已有分类。'],
    ['# 内容：支持 Markdown 与换行，可直接粘贴提示词原文；含逗号、引号、换行也能正常处理。'],
    ['# 摘要：卡片上显示的简介，留空则自动从内容截取。'],
    ['# 排序：数字越小越靠前（默认 0）。'],
    ['# 启用：1 启用 / 0 停用（默认 1）。'],
    ['# 重复导入：标题+内容完全相同的提示词会自动跳过。'],
    CSV_HEADERS,
    ['cos后期提示词', '📷', '从「小洛整理场照后期提示词合集」（luocosai.club）导入', '公式模板', '按顺序拼接四条公式使用', '固定前缀 · 锁定原图',
      '# 固定前缀 · 锁定原图\n\n你需要去做一次 cos 后期合成，处理时遵守以下准则：\n- 不改变原有构图、光影、饱和度与色调\n- 不做旋转缩放，不改变人物姿势\n\n# 示例要点\n本行演示：板块、分类、图标、描述齐全的完整写法，内容支持多行与列表。',
      '本示例演示完整写法：板块信息 + 多行 Markdown 内容', 0, 1],
    ['cos后期提示词', '', '', '公式模板', '', '主体描述 · 自定义需求',
      '# 主体描述 · 自定义需求\n\n根据你的需要描述人物特征、服装与场景，保持原图构图不变。',
      '', 1, 1],
    ['cos后期提示词', '', '', '公式模板', '', '停用状态的示例',
      '# 停用状态的示例\n\n启用列填 0 后，前台不会展示这条提示词。',
      '本示例演示：摘要留空自动生成、启用填 0、内容含逗号与"引号"也能正常导入', 2, 0]
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prompts-import-template.csv"');
  res.send('\uFEFF' + toCsv(rows));
});

// 导入 CSV（body: { csv: string }）：板块/分类按名复用、重复跳过
router.post('/prompts/import', isAuthenticated, hasPermission('prompts.manage'), (req, res) => {
  const db = req.db;
  const csvText = (req.body && typeof req.body.csv === 'string') ? req.body.csv : '';

  if (!csvText.trim()) {
    return res.status(400).json({ error: '请上传 CSV 文件' });
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return res.status(400).json({ error: 'CSV 内容为空或缺少数据行' });
  }

  // 表头映射（按列名定位，忽略顺序）
  const headerMap = {};
  rows[0].forEach(function(h, i) {
    const key = String(h).trim();
    if (CSV_HEADERS.indexOf(key) !== -1) headerMap[key] = i;
  });
  if (headerMap['板块'] === undefined || headerMap['分类'] === undefined ||
      headerMap['标题'] === undefined || headerMap['内容'] === undefined) {
    return res.status(400).json({
      error: 'CSV 表头必须包含：板块、分类、标题、内容；可选列：板块图标、板块描述、分类描述、摘要、排序、启用'
    });
  }

  const get = function(row, name) {
    const idx = headerMap[name];
    return idx === undefined ? '' : String(row[idx] === undefined ? '' : row[idx]).trim();
  };

  let createdSections = 0;
  let createdCategories = 0;
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sectionName = get(row, '板块');
    const categoryName = get(row, '分类');
    const title = get(row, '标题');
    const content = get(row, '内容');

    // 以 # 开头的说明行直接跳过；全空行跳过
    if (sectionName.charAt(0) === '#') continue;
    if (!sectionName && !categoryName && !title && !content) continue;

    if (!sectionName || !categoryName || !title || !content) {
      errors.push('第 ' + (i + 1) + ' 行：板块/分类/标题/内容为必填项');
      continue;
    }

    // 板块：按名称查找，不存在则创建；图标/描述有值时更新
    const sectionIcon = get(row, '板块图标');
    const sectionDesc = get(row, '板块描述');
    let section = queryOne(db, 'SELECT id FROM prompt_sections WHERE name = ?', [sectionName]);
    if (!section) {
      db.run('INSERT INTO prompt_sections (name, icon, description, sort_order, is_active) VALUES (?, ?, ?, 9999, 1)',
        [sectionName, sectionIcon, sectionDesc]);
      section = queryOne(db, 'SELECT id FROM prompt_sections WHERE name = ?', [sectionName]);
      createdSections++;
    } else if (sectionIcon || sectionDesc) {
      db.run('UPDATE prompt_sections SET icon = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [sectionIcon || '', sectionDesc || '', section.id]);
    }

    // 分类：按（板块,名称）查找，不存在则创建；描述有值时更新
    const categoryDesc = get(row, '分类描述');
    let category = queryOne(db, 'SELECT id FROM prompt_categories WHERE section_id = ? AND name = ?', [section.id, categoryName]);
    if (!category) {
      db.run('INSERT INTO prompt_categories (section_id, name, description, sort_order, is_active) VALUES (?, ?, ?, 9999, 1)',
        [section.id, categoryName, categoryDesc]);
      category = queryOne(db, 'SELECT id FROM prompt_categories WHERE section_id = ? AND name = ?', [section.id, categoryName]);
      createdCategories++;
    } else if (categoryDesc) {
      db.run('UPDATE prompt_categories SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [categoryDesc, category.id]);
    }

    // 提示词：完全重复则跳过
    const existing = queryOne(db, 'SELECT id FROM prompts WHERE category_id = ? AND title = ? AND content = ?', [category.id, title, content]);
    if (existing) {
      skipped++;
      continue;
    }

    const excerpt = get(row, '摘要') || makeExcerpt(content);
    const sortOrder = parseInt(get(row, '排序'), 10) || 0;
    const isActive = get(row, '启用') === '0' ? 0 : 1;
    db.run('INSERT INTO prompts (category_id, title, content, excerpt, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [category.id, title, content, excerpt, sortOrder, isActive]);
    imported++;
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'import', target_type: 'prompt', target_id: null, target_title: 'CSV导入', detail: '导入提示词 CSV：新增 ' + imported + ' 条（新增板块 ' + createdSections + ' 个、分类 ' + createdCategories + ' 个，跳过重复 ' + skipped + ' 条）', ip: req.ip });
  clearPromptsCache();

  res.json({
    success: true,
    imported: imported,
    createdSections: createdSections,
    createdCategories: createdCategories,
    skipped: skipped,
    errors: errors
  });
});

module.exports = router;
