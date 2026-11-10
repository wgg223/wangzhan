/**
 * 角色卡广场前端逻辑（/characters）
 * - 游客：只读浏览广场（官方 + 已分享卡）；导入/分享需登录
 * - 登录用户：可切换「我的 / 已分享 / 已导入」视图，一键导入广场卡（source_type=hub，不可导出）
 * - 分享：仅本人自建/自导入卡可分享；官方卡与 hub 导入卡禁止二次分享（服务层已强制）
 * 依赖：utils.js（csrfFetch / showToast / copyToClipboard）、ai-appearance.js（外观设置）
 * 安全：所有渲染走 esc() 转义，绝不把卡片字段当 HTML 注入。
 */
(function () {
  'use strict';

  function readBootstrap() {
    var el = document.getElementById('characters-data');
    if (!el) return {};
    try { return JSON.parse(el.textContent || '{}'); } catch (e) { return {}; }
  }

  var boot = readBootstrap();
  var isGuest = Boolean(boot.isGuest);
  var canImport = Boolean(boot.canImport);

  var state = {
    scope: 'public',
    q: '',
    category: '',
    tag: '',
    sort: 'hot',
    page: 1,
    pages: 1,
    perPage: 24,
    loading: false
  };

  // ---- DOM 引用 ----
  var grid = document.getElementById('chGrid');
  var empty = document.getElementById('chEmpty');
  var pager = document.getElementById('chPager');
  var pageInfo = document.getElementById('chPageInfo');
  var resultCount = document.getElementById('chResultCount');
  var catChips = document.getElementById('chCatChips');
  var tagRow = document.getElementById('chTagRow');
  var tagChips = document.getElementById('chTagChips');

  // ---- 工具 ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var CAT_LABELS = {
    default: '通用', rp: 'RP', honkai_sr: '星铁', writing: '写作',
    assistant: '助手', game: '游戏', anime: '动漫', original: '原创', other: '其他'
  };
  function catLabel(c) { return CAT_LABELS[c] || c || '通用'; }

  function avatarHtml(card, cls) {
    var a = card.avatar || '';
    var initial = esc((card.name || '?').slice(0, 1));
    if (a) return '<div class="' + cls + '"><img src="' + esc(a) + '" alt="" loading="lazy" onerror="this.parentNode.textContent=\'' + initial + '\'"></div>';
    return '<div class="' + cls + '">' + initial + '</div>';
  }

  function badges(card) {
    var out = [];
    if (card.is_official) out.push('<span class="ch-badge ch-badge-official">官方</span>');
    if (card.source_type === 'hub') out.push('<span class="ch-badge ch-badge-hub">广场导入</span>');
    else if (card.is_shared && !card.is_official) out.push('<span class="ch-badge ch-badge-shared">已分享</span>');
    if (card.has_book) out.push('<span class="ch-badge ch-badge-book">📖 ' + esc(card.book_entries || 0) + '</span>');
    if (card.alternate_count) out.push('<span class="ch-badge ch-badge-alt">💬 ' + esc(card.alternate_count) + '</span>');
    return out.join('');
  }

  // ---- 卡片渲染 ----
  function renderCards(items) {
    if (!items.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = items.map(function (c) {
      var key = c.token || c.id || '';
      return '<article class="ch-card" data-key="' + esc(key) + '" tabindex="0">' +
        avatarHtml(c, 'ch-card-avatar') +
        '<div class="ch-card-main">' +
          '<h3 class="ch-card-name">' + esc(c.name) + '</h3>' +
          '<div class="ch-card-badges">' + badges(c) + '</div>' +
          '<p class="ch-card-desc">' + esc(c.description || c.greeting_preview || '（暂无简介）') + '</p>' +
          '<div class="ch-card-meta">' +
            '<span class="ch-card-cat">' + esc(catLabel(c.category)) + '</span>' +
            (c.creator ? '<span class="ch-card-creator">by ' + esc(c.creator) + '</span>' : '') +
            '<span class="ch-card-stats">⬇ ' + esc(c.import_count || 0) + ' · 👀 ' + esc(c.view_count || 0) + '</span>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');

    grid.querySelectorAll('.ch-card').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.getAttribute('data-key')); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el.getAttribute('data-key')); }
      });
    });
  }

  // ---- 列表加载 ----
  function loadCards() {
    if (state.loading) return;
    state.loading = true;
    resultCount.textContent = '加载中…';
    var params = new URLSearchParams({
      scope: state.scope, sort: state.sort,
      page: String(state.page), per_page: String(state.perPage)
    });
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);
    if (state.tag) params.set('tag', state.tag);

    fetch('/characters/api/cards?' + params.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        state.loading = false;
        if (!json.success) throw new Error(json.error || '加载失败');
        var d = json.data;
        state.pages = d.pages || 1;
        state.page = d.page || 1;
        canImport = Boolean(d.can_import);
        renderCards(d.items || []);
        resultCount.textContent = '共 ' + (d.total || 0) + ' 张角色卡';
        pager.hidden = state.pages <= 1;
        pageInfo.textContent = state.page + ' / ' + state.pages;
        document.getElementById('chPrev').disabled = state.page <= 1;
        document.getElementById('chNext').disabled = state.page >= state.pages;
      })
      .catch(function (err) {
        state.loading = false;
        resultCount.textContent = '加载失败';
        if (typeof showToast === 'function') showToast(err.message, 'error');
      });
  }

  // ---- 分类 / 标签聚合 ----
  function loadMeta() {
    fetch('/characters/api/meta', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) return;
        var d = json.data;
        // 分类
        var cats = [{ category: '', count: d.total }].concat(d.categories || []);
        catChips.innerHTML = cats.map(function (c) {
          var label = c.category ? catLabel(c.category) : '全部';
          return '<button type="button" class="ch-chip' + (state.category === c.category ? ' active' : '') +
            '" data-cat="' + esc(c.category) + '">' + esc(label) + ' <span class="ch-chip-count">' + esc(c.count) + '</span></button>';
        }).join('');
        catChips.querySelectorAll('.ch-chip').forEach(function (b) {
          b.addEventListener('click', function () {
            state.category = b.getAttribute('data-cat');
            state.page = 1;
            catChips.querySelectorAll('.ch-chip').forEach(function (x) { x.classList.toggle('active', x === b); });
            loadCards();
          });
        });
        // 标签
        var tags = d.tags || [];
        if (tags.length) {
          tagRow.hidden = false;
          tagChips.innerHTML = tags.map(function (t) {
            return '<button type="button" class="ch-chip' + (state.tag === t.tag ? ' active' : '') +
              '" data-tag="' + esc(t.tag) + '">#' + esc(t.tag) + ' <span class="ch-chip-count">' + esc(t.count) + '</span></button>';
          }).join('');
          tagChips.querySelectorAll('.ch-chip').forEach(function (b) {
            b.addEventListener('click', function () {
              var t = b.getAttribute('data-tag');
              state.tag = (state.tag === t) ? '' : t;
              state.page = 1;
              tagChips.querySelectorAll('.ch-chip').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-tag') === state.tag); });
              loadCards();
            });
          });
        }
      })
      .catch(function () { /* 静默：筛选器不可用不影响主列表 */ });
  }

  // ---- 详情弹窗 ----
  var detailModal = document.getElementById('chDetailModal');
  var detailTitle = document.getElementById('chDetailTitle');
  var detailBody = document.getElementById('chDetailBody');
  var detailFoot = document.getElementById('chDetailFoot');

  function closeDetail() { detailModal.hidden = true; }
  document.querySelectorAll('[data-ch-close]').forEach(function (b) {
    b.addEventListener('click', closeDetail);
  });
  detailModal.addEventListener('click', function (e) { if (e.target === detailModal) closeDetail(); });

  function fieldBlock(label, text) {
    if (!text) return '';
    return '<div class="ch-detail-field"><h4>' + esc(label) + '</h4><div class="ch-detail-text">' + esc(text) + '</div></div>';
  }

  function openDetail(key) {
    if (!key) return;
    detailTitle.textContent = '加载中…';
    detailBody.innerHTML = '<p class="ch-detail-loading">正在加载角色卡…</p>';
    detailFoot.innerHTML = '';
    detailModal.hidden = false;

    fetch('/characters/api/cards/' + encodeURIComponent(key), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || '加载失败');
        renderDetail(json.data);
      })
      .catch(function (err) {
        detailTitle.textContent = '无法加载';
        detailBody.innerHTML = '<p class="ch-detail-loading">' + esc(err.message) + '</p>';
      });
  }

  function renderDetail(c) {
    detailTitle.textContent = c.name || '角色卡';
    var html = '';
    html += '<div class="ch-detail-head">' + avatarHtml(c, 'ch-detail-avatar') +
      '<div class="ch-detail-head-main">' +
        '<div class="ch-card-badges">' + badges(c) + '</div>' +
        '<div class="ch-detail-sub">' +
          (c.creator ? '<span>作者：' + esc(c.creator) + '</span>' : '') +
          (c.character_version ? '<span>版本：' + esc(c.character_version) + '</span>' : '') +
          (c.license ? '<span>许可：' + esc(c.license) + '</span>' : '') +
          '<span>⬇ ' + esc(c.import_count || 0) + ' 次导入 · 👀 ' + esc(c.view_count || 0) + ' 次浏览</span>' +
        '</div>' +
      '</div></div>';

    if (c.need_login) {
      html += '<div class="ch-detail-lock">🔒 登录后可查看完整设定、世界书与开场白，并导入到你的聊天。</div>';
      html += fieldBlock('简介', c.description);
      if (c.personality_preview) html += fieldBlock('性格（预览）', c.personality_preview);
      if (c.scenario_preview) html += fieldBlock('场景（预览）', c.scenario_preview);
      if (c.greeting_preview) html += fieldBlock('开场白（预览）', c.greeting_preview);
      if (c.book_keys && c.book_keys.length) html += fieldBlock('世界书触发词', c.book_keys.join('、'));
    } else {
      html += fieldBlock('简介', c.description);
      html += fieldBlock('开场白', c.greeting);
      html += fieldBlock('性格', c.personality);
      html += fieldBlock('场景', c.scenario);
      html += fieldBlock('设定 / 描述', c.system_prompt || c.description);
      if (c.creator_notes) html += fieldBlock('创作者备注', c.creator_notes);
      if (c.alternate_greetings && c.alternate_greetings.length) {
        html += '<div class="ch-detail-field"><h4>备选开场白（' + c.alternate_greetings.length + '）</h4>' +
          c.alternate_greetings.map(function (g, i) {
            return '<div class="ch-detail-text ch-alt-item"><b>#' + (i + 1) + '</b> ' + esc(g) + '</div>';
          }).join('') + '</div>';
      }
      if (c.world_book && c.world_book.entries && c.world_book.entries.length) {
        html += '<div class="ch-detail-field"><h4>📖 世界书：' + esc(c.world_book.name || '') + '（' + c.world_book.entries.length + ' 条）</h4>' +
          '<div class="ch-detail-text">' + c.world_book.entries.slice(0, 40).map(function (e) {
          return '<div class="ch-book-line"><b>' + esc(e.key || '（常驻）') + '</b> ' + esc((e.comment || e.content || '').slice(0, 80)) + '</div>';
        }).join('') + '</div></div>';
      }
    }
    detailBody.innerHTML = html;

    // 底部操作
    var foot = '';
    if (c.is_owner) {
      foot += '<span class="ac-modal-hint">这是你的角色卡</span><span style="flex:1"></span>';
      if (c.can_share) {
        foot += '<button type="button" class="ch-btn ch-btn-ghost" id="chToggleShare">' + (c.is_shared ? '取消分享' : '分享到广场') + '</button>';
        if (c.is_shared && c.share_url) foot += '<button type="button" class="ch-btn ch-btn-ghost" id="chCopyLink">复制链接</button>';
      } else {
        foot += '<span class="ac-modal-hint">广场导入的卡不支持二次分享</span>';
      }
    } else if (isGuest) {
      foot += '<span class="ac-modal-hint">登录后可导入此角色卡</span><span style="flex:1"></span>';
      foot += '<a class="ch-btn ch-btn-primary" href="/login">登录 / 注册</a>';
    } else if (canImport) {
      foot += '<span class="ac-modal-hint">导入后仅站内可用，不支持导出</span><span style="flex:1"></span>';
      foot += '<button type="button" class="ch-btn ch-btn-primary" id="chImportBtn">⬇ 导入到我的角色卡</button>';
    } else {
      foot += '<span class="ac-modal-hint">你没有 AI 聊天权限，无法导入</span>';
    }
    detailFoot.innerHTML = foot;

    var importBtn = document.getElementById('chImportBtn');
    if (importBtn) importBtn.addEventListener('click', function () { doImport(c); });
    var toggleShare = document.getElementById('chToggleShare');
    if (toggleShare) toggleShare.addEventListener('click', function () { doToggleShare(c); });
    var copyLink = document.getElementById('chCopyLink');
    if (copyLink) copyLink.addEventListener('click', function () {
      var url = location.origin + c.share_url;
      if (typeof copyToClipboard === 'function') copyToClipboard(url, '分享链接已复制');
    });
  }

  function doImport(c) {
    var btn = document.getElementById('chImportBtn');
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    var body = c.token ? { token: c.token } : { id: c.id };
    csrfFetch('/characters/api/cards/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.success) throw new Error(json.error || '导入失败');
      if (typeof showToast === 'function') showToast(json.message || '已导入', 'success');
      closeDetail();
      if (state.scope === 'imported' || state.scope === 'mine') loadCards();
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ 导入到我的角色卡'; }
      if (typeof showToast === 'function') showToast(err.message, 'error');
    });
  }

  function doToggleShare(c) {
    var next = c.is_shared ? 0 : 1;
    csrfFetch('/characters/api/cards/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, shared: next })
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.success) throw new Error(json.error || '操作失败');
      if (typeof showToast === 'function') showToast(next ? '已分享到广场' : '已取消分享', 'success');
      closeDetail();
      loadMeta();
      loadCards();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error');
    });
  }

  // ---- 事件绑定 ----
  document.getElementById('chScopeTabs').addEventListener('click', function (e) {
    var tab = e.target.closest('.ch-scope-tab');
    if (!tab) return;
    state.scope = tab.getAttribute('data-scope');
    state.page = 1;
    this.querySelectorAll('.ch-scope-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
    loadCards();
  });

  document.getElementById('chSortChips').addEventListener('click', function (e) {
    var chip = e.target.closest('.ch-chip');
    if (!chip) return;
    state.sort = chip.getAttribute('data-sort');
    state.page = 1;
    this.querySelectorAll('.ch-chip').forEach(function (x) { x.classList.toggle('active', x === chip); });
    loadCards();
  });

  var searchTimer = null;
  document.getElementById('chSearch').addEventListener('input', function (e) {
    var v = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = v.trim(); state.page = 1; loadCards(); }, 300);
  });

  document.getElementById('chPrev').addEventListener('click', function () {
    if (state.page > 1) { state.page--; loadCards(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  document.getElementById('chNext').addEventListener('click', function () {
    if (state.page < state.pages) { state.page++; loadCards(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  // ---- 深链：/characters?card=<token> 直接打开详情 ----
  function handleDeepLink() {
    var m = new URLSearchParams(location.search);
    var card = m.get('card');
    if (card) openDetail(card);
  }

  // ---- 初始化 ----
  loadMeta();
  loadCards();
  handleDeepLink();
})();
