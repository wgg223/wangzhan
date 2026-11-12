/**
 * AI 聊天上下文组装管线（SillyTavern 式增强）：
 * system（世界书 system_top → 角色卡/提示词模板 → 会话 prompt → 群聊框架 → 记忆 → RAG）
 * → 世界书命中块（assistant_top）→ 当前分支历史窗口（含 in_chat 深度注入 + Author's Note）
 * → 用户消息（user_top 附加）→ 全局 token 预算裁剪
 *
 * 世界书扫描（scanWorldBook）：
 *  - constant 常驻；key 为空视为常驻（向后兼容）
 *  - 主触发词命中「当前消息 + 最近 N 条消息」缓冲区即激活
 *  - selective=1：主键命中 **且** 二级触发词命中任一才激活（SillyTavern AND 语义）
 *  - selective=0：主键 **或** 二级触发词命中任一即激活（二级键是补充触发词，用于扩大召回）
 *  - probability 概率触发（单次生成内只掷一次骰子）
 *  - 递归扫描：新激活条目内容回灌缓冲区再扫，受最大递归步数与 token 预算限制
 *  - in_chat 位置：按 depth 注入到历史窗口倒数第 depth 条消息之前
 *
 * 自动增强（services/ai-chat/world-book.js，扫描期叠加、不落库、不改用户原始数据）：
 *  - 自动二级键：从条目内容抽取专名/术语补进 secondary_keys（仅未勾选选择性时，避免 AND 反而收窄）
 *  - 自动常驻：无触发词 / 触发词全是「世界观」这类全局标签 / 条目名或内容自称全局设定 → 视作 constant
 *  目的：避免设定写了却因为触发词太窄而漏注入（RP-Hub 的「自动生图」条目正是 keys=[] + constant 才必然生效）。
 */
const { queryAll, queryOne } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { estimateTokens } = require('./utils');
const { buildMemoryBlock, memorySettings, getRounds, getRoundSummaryMap, recallRounds, buildRecallBlock } = require('./memory');
const { searchRag, buildRagBlock } = require('./rag');
const { getRegexScripts, applyPromptRegex } = require('./regex');
const worldBookAuto = require('./world-book');

const HISTORY_TOKEN_WINDOW = 3000;
// 世界书触发词扫描深度默认值：同时检查当前消息与最近 N 条消息，避免关键词出现在上一条就失配
const WORLD_SCAN_DEPTH = 6;
// 群聊其余成员卡注入总预算（字符）：按人数均分，避免大群撑爆上下文。
// 10500 = 7 × 1500，保证 8 人及以下群聊每成员仍可获得完整 1500 字摘要（与旧行为一致）。
const GROUP_CARD_BUDGET = 10500;
// 单条消息 token 上限：超过则截断（节省上下文 token）
const MSG_TOKEN_LIMIT = 500;
// 世界书条目内容长度上限（字符）
const WORLD_BOOK_CONTENT_LIMIT = 2000;
// 世界书注入位置全集（in_chat = SillyTavern @Depth 深度注入）
const WORLD_POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'in_chat'];

/**
 * 压缩单条消息：超过 MSG_TOKEN_LIMIT 时截断并添加标记
 */
function compressMessage(content) {
  const text = String(content || '');
  const tokens = estimateTokens(text);
  if (tokens <= MSG_TOKEN_LIMIT) return text;
  // 按字符估算截断位置（1 token ≈ 1.5 字符 for CJK, 4 chars for others）
  const maxChars = Math.floor(MSG_TOKEN_LIMIT * 2.5);
  return text.slice(0, maxChars) + '\n\n[... 消息已截断，原文 ' + tokens + ' tokens]';
}

/**
 * 压缩世界书条目：去重 + 截断长内容
 */
function compressWorldBookEntries(entries) {
  const seen = new Set();
  return (entries || []).filter(e => {
    const key = (e.key || '').trim().toLowerCase();
    const content = String(e.content || '').trim();
    if (!content) return false;
    // 按 key+content 前 100 字符去重
    const dedupKey = key + '|' + content.slice(0, 100);
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    // 截断长内容
    if (content.length > WORLD_BOOK_CONTENT_LIMIT) {
      e.content = content.slice(0, WORLD_BOOK_CONTENT_LIMIT) + '\n[... 已截断]';
    }
    return true;
  });
}

function getRole(db, roleId) {
  if (!roleId) return null;
  return queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [roleId]);
}

// 群聊成员（按 group_members JSON 顺序，过滤已删除角色）
function getGroupMembers(db, conv) {
  let ids = [];
  try { ids = JSON.parse(conv.group_members || '[]'); } catch (e) { ids = []; }
  if (!Array.isArray(ids)) return [];
  return ids.map(id => getRole(db, parseInt(id, 10))).filter(Boolean);
}

function getWorldBook(db, convId) {
  return queryAll(db, 'SELECT * FROM ai_world_book WHERE conversation_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC', [convId]);
}

// 触发词切分统一走 world-book 模块：逗号家族 + 换行切分，英文多词键保持整体（与 RP-Hub / ST 对齐）
const splitKeys = worldBookAuto.splitKeys;

/**
 * 世界书相关后台设置（缺省值兼容旧库：新设置行不存在时按开启处理）
 */
function worldBookConfig(settings) {
  const s = settings || {};
  const contextSize = Math.max(2000, parseInt(s.ai_context_size, 10) || 16000);
  const worldBudgetPct = Math.max(0, Math.min(100, parseInt(s.ai_world_budget_percent, 10) || 25));
  const autoOn = String(s.ai_world_auto_enhance ?? '1') !== '0';
  return {
    contextSize,
    scanDepth: Math.max(1, parseInt(s.ai_world_scan_depth, 10) || WORLD_SCAN_DEPTH),
    recursion: String(s.ai_world_recursion ?? '1') !== '0',
    recursionSteps: parseInt(s.ai_world_recursion_steps, 10) || 4,
    budgetTokens: Math.floor(contextSize * worldBudgetPct / 100),
    autoEnhance: autoOn,
    autoSecondary: autoOn && String(s.ai_world_auto_secondary ?? '1') !== '0',
    autoConstant: autoOn && String(s.ai_world_auto_constant ?? '1') !== '0'
  };
}

/**
 * 取会话世界书 → 压缩去重 → 自动增强（扫描期叠加，不写库）
 * @returns {{entries:Array, cfg:Object, autoConstantCount:number, autoSecondaryCount:number}}
 */
function prepareWorldBook(db, conv, settings) {
  const cfg = worldBookConfig(settings || getSettings(db));
  const entries = compressWorldBookEntries(getWorldBook(db, conv.id));
  if (!cfg.autoEnhance || (!cfg.autoSecondary && !cfg.autoConstant)) {
    return { entries, cfg, autoConstantCount: 0, autoSecondaryCount: 0 };
  }
  const enhanced = worldBookAuto.enhanceEntries(entries, {
    autoSecondary: cfg.autoSecondary,
    autoConstant: cfg.autoConstant
  });
  return {
    entries: enhanced.entries,
    cfg,
    autoConstantCount: enhanced.autoConstantCount,
    autoSecondaryCount: enhanced.autoSecondaryCount
  };
}

/**
 * SillyTavern 式世界书扫描：主键 + 二级键 + 概率 + 递归激活 + token 预算
 * @param {Array} entries - 启用中的条目（已压缩去重，可含自动增强叠加）
 * @param {string} userMsg - 当前用户消息
 * @param {Array} recentMsgs - 最近 N 条消息（扫描缓冲区来源）
 * @param {Object} cfg - { recursion, recursionSteps, budgetTokens, details }
 * @returns {Object} { byPosition, activatedCount, budgetUsed, details? }
 *   details（cfg.details=true 时）：逐条命中诊断，供上下文预览展示
 */
function scanWorldBook(entries, userMsg, recentMsgs, cfg = {}) {
  const list = entries || [];
  const recent = (recentMsgs || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => String(m.content || ''))
    .join('\n');
  let buffer = (String(userMsg || '') + '\n' + recent).toLowerCase();

  const recursion = cfg.recursion !== false;
  const maxSteps = Math.max(1, Math.min(parseInt(cfg.recursionSteps, 10) || 4, 10));
  const budget = Math.max(0, parseInt(cfg.budgetTokens, 10) || 0);
  const wantDetails = cfg.details === true;

  const activated = new Set();   // 条目 id
  const probRoll = new Map();    // 条目 id → 本次生成的概率掷骰结果（只掷一次）
  const info = new Map();        // 条目 id → 诊断（命中原因 / 命中词 / 激活步数）
  const byPosition = {};
  let budgetUsed = 0;

  const setInfo = (e, reason, matched, step) => {
    if (!wantDetails) return;
    info.set(e.id, {
      id: e.id,
      key: String(e.key || ''),
      position: WORLD_POSITIONS.indexOf(e.position) !== -1 ? e.position : 'before_char',
      constant: Boolean(e.constant),
      selective: Boolean(e.selective),
      activated: activated.has(e.id),
      reason,
      matchedKeys: matched || [],
      secondaryKeys: splitKeys(e.secondary_keys),
      auto: e._auto || null,
      step: step == null ? null : step
    });
  };

  const tryActivate = (e, step) => {
    if (activated.has(e.id)) return false;
    // 概率触发（单次生成内只掷一次）
    const prob = e.probability == null ? 100 : Math.max(0, Math.min(100, parseInt(e.probability, 10) || 0));
    if (!probRoll.has(e.id)) probRoll.set(e.id, Math.random() * 100 < prob);
    if (!probRoll.get(e.id)) { setInfo(e, '概率未通过（' + prob + '%）', [], step); return false; }

    let reason = '常驻注入';
    let matched = [];
    if (!e.constant) {
      const keys = splitKeys(e.key);
      const sec = splitKeys(e.secondary_keys);
      const hit = (arr) => arr.filter(k => buffer.indexOf(k) !== -1);
      const primaryHits = hit(keys);
      const secondaryHits = hit(sec);
      // 无触发词 → 视作常驻注入（向后兼容）
      if (keys.length) {
        if (e.selective) {
          // 选择性：主键必须命中，且二级键（若填写）也需命中任一（SillyTavern AND 语义）
          if (!primaryHits.length) { setInfo(e, '主触发词未命中', [], step); return false; }
          if (sec.length && !secondaryHits.length) { setInfo(e, '二级触发词未命中（选择性 AND）', primaryHits, step); return false; }
          reason = '主键 + 二级键命中（选择性）';
          matched = primaryHits.concat(secondaryHits);
        } else {
          // 非选择性：主键或二级键任一命中即可（自动二级键在此扩大召回，不会收窄）
          if (!primaryHits.length && !secondaryHits.length) { setInfo(e, '触发词未命中', [], step); return false; }
          reason = primaryHits.length ? '主触发词命中' : '二级触发词命中';
          matched = primaryHits.length ? primaryHits : secondaryHits;
        }
      }
    }
    // token 预算控制
    const tokens = estimateTokens(String(e.content || ''));
    if (budget > 0 && budgetUsed + tokens > budget) { setInfo(e, '世界书 token 预算不足', matched, step); return false; }
    budgetUsed += tokens;
    activated.add(e.id);
    const pos = WORLD_POSITIONS.indexOf(e.position) !== -1 ? e.position : 'before_char';
    if (!byPosition[pos]) byPosition[pos] = [];
    byPosition[pos].push(e);
    setInfo(e, reason, matched, step);
    return true;
  };

  // 递归扫描状态机：新激活条目内容回灌缓冲区再扫，直到无新激活或达到步数上限
  for (let step = 0; step < maxSteps; step++) {
    const newlyActivated = [];
    list.forEach(e => { if (tryActivate(e, step)) newlyActivated.push(e); });
    if (!newlyActivated.length || !recursion) break;
    buffer += '\n' + newlyActivated.map(e => String(e.content || '')).join('\n').toLowerCase();
  }

  // 每个位置内按 insertion_order（sort_order）排序
  Object.keys(byPosition).forEach(pos => {
    byPosition[pos].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  });
  const out = { byPosition, activatedCount: activated.size, budgetUsed };
  if (wantDetails) {
    out.details = list.map(e => info.get(e.id) || {
      id: e.id, key: String(e.key || ''), position: e.position, constant: Boolean(e.constant),
      selective: Boolean(e.selective), activated: false, reason: '未参与扫描', matchedKeys: [],
      secondaryKeys: splitKeys(e.secondary_keys), auto: e._auto || null, step: null
    });
  }
  return out;
}

/**
 * 世界书命中诊断（上下文预览用）：与 buildContext 走同一套准备 + 扫描逻辑
 * @returns {{config:Object, autoConstantCount:number, autoSecondaryCount:number,
 *            activatedCount:number, budgetUsed:number, details:Array}}
 */
function inspectWorldBook(db, conv, userMsg, opts = {}) {
  const prepared = prepareWorldBook(db, conv, getSettings(db));
  const scanDepth = prepared.cfg.scanDepth;
  const branchId = conv.current_branch_id || 0;
  const history = queryAll(db, 'SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC',
    [conv.id, branchId]);
  const recentForScan = history
    .filter(m => !(opts.excludeMsgId && m.id === opts.excludeMsgId))
    .slice(-scanDepth);
  const scan = scanWorldBook(prepared.entries, userMsg, recentForScan, {
    recursion: prepared.cfg.recursion,
    recursionSteps: prepared.cfg.recursionSteps,
    budgetTokens: prepared.cfg.budgetTokens,
    details: true
  });
  const contentById = new Map(prepared.entries.map(e => [e.id, String(e.content || '')]));
  return {
    config: {
      scanDepth,
      recursion: prepared.cfg.recursion,
      recursionSteps: prepared.cfg.recursionSteps,
      budgetTokens: prepared.cfg.budgetTokens,
      autoEnhance: prepared.cfg.autoEnhance,
      autoSecondary: prepared.cfg.autoSecondary,
      autoConstant: prepared.cfg.autoConstant
    },
    total: prepared.entries.length,
    autoConstantCount: prepared.autoConstantCount,
    autoSecondaryCount: prepared.autoSecondaryCount,
    activatedCount: scan.activatedCount,
    budgetUsed: scan.budgetUsed,
    details: scan.details.map(d => {
      const content = contentById.get(d.id) || '';
      return Object.assign({}, d, {
        excerpt: content.slice(0, 60),
        tokens: estimateTokens(content)
      });
    })
  };
}

/**
 * 兼容旧接口：按位置过滤命中条目
 */
function matchWorldBook(entries, userMsg, recentMsgs, positions) {
  const { byPosition } = scanWorldBook(entries, userMsg, recentMsgs, { recursion: false });
  const out = [];
  (positions || []).forEach(p => { if (byPosition[p]) out.push(...byPosition[p]); });
  return out;
}

/**
 * 全局 token 预算裁剪（SillyTavern ChatCompletion 语义）：
 * 超出预算时从最早的历史消息开始删除，始终保留首条 system、世界书块与最新的用户消息。
 */
function trimMessagesToBudget(messages, budgetTokens) {
  if (!budgetTokens || budgetTokens <= 0) return messages;
  let total = messages.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (total <= budgetTokens) return messages;
  const out = messages.slice();
  // 从索引 1 开始删（保留 out[0] 主 system），保护最后一条消息
  let i = 1;
  while (total > budgetTokens && i < out.length - 1) {
    total -= estimateTokens(out[i].content);
    out.splice(i, 1);
  }
  return out;
}

/**
 * 组装发给模型的 messages 数组
 * @param {Object} db
 * @param {Object} conv
 * @param {string} userMsg - 当前用户消息
 * @param {Object} opts - { excludeMsgId, modelInfo, embCfg, queryEmbedding, speakerRoleId, noUserMsg }
 */
function buildContext(db, conv, userMsg, opts = {}) {
  const { excludeMsgId, embCfg, queryEmbedding, speakerRoleId, noUserMsg } = opts;
  const settings = getSettings(db);
  const isGroup = !!conv.is_group;
  const members = isGroup ? getGroupMembers(db, conv) : [];
  const speaker = isGroup ? (members.find(m => m.id === speakerRoleId) || members[0] || null) : null;
  const role = isGroup ? speaker : getRole(db, conv.role_id);
  // 世界书：压缩去重 + 自动增强（自动二级键 / 自动常驻，扫描期叠加不落库）
  const prepared = prepareWorldBook(db, conv, settings);
  const entries = prepared.entries;

  // ---- 世界书扫描（后台可配：递归/步数/预算/扫描深度/自动增强） ----
  const contextSize = prepared.cfg.contextSize;
  const scanDepth = prepared.cfg.scanDepth;

  // ---- 当前分支历史（先取历史，供世界书触发词扫描与对话窗口复用） ----
  const branchId = conv.current_branch_id || 0;
  const history = queryAll(db, 'SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC',
    [conv.id, branchId]);
  const recentForScan = history
    .filter(m => !(excludeMsgId && m.id === excludeMsgId))
    .slice(-scanDepth);

  const scan = scanWorldBook(entries, userMsg, recentForScan, {
    recursion: prepared.cfg.recursion,
    recursionSteps: prepared.cfg.recursionSteps,
    budgetTokens: prepared.cfg.budgetTokens
  });
  const byPos = scan.byPosition;
  const joinEntries = (pos) => (byPos[pos] || []).map(e => String(e.content || '')).filter(Boolean).join('\n');

  // ---- 记忆 / RAG 块（提前计算，供模板占位符与默认注入共用） ----
  const memoryEnabled = conv.memory_enabled !== 0 && String(settings.ai_memory_enabled ?? '1') !== '0';
  const memoryBlock = memoryEnabled ? (buildMemoryBlock(db, conv, queryEmbedding) || '') : '';
  const ragOn = conv.rag_enabled !== 0 && String(settings.ai_rag_enabled || '0') === '1' && embCfg && queryEmbedding;
  let ragBlock = '';
  if (ragOn) {
    const hits = searchRag(db, queryEmbedding, parseInt(settings.ai_rag_max_results, 10) || 5, parseFloat(settings.ai_rag_min_score) || 0.3);
    ragBlock = buildRagBlock(hits) || '';
  }

  // ---- system 部分 ----
  const systemParts = [];
  const systemTopBlock = joinEntries('system_top');
  if (systemTopBlock) systemParts.push(systemTopBlock);

  const authorNote = String(conv.author_note || '').trim();
  // 世界书 before/after char 块（模板占位符与默认注入共用）
  const beforeCharBlock = joinEntries('before_char');
  const afterCharBlock = joinEntries('after_char');
  const assistantTopBlock = joinEntries('assistant_top');
  const worldAllBlock = [beforeCharBlock, afterCharBlock].filter(Boolean).join('\n');

  let templateUsed = false;
  if (role) {
    // 提示词模板：有模板时用模板替代默认角色卡组装（story string 占位符）
    if (conv.prompt_template_id) {
      const tpl = queryOne(db, 'SELECT content FROM ai_prompt_templates WHERE id = ?', [conv.prompt_template_id]);
      if (tpl && tpl.content) {
        templateUsed = true;
        const userRow = queryOne(db, 'SELECT username FROM users WHERE id = ?', [conv.user_id]);
        const userName = (userRow && userRow.username) || '用户';
        const rendered = tpl.content
          .replace(/\{\{char\}\}/gi, role.name || '')
          .replace(/\{\{user\}\}/gi, userName)
          .replace(/\{\{scenario\}\}/gi, role.scenario || '')
          .replace(/\{\{personality\}\}/gi, role.personality || '')
          .replace(/\{\{description\}\}/gi, role.description || '')
          .replace(/\{\{greeting\}\}/gi, role.greeting || '')
          .replace(/\{\{examples\}\}/gi, role.examples || '')
          .replace(/\{\{wiBefore\}\}/gi, beforeCharBlock)
          .replace(/\{\{wiAfter\}\}/gi, afterCharBlock)
          .replace(/\{\{worldInfo\}\}/gi, worldAllBlock)
          .replace(/\{\{memory\}\}/gi, memoryBlock)
          .replace(/\{\{rag\}\}/gi, ragBlock)
          .replace(/\{\{authorNote\}\}/gi, authorNote);
        systemParts.push(rendered);
      }
    }
    if (!templateUsed) {
      // 默认角色卡组装：世界书包裹角色定义（SillyTavern wi before/after char defs 语义）
      const roleParts = [];
      if (beforeCharBlock) roleParts.push(beforeCharBlock);
      if (role.system_prompt) roleParts.push(role.system_prompt);
      // description 是 Character Card V2/V3 的主人设字段，许多卡把人设全放这里，
      // personality/scenario 留空；不注入会导致这类卡得到空人设。
      if (role.description) roleParts.push('【角色设定】\n' + role.description);
      if (role.personality) roleParts.push('【角色性格】\n' + role.personality);
      if (role.scenario) roleParts.push('【当前场景】\n' + role.scenario);
      if (role.examples) roleParts.push('【示例对话（仅供模仿风格，不要复述）】\n' + role.examples);
      if (afterCharBlock) roleParts.push(afterCharBlock);
      if (roleParts.length) systemParts.push(roleParts.join('\n\n'));
    }
  } else if (!templateUsed && worldAllBlock) {
    systemParts.push(worldAllBlock);
  }
  if (conv.system_prompt) systemParts.push(conv.system_prompt);

  // 群聊框架：扮演当前说话人，其余成员卡摘要注入（SillyTavern Group Chats 语义）
  if (isGroup && members.length) {
    const groupLines = ['【群聊设定】这是多角色群聊。你现在扮演「' + (role ? role.name : '未知角色') + '」，只以该角色的身份回复，不要替其他角色或用户发言，回复不要带名字前缀。'];
    groupLines.push('群成员：' + members.map(m => m.name).join('、'));
    const others = members.filter(m => !role || m.id !== role.id);
    const perCard = others.length ? Math.min(1500, Math.floor(GROUP_CARD_BUDGET / others.length)) : 1500;
    others.forEach(m => {
      // 成员摘要按重要性排序；scenario 单独预留槽位，避免被大段 description 挤掉后整段丢失
      const core = [m.system_prompt, m.personality, m.description].filter(Boolean).join('\n');
      const scen = String(m.scenario || '').trim();
      const scenPart = scen ? '【所在场景】' + scen : '';
      const reserve = scenPart ? Math.min(300, scenPart.length) : 0;
      const coreCut = core.slice(0, Math.max(0, perCard - reserve));
      const card = [coreCut, scenPart.slice(0, 300)].filter(Boolean).join('\n');
      if (card) groupLines.push('成员「' + m.name + '」的设定：\n' + card);
    });
    systemParts.push(groupLines.join('\n'));
  }

  // 记忆块（模板未通过占位符消费时默认注入）
  const templateHasMemory = templateUsed && /\{\{memory\}\}/i.test(getTemplateContent(db, conv));
  if (memoryBlock && !templateHasMemory) systemParts.push(memoryBlock);
  // RAG 块
  const templateHasRag = templateUsed && /\{\{rag\}\}/i.test(getTemplateContent(db, conv));
  if (ragBlock && !templateHasRag) systemParts.push(ragBlock);

  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];

  // ---- 世界书 assistant_top：归入独立上下文块 ----
  if (assistantTopBlock) {
    messages.push({
      role: 'user',
      content: '（场景设定，请遵循但不要提及此设定）\n' + assistantTopBlock
    });
  }

  // ---- 当前分支历史窗口（楼层制：最近 keepRecent 楼全文，更早楼 AI 正文以逐轮总结替代） ----
  const memSettings = memorySettings();
  const memoryOn = conv.memory_enabled !== 0 && memSettings.enabled;
  const summaryMap = memoryOn ? getRoundSummaryMap(db, conv.id) : {};
  const rounds = memoryOn ? getRounds(db, conv.id, branchId) : [];
  const useFloors = memoryOn && rounds.length > 0;
  const historyWindow = Math.max(500, parseInt(settings.ai_history_window, 10) || HISTORY_TOKEN_WINDOW);

  // 决定保留全文的楼：从最新楼往前，最多 keepRecent 楼且不超过 token 窗口
  const fullRoundSet = new Set();
  let budget = historyWindow;
  let fullCount = 0;
  for (let i = rounds.length - 1; i >= 0 && fullCount < memSettings.keepRecent; i--) {
    const r = rounds[i];
    if (excludeMsgId && r.userMsgId === excludeMsgId) continue;
    const floorTokens = estimateTokens(r.userInput) + r.assistantMsgs.reduce((s, a) => s + estimateTokens(a.content), 0);
    if (budget - floorTokens < 0 && fullRoundSet.size) break;
    budget -= floorTokens;
    fullRoundSet.add(r.index);
    fullCount++;
  }

  let windowMsgs = [];
  if (useFloors) {
    rounds.forEach(r => {
      if (excludeMsgId && r.userMsgId === excludeMsgId) return;
      windowMsgs.push({ role: 'user', content: compressMessage(r.userInput), speaker_role_id: null });
      if (fullRoundSet.has(r.index)) {
        r.assistantMsgs.forEach(a => {
          if (a.status === 'error' || a.status === 'stopped') return;
          windowMsgs.push({ role: 'assistant', content: compressMessage(a.content), speaker_role_id: a.speaker_role_id || null });
        });
      } else {
        // 较早楼：用户原文保留，AI 正文以对应逐轮总结替代（不删除原聊天）
        const summary = summaryMap[r.index];
        if (summary) {
          windowMsgs.push({ role: 'assistant', content: '[历史总结] ' + summary, speaker_role_id: null });
        } else {
          r.assistantMsgs.forEach(a => {
            if (a.status === 'error' || a.status === 'stopped') return;
            windowMsgs.push({ role: 'assistant', content: compressMessage(a.content), speaker_role_id: a.speaker_role_id || null });
          });
        }
      }
    });
  } else {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (excludeMsgId && m.id === excludeMsgId) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (m.status === 'error' || m.status === 'stopped') continue;
      if (m.is_active === 0) continue; // 跳过非活跃 alternate
      const compressed = compressMessage(m.content);
      windowMsgs.unshift({ role: m.role, content: compressed, speaker_role_id: m.speaker_role_id || null });
    }
  }

  // ---- 深度注入（SillyTavern @Depth / Author's Note 语义）----
  // 收集 { depth → [system 消息] }，插入到倒数第 depth 条历史消息之前
  const depthInserts = new Map();
  const addDepthInsert = (depth, msg) => {
    const d = Math.max(0, parseInt(depth, 10) || 0);
    if (!depthInserts.has(d)) depthInserts.set(d, []);
    depthInserts.get(d).push(msg);
  };
  // 世界书 in_chat 条目
  (byPos.in_chat || []).forEach(e => {
    addDepthInsert(e.depth != null ? e.depth : 4, {
      role: 'system',
      content: '（场景设定，请遵循但不要提及此设定）\n' + String(e.content || '')
    });
  });
  // 作者注释（模板已消费时不再默认注入）
  const templateHasNote = templateUsed && /\{\{authorNote\}\}/i.test(getTemplateContent(db, conv));
  if (authorNote && !templateHasNote) {
    addDepthInsert(conv.author_note_depth != null ? conv.author_note_depth : 4, {
      role: 'system',
      content: "[Author's Note: " + authorNote + ']'
    });
  }

  const insertedDepths = new Set();
  windowMsgs.forEach((m, idx) => {
    // 在倒数第 depth 条消息前插入到点的深度内容
    const depthFromEnd = windowMsgs.length - idx;
    if (depthInserts.has(depthFromEnd) && !insertedDepths.has(depthFromEnd)) {
      depthInserts.get(depthFromEnd).forEach(msg => messages.push(msg));
      insertedDepths.add(depthFromEnd);
    }
    // 群聊中其他角色的发言归入 user 侧并带名字前缀，当前说话人的历史保持 assistant
    if (isGroup && m.role === 'assistant' && m.speaker_role_id && role && m.speaker_role_id !== role.id) {
      const sp = members.find(x => x.id === m.speaker_role_id);
      messages.push({ role: 'user', content: (sp ? sp.name : '角色') + ': ' + String(m.content || '') });
    } else {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
    }
  });
  // 历史太短没插入的深度内容，放在历史最前面（system 之后）
  depthInserts.forEach((msgs, d) => {
    if (!insertedDepths.has(d)) msgs.forEach(msg => messages.splice(1, 0, msg));
  });

  // ---- 用户消息（user_top 世界书条目附加到消息尾部；noUserMsg 用于群聊手动顶帖） ----
  if (!noUserMsg) {
    const userTopBlock = joinEntries('user_top');
    let finalUserMsg = String(userMsg || '');
    if (userTopBlock) finalUserMsg += '\n\n（附加设定）\n' + userTopBlock;
    messages.push({ role: 'user', content: finalUserMsg });
    // 增强模式：按最新输入召回逐轮记忆，按原时间序附在最新用户消息后（仅本次请求）
    const vecMode = conv.memory_mode === 'vector' || conv.memory_mode === 'both';
    if (memoryOn && vecMode && embCfg && queryEmbedding) {
      const recalled = recallRounds(db, conv.id, queryEmbedding, embCfg.model_key, memSettings.recallMinScore, memSettings.recallMax);
      const recallBlock = buildRecallBlock(recalled);
      if (recallBlock) messages.push({ role: 'user', content: recallBlock });
    }
  }

  // ---- 全局 token 预算裁剪 ----
  const trimmed = trimMessagesToBudget(messages, contextSize);
  // ---- prompt 侧正则后处理（SillyTavern Regex 式）：所有生成路径的统一 chokepoint ----
  // 在裁剪后应用，depth 以最终发送的消息数组为准；预览路由亦经此函数，故所见即所送。
  return applyPromptRegex(trimmed, getRegexScripts(db, conv.user_id));
}

// 模板内容短缓存（60s TTL，判断占位符是否被模板消费；避免每条消息重复查库）
const templateCache = new Map();
function getTemplateContent(db, conv) {
  if (!conv.prompt_template_id) return '';
  const id = conv.prompt_template_id;
  const hit = templateCache.get(id);
  if (hit && Date.now() - hit.ts < 60000) return hit.content;
  const tpl = queryOne(db, 'SELECT content FROM ai_prompt_templates WHERE id = ?', [id]);
  const content = (tpl && tpl.content) || '';
  templateCache.set(id, { content, ts: Date.now() });
  return content;
}

module.exports = {
  buildContext, getRole, getGroupMembers, getWorldBook, matchWorldBook, scanWorldBook,
  prepareWorldBook, worldBookConfig, inspectWorldBook,
  trimMessagesToBudget, WORLD_POSITIONS, HISTORY_TOKEN_WINDOW
};
