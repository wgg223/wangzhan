/**
 * 世界书自动增强（auto-enhance）：自动补二级键 + 自动识别常驻
 *
 * 解决的问题：角色卡/手动条目写了设定，但触发词太窄（或干脆是「世界观」「设定」这类
 * 永远不会出现在对话里的标签词），导致关键词命中不了 → 设定漏注入 → 角色扮演体验下降。
 *
 * 两件事（都是纯函数，不写库、不改用户原始数据）：
 *  1) 自动二级键：从条目内容抽取可触发词（引号专名 / 定义值 / 定义头 / 英文专名 / 高频中文词），
 *     补进 secondary_keys。未勾选「选择性」时二级键是**补充触发词（OR）**，勾选后才是 ST 的 AND 语义；
 *     因此只给非选择性条目自动补键，避免 AND 语义下凭空补键反而收窄触发。
 *  2) 自动常驻：识别「无触发词 / 触发词是全局标签 / 条目名或内容自称全局设定」的条目，标记 constant。
 *     参考 RP-Hub 的「自动生图」条目：keys=[] + constant:true 才能保证全局指令必然注入
 *     （RP-Hub assets/js/app.js:6714-6726、data-services.js:592-596）。
 *
 * 触发词切分与 RP-Hub / SillyTavern 对齐：只按逗号家族 + 换行切，
 * 英文多词键（如 "Iron Kingdom"）保持整体；含中文的片段才额外按空白切
 * （RP-Hub assets/js/core-utils.js:590 只按 /[,，]/ 切）。
 */

// 逗号家族 + 换行作为主分隔符（不含空白，避免拆散英文多词键）
const KEY_SEP = /[,，、;；\n\r]+/;
const CJK_RE = /[㐀-䶿一-鿿]/;
// 中文功能字：出现在词首/词尾的 n-gram 基本是语法碎片，不是专名
const CJK_FUNC_CHARS = '的了是在和与或及等之其此该每各某个们么呢吧啊呀哦嘛啦';
// 通用停用词（中英）：这些词当触发词只会造成误触发
const STOP_WORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '以及', '因为', '所以', '但是', '如果',
  '可以', '需要', '应该', '必须', '进行', '通过', '使用', '作为', '对于', '关于', '没有', '不是',
  '就是', '还是', '而且', '并且', '或者', '自己', '对方', '角色', '人物', '世界', '设定', '背景',
  '故事', '剧情', '场景', '时间', '地点', '情况', '问题', '方式', '方法', '存在', '拥有', '属于',
  '位于', '出生', '成长', '性格', '外貌', '特征', '身份', '职业', '种族', '名称', '名字', '称号',
  '武器', '装备', '技能', '魔法', '组织', '势力', '家族', '国家', '城市', '简介', '描述', '概述',
  '总览', '规则', '注意', '说明', '示例', '内容', '备注', '补充', '其他', '关系', '喜欢', '讨厌',
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'has', 'have', 'been', 'were', 'they', 'this', 'that', 'with', 'from', 'will', 'would', 'there',
  'their', 'what', 'when', 'where', 'which', 'while', 'about', 'into', 'than', 'then', 'them', 'these'
]);
// 定义行左侧的字段标签：可以取它的「值」当触发词，但标签本身不能当触发词
const FIELD_LABELS = new Set([
  '性格', '简介', '描述', '设定', '背景', '注意', '说明', '示例', '内容', '名称', '名字', '姓名',
  '称号', '别名', '种族', '身份', '职业', '所在地', '出生地', '地点', '位置', '武器', '装备', '道具',
  '组织', '势力', '家族', '国家', '城市', '地名', '物品', '技能', '能力', '魔法', '招式', '外貌',
  '特征', '年龄', '性别', '身高', '体重', '爱好', '关系', '其他', '备注', '补充', '概述', '总览',
  '规则', '世界观', '人物', '角色', '简介', '说明'
]);
// 「取值为触发词」的定义行：名称：艾莉丝 / 武器：长剑「白樱」 → 艾莉丝 / 长剑
const VALUE_LINE_RE = /^\s*(?:名称|名字|姓名|称号|别名|种族|身份|职业|所在地|出生地|地点|位置|武器|装备|道具|组织|势力|家族|国家|城市|地名|物品|技能|能力|魔法|招式)[：:]\s*([^\n，,。；;、]{2,20})/gm;
// 定义行左侧专名：罗亚城：位于大陆北部 → 罗亚城
const HEAD_LINE_RE = /^([㐀-䶿一-鿿A-Za-z][㐀-䶿一-鿿A-Za-z0-9·・'’-]{1,19})[：:]/gm;
// 引号专名：「剑圣」《白樱》“Iron Kingdom”
const QUOTE_RE = /[「『《“"']([^」』》”"'\n]{2,20})[」』》”"']/g;
// 英文专名/词组：Iron Kingdom / Alice / NPC（句首常见虚词另行过滤）
const LATIN_PROPER_RE = /\b[A-Z][A-Za-z0-9'’-]*(?:[ \t]+[A-Z][A-Za-z0-9'’-]*)*\b/g;
const LATIN_SENTENCE_STOP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'While', 'If', 'But', 'And', 'In', 'On', 'At',
  'It', 'He', 'She', 'They', 'We', 'You', 'I', 'A', 'An', 'As', 'After', 'Before', 'During',
  'However', 'Therefore', 'Meanwhile', 'Suddenly', 'Then', 'Now', 'Here', 'There', 'What', 'Why',
  'How', 'Who', 'Where', 'His', 'Her', 'Its', 'Their', 'Our', 'My', 'Your', 'With', 'From', 'For'
]);
// 全局标签词：触发词全是这类词 = 永远不会在对话里命中 = 应当常驻
const META_KEYS = new Set([
  '世界', '世界观', '设定', '背景', '规则', '简介', '概述', '总览', '设定集', '全局', '常驻', '通用',
  'world', 'setting', 'settings', 'background', 'lore', 'overview', 'global', 'always', 'rule', 'rules',
  'worldbuilding', 'world info', 'worldinfo'
]);
const GLOBAL_NAME_RE = /常驻|全局|世界(?:观|设定|背景|规则)|总设定|基础设定|基本设定|通用设定|通用规则|基本规则|设定集|世界书|always|global|world\s*(?:info|setting|rule)|core\s*setting/i;
const GLOBAL_CONTENT_RE = /世界观|世界设定|世界背景|背景设定|通用规则|全局设定|基本规则|本世界|这个世界(?:的)?(?:基本|通用|核心)|无论(?:发生)?什么|任何情况(?:下)?|始终(?:保持|遵循|有效)|所有(?:角色|人|成员)都/;

// 关键词抽取时最多扫描的内容长度（控制 CPU：n-gram 统计是 O(n·k)）
const EXTRACT_SCAN_LIMIT = 1500;
const DEFAULT_MAX_SECONDARY = 8;
const MAX_KEY_LEN = 20;
const MAX_SECONDARY_LEN = 300;

/**
 * 触发词字符串 → 小写关键词数组
 * 只按逗号家族 + 换行切；含中文的片段额外按空白切（中文键之间常用空格列举），
 * 纯英文片段保留空格（"Iron Kingdom" 是一个整体键）。
 */
function splitKeys(keyStr) {
  const out = [];
  String(keyStr || '').split(KEY_SEP).forEach((seg) => {
    const s = seg.trim();
    if (!s) return;
    if (CJK_RE.test(s)) {
      s.split(/\s+/).forEach((p) => {
        const t = p.trim().toLowerCase();
        if (t) out.push(t);
      });
    } else {
      out.push(s.toLowerCase());
    }
  });
  return Array.from(new Set(out));
}

function isStopWord(w) {
  return STOP_WORDS.has(w) || STOP_WORDS.has(w.toLowerCase());
}

// 中文功能字开头/结尾的碎片不是专名
function hasFuncEdge(w) {
  if (!CJK_RE.test(w)) return false;
  return CJK_FUNC_CHARS.indexOf(w[0]) !== -1 || CJK_FUNC_CHARS.indexOf(w[w.length - 1]) !== -1;
}

function pushCandidate(list, seen, raw, weight) {
  const w = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!w || w.length < 2 || w.length > MAX_KEY_LEN) return;
  // 纯标点/数字/符号不是触发词（注意：JS 的 \W 会把中文当非单词字符，不能用来判断）
  if (!/[A-Za-z㐀-䶿一-鿿]/.test(w)) return;
  const lower = w.toLowerCase();
  if (seen.has(lower) || isStopWord(w) || hasFuncEdge(w)) return;
  seen.add(lower);
  list.push({ word: w, weight });
}

/**
 * 从条目内容抽取候选触发词（按可信度排序：引号专名 > 定义值 > 定义头 > 英文专名 > 高频中文词）
 * @param {string} content 条目内容
 * @param {Object} opts { exclude: string[]（已有主键，小写）, max: number }
 * @returns {string[]} 关键词数组（保留原文大小写，便于展示）
 */
function extractKeywords(content, opts = {}) {
  const text = String(content || '').slice(0, EXTRACT_SCAN_LIMIT);
  if (!text.trim()) return [];
  const exclude = new Set((opts.exclude || []).map((k) => String(k).toLowerCase()));
  const max = Math.max(1, Math.min(parseInt(opts.max, 10) || DEFAULT_MAX_SECONDARY, 20));
  const list = [];
  const seen = new Set();
  const add = (raw, weight) => {
    const before = list.length;
    pushCandidate(list, seen, raw, weight);
    if (list.length > before && exclude.has(list[list.length - 1].word.toLowerCase())) {
      seen.delete(list[list.length - 1].word.toLowerCase());
      list.pop();
    }
  };

  // 1) 引号专名
  let m;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(text))) add(m[1], 5);
  // 2) 定义行的值（名称：X / 武器：长剑「白樱」→ 艾莉丝 / 长剑）
  VALUE_LINE_RE.lastIndex = 0;
  while ((m = VALUE_LINE_RE.exec(text))) add(m[1].split(/[（(「『《“]/)[0], 4);
  // 3) 定义行左侧专名（罗亚城：……），排除字段标签
  HEAD_LINE_RE.lastIndex = 0;
  while ((m = HEAD_LINE_RE.exec(text))) {
    if (!FIELD_LABELS.has(m[1])) add(m[1], 3);
  }
  // 4) 英文专名/词组
  LATIN_PROPER_RE.lastIndex = 0;
  while ((m = LATIN_PROPER_RE.exec(text))) {
    if (!LATIN_SENTENCE_STOP.has(m[0])) add(m[0], 2);
  }
  // 5) 高频中文 n-gram（出现 ≥2 次的 2~6 字片段，专名/术语的典型信号）
  const runs = text.match(/[㐀-䶿一-鿿]{2,}/g) || [];
  const freq = new Map();
  runs.forEach((run) => {
    const maxN = Math.min(6, run.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        freq.set(g, (freq.get(g) || 0) + 1);
      }
    }
  });
  const grams = Array.from(freq.entries())
    .filter(([g, c]) => c >= 2 && !isStopWord(g) && !hasFuncEdge(g))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  grams.forEach(([g]) => add(g, 1));

  // 去掉被更长候选词包含的碎片（艾莉/莉丝 ⊂ 艾莉丝；Iron ⊂ Iron Kingdom），
  // 否则 n-gram 统计会把专名拆成一堆半截词，既占名额又容易误触发。
  const kept = list.filter((x) => {
    const lw = x.word.toLowerCase();
    return !list.some((y) => y !== x && y.weight >= x.weight && y.word.length > x.word.length &&
      y.word.toLowerCase().indexOf(lw) !== -1);
  });

  return kept
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((x) => x.word);
}

/**
 * 自动二级键：仅在条目没有二级键时补充（尊重用户已填写的内容）
 * @returns {string} 逗号连接的二级键（可能为空串）
 */
function deriveSecondaryKeys(entry, opts = {}) {
  if (!entry || String(entry.secondary_keys || '').trim()) return '';
  const keys = splitKeys(entry.key);
  const words = extractKeywords(entry.content, { exclude: keys, max: opts.max });
  let out = '';
  words.forEach((w) => {
    const next = out ? out + ',' + w : w;
    if (next.length <= MAX_SECONDARY_LEN) out = next;
  });
  return out;
}

/**
 * 自动常驻识别
 * @returns {{constant:boolean, reason:string}}
 */
function detectConstant(entry) {
  if (!entry) return { constant: false, reason: '' };
  if (entry.constant) return { constant: true, reason: '用户已设为常驻' };
  const keys = splitKeys(entry.key);
  if (!keys.length) return { constant: true, reason: '无触发词' };
  if (keys.every((k) => META_KEYS.has(k))) return { constant: true, reason: '触发词为全局标签（' + keys.join('/') + '）' };
  const name = String(entry.name || entry.comment || '');
  if (name && GLOBAL_NAME_RE.test(name)) return { constant: true, reason: '条目名标注为全局设定（' + name.slice(0, 30) + '）' };
  const content = String(entry.content || '');
  const head = content.slice(0, 120);
  // 内容自称全局设定：短条目直接常驻；长条目要求触发词也很宽（≤1 个）才常驻，避免把局部设定误判为全局
  if (GLOBAL_CONTENT_RE.test(head) && (content.length <= 400 || keys.length <= 1)) {
    return { constant: true, reason: '内容自称全局/通用设定' };
  }
  return { constant: false, reason: '' };
}

/**
 * 批量增强（扫描期叠加，不落库）
 * @param {Array} entries ai_world_book 行（或归一化条目）
 * @param {Object} opts { autoSecondary, autoConstant, max }
 * @returns {{entries:Array, autoConstantCount:number, autoSecondaryCount:number}}
 *   每个条目附加 _auto = { keys: string[], constant: boolean, reason: string }
 */
function enhanceEntries(entries, opts = {}) {
  const autoSecondary = opts.autoSecondary !== false;
  const autoConstant = opts.autoConstant !== false;
  let autoConstantCount = 0;
  let autoSecondaryCount = 0;
  const out = (entries || []).map((e) => {
    const copy = Object.assign({}, e);
    const auto = { keys: [], constant: false, reason: '' };
    if (autoConstant) {
      const d = detectConstant(e);
      if (d.constant && !e.constant) {
        copy.constant = 1;
        auto.constant = true;
        auto.reason = d.reason;
        autoConstantCount++;
      }
    }
    // 只给「非选择性」条目补二级键：选择性条目是 AND 语义，凭空补二级键反而会收窄触发、造成漏注入
    if (autoSecondary && !copy.constant && !e.selective) {
      const derived = deriveSecondaryKeys(e, { max: opts.max });
      if (derived) {
        copy.secondary_keys = derived;
        auto.keys = splitKeys(derived);
        autoSecondaryCount++;
      }
    }
    copy._auto = auto;
    return copy;
  });
  return { entries: out, autoConstantCount, autoSecondaryCount };
}

/**
 * 供 API 展示的单条诊断（不改动原条目）
 */
function autoInfo(entry, opts = {}) {
  const one = enhanceEntries([entry], opts).entries[0];
  return {
    auto_constant: Boolean(one._auto && one._auto.constant),
    auto_reason: (one._auto && one._auto.reason) || '',
    auto_secondary_keys: (one._auto && one._auto.keys) || []
  };
}

module.exports = {
  splitKeys,
  extractKeywords,
  deriveSecondaryKeys,
  detectConstant,
  enhanceEntries,
  autoInfo,
  META_KEYS,
  DEFAULT_MAX_SECONDARY
};
