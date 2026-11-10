/**
 * AI 角色卡（Character Card V2/V3 · SillyTavern / RP-Hub 兼容）解析、归一化与视图裁剪
 * 作用：
 *   - normalizeCard()   把外部角色卡（V1 char_name / V2 chara_card_v2 / V3 chara_card_v3）归一为站内字段；
 *   - normalizeWorldBook() 把卡内 character_book（lorebook）归一为站内世界书条目，供建会话时勾选注入；
 *   - roleToCard()      站内角色 → chara_card_v2 导出体（含 character_book）；
 *   - publicCardView()  角色卡广场视图裁剪：游客只给摘要，登录用户给全文（但永不给「导出」能力）；
 *   - loadSeedCards()   读取 server/config/seed-characters/*.json 作为官方卡语料（首次安装播种）。
 * 安全与边界：
 *   - 所有字段做长度截断与类型收敛，外部 JSON 不直接进入 SQL/模板；
 *   - 头像只接受站内路径或 data URL，绝不代抓远程图片（防 SSRF 与外链失效）；
 *   - 导入他人分享的卡标记 source_type='imported'，此类卡不可再次分享、不可导出（防内容外溢）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 字段长度上限（与 ai_roles 列语义一致）
const LIMITS = {
  name: 50,
  description: 500,
  personality: 4000,
  scenario: 4000,
  greeting: 2000,
  alternate: 2000,
  alternateMax: 5,
  system_prompt: 32000,
  post_history: 8000,
  examples: 8000,
  creator_notes: 1000,
  creator: 100,
  version: 50,
  category: 50,
  tag: 30,
  tagMax: 10,
  avatar: 2000,
  sourceUrl: 500,
  license: 200,
  bookName: 100,
  bookDesc: 500,
  bookEntries: 50,
  bookEntryKey: 300,
  bookEntryContent: 20000,
  extensions: 4000
};

// 站内世界书位置（与 routes/frontend.js 的 WORLD_BOOK_POSITIONS 一致）
const POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'in_chat'];
// SillyTavern lorebook 位置 → 站内位置（at_depth 对应站内 in_chat + depth）
const ST_POSITION_MAP = {
  before_char: 'before_char',
  after_char: 'after_char',
  at_depth: 'in_chat',
  in_chat: 'in_chat',
  system_top: 'system_top',
  user_top: 'user_top',
  assistant_top: 'assistant_top'
};
// 站内位置 → lorebook 位置（导出时还原）
const INTERNAL_POSITION_MAP = {
  system_top: 'before_char',
  before_char: 'before_char',
  after_char: 'after_char',
  user_top: 'before_char',
  assistant_top: 'after_char',
  in_chat: 'at_depth'
};

const SOURCE_TYPES = ['self', 'external', 'hub', 'official'];
// self     本站表单创建        → 可分享、可导出
// external 外部文件 / URL 导入 → 可分享、可导出（内容本来就是用户带进来的）
// hub      从站内广场导入他人卡 → 仅可自己使用：不可再次分享、不可导出（防内容外溢）
// official 官方卡              → 全站可用，不可分享（由后台治理）
const NO_EXPORT_SOURCE = 'hub';

// 是否允许导出该卡（还需叠加 aichat.export 权限）
function canExportCard(row) {
  return (row && row.source_type ? row.source_type : 'self') !== NO_EXPORT_SOURCE;
}

// 是否允许把该卡分享到广场
function canShareCard(row) {
  if (!row) return false;
  if (row.is_official) return false;
  return (row.source_type || 'self') !== NO_EXPORT_SOURCE;
}

function txt(v, max) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  s = s.replace(/\r\n/g, '\n').trim();
  return max ? s.slice(0, max) : s;
}

function intOr(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  let out = n;
  if (typeof min === 'number' && out < min) out = min;
  if (typeof max === 'number' && out > max) out = max;
  return out;
}

function bool01(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

// 字符串数组归一：去空、去重、截断长度与条数
function strArray(v, itemMax, countMax) {
  let arr = v;
  if (typeof arr === 'string') {
    const s = arr.trim();
    if (!s) return [];
    try { arr = JSON.parse(s); } catch (e) { arr = s.split(/[,，;；]/); }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  arr.forEach(item => {
    const s = txt(item, itemMax);
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  });
  return out.slice(0, countMax);
}

// 触发词数组 → 逗号连接字符串（站内世界书 key 字段形态）
function joinKeys(v) {
  const arr = strArray(v, LIMITS.bookEntryKey, 30);
  return arr.join(',').slice(0, LIMITS.bookEntryKey);
}

/**
 * 归一化角色卡内世界书（lorebook）
 * 兼容三种输入：
 *   1) SillyTavern V2/V3：{ name, description, entries: [{keys[], secondary_keys[], comment, content, constant, selective, order, position, disable, depth, extensions}] }
 *   2) V3 变体：entries 为对象字典（{ "0": {...} }）
 *   3) 本站已归一化格式：{ name, description, entries: [{key, secondary_keys, content, ...}] }
 * @returns {{name:string, description:string, entries:Array}|null}
 */
function normalizeWorldBook(raw) {
  let book = raw;
  // 容错：站内表单/接口可能把世界书以 JSON 字符串形式提交
  if (typeof book === 'string') {
    const s = book.trim();
    if (!s) return null;
    try { book = JSON.parse(s); } catch (e) { return null; }
  }
  if (!book || typeof book !== 'object') return null;
  let rawEntries = book.entries;
  if (rawEntries && !Array.isArray(rawEntries) && typeof rawEntries === 'object') {
    rawEntries = Object.keys(rawEntries).map(k => rawEntries[k]);
  }
  if (!Array.isArray(rawEntries) || !rawEntries.length) return null;

  const entries = [];
  rawEntries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || entries.length >= LIMITS.bookEntries) return;
    const content = txt(e.content, LIMITS.bookEntryContent);
    if (!content) return;
    const ext = (e.extensions && typeof e.extensions === 'object') ? e.extensions : {};
    // key：优先 keys[]（ST），回退本站 key 字符串；都为空时用条目名（comment）兜底
    let key = Array.isArray(e.keys) ? joinKeys(e.keys) : joinKeys(e.key);
    const name = txt(e.comment || e.name || e.title, LIMITS.bookEntryKey);
    if (!key && name) key = name.slice(0, LIMITS.bookEntryKey);
    const rawPos = txt(e.position, 30) || txt(ext.position, 30);
    const position = ST_POSITION_MAP[rawPos] || 'before_char';
    const depth = intOr(e.depth != null ? e.depth : ext.depth, 4, 0, 200);
    const probability = intOr(e.probability != null ? e.probability : ext.probability, 100, 0, 100);
    entries.push({
      key: key.slice(0, LIMITS.bookEntryKey),
      name,
      secondary_keys: joinKeys(e.secondary_keys).slice(0, LIMITS.bookEntryKey),
      content,
      constant: bool01(e.constant),
      selective: bool01(e.selective),
      position,
      depth,
      probability,
      enabled: e.disable === true || e.disable === 1 || e.enabled === false || e.enabled === 0 ? 0 : 1,
      sort_order: intOr(e.order != null ? e.order : (e.sort_order != null ? e.sort_order : i), i, 0, 99999)
    });
  });
  if (!entries.length) return null;
  return {
    name: txt(book.name, LIMITS.bookName),
    description: txt(book.description, LIMITS.bookDesc),
    scan_depth: intOr(book.scan_depth, 0, 0, 200),
    recursive_scanning: bool01(book.recursive_scanning),
    entries
  };
}

// 世界书 JSON 字符串 → 条目数组（容错解析）
function parseWorldBook(row) {
  const raw = row && row.world_book ? String(row.world_book) : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return normalizeWorldBook(parsed);
  } catch (e) {
    return null;
  }
}

/**
 * 归一化外部角色卡 → 站内字段对象
 * @param {object} card 角色卡原始 JSON（{spec, data} 或裸 data）
 * @param {string} [fileName] 文件名（缺名称时兜底）
 * @returns {object|null} 归一化结果；缺名称或全空内容时返回 null
 */
function normalizeCard(card, fileName) {
  if (!card || typeof card !== 'object') return null;
  const data = (card.data && typeof card.data === 'object') ? card.data : card;
  const ext = (data.extensions && typeof data.extensions === 'object') ? data.extensions : {};

  const name = txt(data.name || data.char_name, LIMITS.name) ||
    txt(String(fileName || '').replace(/\.(json|png)$/i, ''), LIMITS.name);
  if (!name) return null;

  const description = txt(data.description || data.char_desc, LIMITS.description);
  const personality = txt(data.personality || data.char_persona, LIMITS.personality);
  const scenario = txt(data.scenario || data.world_scenario, LIMITS.scenario);
  const greeting = txt(data.first_mes || data.greeting || data.char_greeting, LIMITS.greeting);
  const systemPrompt = txt(data.system_prompt || data.system, LIMITS.system_prompt);
  const examples = txt(data.mes_example || data.examples || data.mesExample || data.example_dialogue, LIMITS.examples);
  if (!description && !personality && !scenario && !greeting && !systemPrompt) return null;

  const alternates = strArray(data.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax);
  const tags = strArray(data.tags, LIMITS.tag, LIMITS.tagMax);

  // 世界书：V2/V3 均在 data.character_book；部分 V3 卡放在 extensions.world；
  // 站内表单直接提交 world_book（JSON 字符串）
  const rawBook = data.character_book || data.world_book || ext.world || null;
  const book = normalizeWorldBook(rawBook);

  // extensions 只保留常见且体积可控的字段（talkativeness / fav / depth_prompt / world 概要）
  const safeExt = {};
  ['talkativeness', 'fav', 'favorite', 'depth_prompt', 'world'].forEach(k => {
    if (ext[k] === undefined) return;
    safeExt[k] = k === 'world' ? { name: txt(ext[k] && ext[k].name, LIMITS.bookName) } : ext[k];
  });
  let extJson = '';
  try {
    extJson = JSON.stringify(safeExt).slice(0, LIMITS.extensions);
  } catch (e) { extJson = ''; }

  return {
    name,
    description,
    personality,
    scenario,
    greeting,
    alternate_greetings: alternates,
    system_prompt: systemPrompt,
    post_history_instructions: txt(data.post_history_instructions, LIMITS.post_history),
    examples,
    creator_notes: txt(data.creator_notes, LIMITS.creator_notes),
    creator: txt(data.creator, LIMITS.creator),
    character_version: txt(data.character_version || data.char_version, LIMITS.version),
    tags,
    category: txt(data.category || (tags.length ? tags[0] : ''), LIMITS.category) || 'default',
    avatar: txt(data.avatar || data.avatar_url || data.image, LIMITS.avatar),
    world_book: book,
    extensions: extJson,
    spec: txt(card.spec || data.spec, 30)
  };
}

/**
 * 归一化结果 → ai_roles 列值（数组/对象序列化为字符串）
 * 不含 is_official / user_id / source_* / is_shared 等归属字段，由调用方决定
 */
function cardToColumns(norm) {
  const book = norm && norm.world_book ? norm.world_book : null;
  return {
    name: norm.name,
    description: norm.description || '',
    personality: norm.personality || '',
    scenario: norm.scenario || '',
    greeting: norm.greeting || '',
    system_prompt: norm.system_prompt || '',
    post_history_instructions: norm.post_history_instructions || '',
    examples: norm.examples || '',
    creator_notes: norm.creator_notes || '',
    creator: norm.creator || '',
    character_version: norm.character_version || '',
    category: norm.category || 'default',
    avatar: norm.avatar || '',
    alternate_greetings: JSON.stringify(norm.alternate_greetings || []),
    tags: JSON.stringify(norm.tags || []),
    world_book: book ? JSON.stringify(book) : '',
    extensions: norm.extensions || '{}'
  };
}

// ai_roles 插入列顺序（配合 cardToColumns 使用）
const ROLE_CARD_COLUMNS = [
  'name', 'description', 'personality', 'scenario', 'greeting', 'system_prompt',
  'post_history_instructions', 'examples', 'creator_notes', 'creator', 'character_version',
  'category', 'avatar', 'alternate_greetings', 'tags', 'world_book', 'extensions'
];

/**
 * 解析角色卡创建/更新请求体：既支持扁平字段（表单直填），也支持 card 对象（导入）
 * @returns {object|null}
 */
function parseRolePayload(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const card = raw.card && typeof raw.card === 'object' ? raw.card : null;
  const norm = card ? normalizeCard(card, raw.file_name) : normalizeCard({ data: raw }, '');
  if (!norm) return null;
  // 表单显式传入的分类优先于从 tags 推导
  if (raw.category) norm.category = txt(raw.category, LIMITS.category);
  return norm;
}

// 站内角色 → chara_card_v2 导出体（含 character_book，SillyTavern 可直接读取）
function roleToCard(row) {
  const book = parseWorldBook(row);
  const tags = strArray(row && row.tags, LIMITS.tag, LIMITS.tagMax);
  const data = {
    name: row.name,
    description: row.description || '',
    personality: row.personality || '',
    scenario: row.scenario || '',
    first_mes: row.greeting || '',
    mes_example: row.examples || '',
    system_prompt: row.system_prompt || '',
    post_history_instructions: row.post_history_instructions || '',
    alternate_greetings: strArray(row && row.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax),
    creator_notes: row.creator_notes || '',
    creator: row.creator || (row.is_official ? 'Site Official' : ''),
    character_version: row.character_version || '1.0',
    tags: tags.length ? tags : [row.category || 'default'],
    extensions: {}
  };
  let ext = {};
  try { ext = JSON.parse(row.extensions || '{}'); } catch (e) { ext = {}; }
  if (ext && typeof ext === 'object') {
    Object.keys(ext).forEach(k => { if (k !== 'world') data.extensions[k] = ext[k]; });
  }
  if (book) {
    data.character_book = {
      name: book.name || row.name + ' Lorebook',
      description: book.description || '',
      scan_depth: book.scan_depth || undefined,
      recursive_scanning: Boolean(book.recursive_scanning),
      book_version: '2.0',
      entries: book.entries.map(e => ({
        keys: e.key ? String(e.key).split(',').map(s => s.trim()).filter(Boolean) : [],
        secondary_keys: e.secondary_keys ? String(e.secondary_keys).split(',').map(s => s.trim()).filter(Boolean) : [],
        comment: e.name || '',
        content: e.content,
        constant: Boolean(e.constant),
        selective: Boolean(e.selective),
        order: e.sort_order || 0,
        position: INTERNAL_POSITION_MAP[e.position] || 'before_char',
        disable: !e.enabled,
        extensions: { depth: e.depth, probability: e.probability }
      }))
    };
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

// 世界书条目 → 可直接写入 ai_world_book 的对象数组（会话注入用）
function bookEntriesForInjection(row) {
  const book = parseWorldBook(row);
  if (!book) return [];
  return book.entries.map(e => ({
    key: e.key,
    content: e.content,
    position: POSITIONS.indexOf(e.position) !== -1 ? e.position : 'before_char',
    sort_order: e.sort_order || 0,
    enabled: e.enabled ? 1 : 0,
    constant: e.constant ? 1 : 0,
    secondary_keys: e.secondary_keys || '',
    selective: e.selective ? 1 : 0,
    probability: e.probability == null ? 100 : e.probability,
    depth: e.depth == null ? 4 : e.depth
  }));
}

// 选择开场白：index 0 = first_mes，1..n = alternate_greetings
function pickGreeting(row, index) {
  const idx = intOr(index, 0, 0, 99);
  if (idx <= 0) return txt(row && row.greeting, LIMITS.greeting);
  const alternates = strArray(row && row.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax);
  return txt(alternates[idx - 1] || '', LIMITS.greeting);
}

// 分享短链 token（URL 安全，14 字符）
function generateShareToken() {
  return crypto.randomBytes(10).toString('base64url');
}

// 头像只允许站内路径或 data URL（拒绝外链，避免 SSRF / 失效 / 追踪像素）
function sanitizeAvatar(v) {
  const s = txt(v, LIMITS.avatar);
  if (!s) return '';
  if (s.indexOf('/uploads/') === 0 || s.indexOf('/assets/') === 0) return s;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s) && s.length <= 400000) return s;
  return '';
}

/**
 * 角色卡广场视图裁剪
 * @param {object} row ai_roles 行
 * @param {object} opts { guest: boolean, list: boolean }
 *   - list=true  → 列表摘要（不含正文）
 *   - guest=true → 游客只读：正文一律不给，仅摘要 + 开场白预览 + 世界书 key 列表
 */
function publicCardView(row, opts) {
  const o = opts || {};
  const book = parseWorldBook(row);
  const tags = strArray(row.tags, LIMITS.tag, LIMITS.tagMax);
  const alternates = strArray(row.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax);
  const base = {
    id: row.id,
    token: row.share_token || '',
    name: row.name,
    avatar: row.avatar || '',
    description: row.description || '',
    category: row.category || 'default',
    tags,
    creator: row.creator || '',
    character_version: row.character_version || '',
    creator_notes: o.guest ? '' : (row.creator_notes || ''),
    license: row.license || '',
    is_official: row.is_official ? 1 : 0,
    is_shared: row.is_shared ? 1 : 0,
    source_type: row.source_type || 'self',
    // 广场视图永不提供导出能力（防内容外溢）；导出仅在 AI 聊天页按权限开放
    can_export: false,
    has_book: book ? 1 : 0,
    book_entries: book ? book.entries.length : 0,
    book_name: book ? (book.name || '') : '',
    alternate_count: alternates.length,
    greeting_preview: txt(row.greeting, 200),
    import_count: row.import_count || 0,
    view_count: row.view_count || 0,
    shared_at: row.shared_at || row.created_at || '',
    created_at: row.created_at || ''
  };
  if (o.list) return base;
  if (o.guest) {
    // 游客：额外给场景/性格的极短预览与世界书触发词，正文需登录
    base.personality_preview = txt(row.personality, 120);
    base.scenario_preview = txt(row.scenario, 120);
    base.book_keys = book ? book.entries.slice(0, 30).map(e => e.key).filter(Boolean) : [];
    base.system_prompt_length = String(row.system_prompt || '').length;
    base.need_login = true;
    return base;
  }
  // 登录用户：全文（但无导出能力）
  base.personality = row.personality || '';
  base.scenario = row.scenario || '';
  base.examples = row.examples || '';
  base.system_prompt = row.system_prompt || '';
  base.post_history_instructions = row.post_history_instructions || '';
  base.greeting = row.greeting || '';
  base.alternate_greetings = alternates;
  base.world_book = book;
  base.need_login = false;
  return base;
}

// 作者/管理员视图（含内部 id 与归属）
function ownerCardView(row) {
  const view = publicCardView(row, { list: false, guest: false });
  view.id = row.id;
  view.user_id = row.user_id;
  view.source_role_id = row.source_role_id || null;
  view.source_url = row.source_url || '';
  view.can_share = canShareCard(row);
  view.is_shared = row.is_shared ? 1 : 0;
  view.share_url = row.share_token ? '/characters?card=' + row.share_token : '';
  return view;
}

/**
 * AI 聊天页角色对象
 * @param {object} row ai_roles 行
 * @param {object} opts { canExport: boolean, lean: boolean }
 *   lean=true（bootstrap 用）→ 不下发 personality / scenario / examples / system_prompt /
 *   post_history_instructions / alternate_greetings 全文 / world_book，避免上百张官方卡把首屏撑爆；
 *   需要全文时走 GET /ai-chat/api/roles/:id
 */
function chatRoleView(row, opts) {
  const o = opts || {};
  const book = parseWorldBook(row);
  const view = {
    id: row.id,
    name: row.name,
    avatar: row.avatar || '',
    description: row.description || '',
    category: row.category || 'default',
    is_official: row.is_official ? 1 : 0,
    user_id: row.user_id,
    greeting: row.greeting || '',
    tags: strArray(row.tags, LIMITS.tag, LIMITS.tagMax),
    creator: row.creator || '',
    character_version: row.character_version || '',
    license: row.license || '',
    source_type: row.source_type || 'self',
    source_role_id: row.source_role_id || null,
    source_url: row.source_url || '',
    book_count: book ? book.entries.length : 0,
    book_name: book ? (book.name || '') : '',
    alternate_count: strArray(row.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax).length,
    is_shared: row.is_shared ? 1 : 0,
    share_token: row.is_shared ? (row.share_token || '') : '',
    share_url: (row.is_shared && row.share_token) ? '/characters?card=' + row.share_token : '',
    import_count: row.import_count || 0,
    view_count: row.view_count || 0,
    can_export: !!o.canExport && canExportCard(row),
    can_share: canShareCard(row),
    lean: o.lean ? 1 : 0
  };
  if (!o.lean) {
    view.personality = row.personality || '';
    view.scenario = row.scenario || '';
    view.examples = row.examples || '';
    view.system_prompt = row.system_prompt || '';
    view.post_history_instructions = row.post_history_instructions || '';
    view.creator_notes = row.creator_notes || '';
    view.alternate_greetings = strArray(row.alternate_greetings, LIMITS.alternate, LIMITS.alternateMax);
    view.world_book = book;
    let ext = {};
    try { ext = JSON.parse(row.extensions || '{}'); } catch (e) { ext = {}; }
    view.extensions = ext;
  }
  return view;
}

/**
 * 待注入世界书弹窗数据（建会话 / 切角色时返回给前端）
 * 只给预览（内容前 200 字 + 长度），全文在用户勾选确认后由服务端按 index 取用，
 * 避免把整本 lorebook 塞进首屏响应，也避免前端伪造条目内容。
 * @param {object} row ai_roles 行（需含 world_book）
 * @returns {object|null}
 */
function pendingBookView(row) {
  const book = parseWorldBook(row);
  if (!book || !book.entries.length) return null;
  return {
    role_id: row.id,
    role_name: row.name,
    book_name: book.name || '',
    book_description: book.description || '',
    total: book.entries.length,
    entries: book.entries.map((e, i) => ({
      index: i,
      key: e.key || '',
      name: e.name || '',
      content_preview: String(e.content || '').slice(0, 200),
      content_length: String(e.content || '').length,
      constant: e.constant ? 1 : 0,
      selective: e.selective ? 1 : 0,
      position: e.position,
      depth: e.depth,
      probability: e.probability,
      enabled: e.enabled ? 1 : 0
    }))
  };
}

/**
 * 读取官方卡语料（server/config/seed-characters/*.json）
 * 语料既支持本站归一化格式（含 slug/source/sfw），也支持原生 chara_card_v2 JSON
 * @returns {Array<object>} 归一化后的卡（附 slug/source/license/sfw 元信息）
 */
function loadSeedCards(dir) {
  const target = dir || path.join(__dirname, '../../config/seed-characters');
  let files = [];
  try {
    files = fs.readdirSync(target).filter(f => /\.json$/i.test(f));
  } catch (e) {
    return []; // 语料目录不存在（未提供官方卡）时静默跳过
  }
  const out = [];
  files.forEach(f => {
    try {
      const raw = fs.readFileSync(path.join(target, f), 'utf8');
      const json = JSON.parse(raw);
      // 本站语料格式：{ slug, name, ..., world_book, source, sfw } → 走 normalizeCard（字段名兼容）
      const norm = normalizeCard(json, f);
      if (!norm) return;
      if (json.sfw === false) return; // 双保险：语料若被标为 SFW=false 直接跳过
      norm.slug = txt(json.slug, 60) || f.replace(/\.json$/i, '');
      norm.license = txt(json.license || (json.source && json.source.license), LIMITS.license);
      norm.source = (json.source && typeof json.source === 'object') ? {
        repo: txt(json.source.repo, 200),
        path: txt(json.source.path, 300),
        url: txt(json.source.url, LIMITS.sourceUrl),
        license: txt(json.source.license, LIMITS.license),
        author: txt(json.source.author, LIMITS.creator),
        note: txt(json.source.note, 300)
      } : null;
      norm.source_url = norm.source && norm.source.url ? norm.source.url : txt(json.source_url, LIMITS.sourceUrl);
      if (!norm.creator && norm.source && norm.source.author) norm.creator = norm.source.author;
      out.push(norm);
    } catch (e) {
      console.warn('[seed-characters] 跳过无法解析的官方卡语料：' + f + '（' + e.message + '）');
    }
  });
  return out;
}

module.exports = {
  LIMITS,
  POSITIONS,
  SOURCE_TYPES,
  NO_EXPORT_SOURCE,
  canExportCard,
  canShareCard,
  normalizeCard,
  normalizeWorldBook,
  parseWorldBook,
  cardToColumns,
  ROLE_CARD_COLUMNS,
  parseRolePayload,
  roleToCard,
  bookEntriesForInjection,
  pickGreeting,
  generateShareToken,
  sanitizeAvatar,
  publicCardView,
  ownerCardView,
  chatRoleView,
  pendingBookView,
  loadSeedCards,
  strArray,
  txt
};
