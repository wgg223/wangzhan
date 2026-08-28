/**
 * AI提示词库前台交互
 * 依赖 /js/utils.js（escapeHtml / showToast / copyToClipboard）
 * 数据来自 #ai-prompts-data JSON（服务端渲染并已净化 HTML）
 */
(function() {
  var dataEl = document.getElementById('ai-prompts-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var tree = data.tree || [];
  var stats = data.stats || { sections: 0, categories: 0, prompts: 0 };
  var currentUser = data.user || null;

  // ============ 数据索引 ============
  var promptById = {};
  var categoryById = {};
  var allPrompts = [];
  tree.forEach(function(s) {
    s.categories.forEach(function(c) {
      c.sectionName = s.name;
      c.sectionIcon = s.icon || '';
      c.prompts.forEach(function(p) {
        p.sectionName = s.name;
        p.categoryName = c.name;
        p.categoryId = c.id;
        promptById[p.id] = p;
        allPrompts.push(p);
      });
      categoryById[c.id] = c;
    });
  });

  // ============ DOM 引用 ============
  var els = {
    nav: document.getElementById('apNav'),
    stats: document.getElementById('apStats'),
    mindmap: document.getElementById('apMindmap'),
    cards: document.getElementById('apCards'),
    categoryPrompts: document.getElementById('apCategoryPrompts'),
    searchResults: document.getElementById('apSearchResults'),
    search: document.getElementById('apSearch'),
    hero: document.getElementById('apHero'),
    breadcrumbSub: document.getElementById('apBreadcrumbSub'),
    copyAll: document.getElementById('apCopyAll'),
    menuBtn: document.getElementById('apMenuBtn'),
    modal: document.getElementById('apModal'),
    modalTitle: document.getElementById('apModalTitle'),
    modalBody: document.getElementById('apModalBody'),
    modalCopy: document.getElementById('apModalCopy'),
    comments: document.getElementById('apComments'),
    commentCount: document.getElementById('apCommentCount'),
    commentList: document.getElementById('apCommentList'),
    commentForm: document.getElementById('apCommentForm'),
    commentInput: document.getElementById('apCommentInput'),
    commentChar: document.getElementById('apCommentChar'),
    commentSubmit: document.getElementById('apCommentSubmit'),
    commentLogin: document.getElementById('apCommentLogin')
  };
  var currentCategory = null;
  var currentPrompt = null;

  // ============ 工具函数 ============
  function sectionCount(s) {
    return s.categories.reduce(function(n, c) { return n + c.prompts.length; }, 0);
  }

  function stripMarkdown(text) {
    return (text || '').replace(/[#*`>_~\-()!|[\]]/g, '').replace(/\s+/g, ' ').trim();
  }

  function displayText(p) {
    if (p.excerpt) return p.excerpt;
    return stripMarkdown(p.content).slice(0, 140);
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(text, q) {
    var escaped = escapeHtml(text);
    if (!q) return escaped;
    var re = new RegExp('(' + escapeRegExp(escapeHtml(q)) + ')', 'gi');
    return escaped.replace(re, '<mark class="ap-highlight">$1</mark>');
  }

  // ============ 视图切换 ============
  function showOverview() {
    currentCategory = null;
    els.hero.style.display = '';
    els.mindmap.style.display = '';
    els.cards.style.display = '';
    els.categoryPrompts.hidden = true;
    els.searchResults.hidden = true;
    els.copyAll.style.display = 'none';
    els.breadcrumbSub.textContent = '总览';
    els.search.value = '';
    clearNavActive();
    closeDrawer();
  }

  function showCategory(category) {
    currentCategory = category;
    els.hero.style.display = 'none';
    els.mindmap.style.display = 'none';
    els.cards.style.display = 'none';
    els.searchResults.hidden = true;
    els.copyAll.style.display = '';
    els.breadcrumbSub.textContent = category.sectionName + ' / ' + category.name;
    renderCategoryPrompts(category);
    els.categoryPrompts.hidden = false;
    setNavActive(category.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    closeDrawer();
  }

  function scrollToSection(sectionId) {
    showOverview();
    var el = document.getElementById('section-' + sectionId);
    if (el) {
      setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
    }
  }

  // ============ 复制 ============
  function copyPrompt(p, btn) {
    copyToClipboard(p.content, '已复制到剪贴板');
    if (btn) {
      btn.classList.add('copied');
      setTimeout(function() { btn.classList.remove('copied'); }, 1500);
    }
  }

  // ============ 弹窗 ============
  function openModal(prompt) {
    currentPrompt = prompt;
    els.modalTitle.textContent = prompt.title;
    els.modalBody.innerHTML = prompt.content_html || '';
    els.modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    loadComments(prompt.id);
  }

  function closeModal() {
    els.modal.classList.remove('show');
    document.body.style.overflow = '';
    currentPrompt = null;
  }

  // ============ 评论 ============
  function isAdminUser() {
    return currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  }

  function formatCommentTime(str) {
    if (!str) return '';
    var t = String(str).replace('T', ' ').slice(0, 16);
    return t;
  }

  function loadComments(promptId) {
    fetch('/ai-prompts/api/comments/' + promptId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) return;
        renderComments(data.comments || []);
      })
      .catch(function() { /* 静默失败 */ });
  }

  function renderComments(comments) {
    els.comments.hidden = false;
    els.commentCount.textContent = comments.length;
    els.commentInput.value = '';

    if (comments.length === 0) {
      els.commentList.innerHTML = '<p class="ap-comment-empty">暂无评论，快来抢沙发～</p>';
    } else {
      var html = '';
      comments.forEach(function(c) {
        var own = currentUser && (c.user_id === currentUser.id || isAdminUser());
        html += '<div class="ap-comment-item">' +
          '<div class="ap-comment-meta">' +
          '<span class="ap-comment-avatar">' + escapeHtml((c.username || '匿')[0]) + '</span>' +
          '<span class="ap-comment-author">' + escapeHtml(c.username || '匿名用户') + '</span>' +
          '<span class="ap-comment-time">' + formatCommentTime(c.created_at) + '</span>' +
          (own ? '<button class="ap-comment-delete" data-cid="' + c.id + '">删除</button>' : '') +
          '</div>' +
          '<p class="ap-comment-content">' + escapeHtml(c.content) + '</p></div>';
      });
      els.commentList.innerHTML = html;
      els.commentList.querySelectorAll('.ap-comment-delete').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteComment(btn.dataset.cid); });
      });
    }

    if (currentUser) {
      els.commentForm.hidden = false;
      els.commentLogin.hidden = true;
    } else {
      els.commentForm.hidden = true;
      els.commentLogin.hidden = false;
    }
  }

  function submitComment() {
    if (!currentPrompt || !currentUser) return;
    var content = els.commentInput.value.trim();
    if (!content) { showToast('评论内容不能为空', 'error'); return; }

    els.commentSubmit.disabled = true;
    fetch('/ai-prompts/api/comments/' + currentPrompt.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ content: content })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.success) {
        showToast(data.message || '评论已提交', 'success');
        els.commentInput.value = '';
        els.commentChar.textContent = '0/500';
        loadComments(currentPrompt.id);
      } else {
        showToast(data.error || '评论失败', 'error');
      }
      els.commentSubmit.disabled = false;
    }).catch(function() {
      showToast('网络错误，请重试', 'error');
      els.commentSubmit.disabled = false;
    });
  }

  function deleteComment(commentId) {
    if (!confirm('确定要删除这条评论吗？')) return;
    fetch('/ai-prompts/api/comments/' + commentId + '/delete', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.success) {
        showToast('评论已删除', 'success');
        if (currentPrompt) loadComments(currentPrompt.id);
      } else {
        showToast(data.error || '删除失败', 'error');
      }
    }).catch(function() {
      showToast('网络错误，请重试', 'error');
    });
  }

  // ============ 渲染：侧边栏导航 ============
  function renderNav() {
    var html = '';
    tree.forEach(function(s) {
      html += '<button class="ap-nav-section" data-section="' + s.id + '">' +
        '<span class="ap-nav-icon">' + (s.icon || '📂') + '</span>' +
        '<span class="ap-nav-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="ap-nav-count">' + sectionCount(s) + '</span></button>';
      s.categories.forEach(function(c) {
        html += '<button class="ap-nav-cat" data-cat="' + c.id + '">' +
          '<span class="ap-nav-dot"></span>' + escapeHtml(c.name) + '</button>';
      });
    });
    els.nav.innerHTML = html;

    els.nav.querySelectorAll('.ap-nav-section').forEach(function(btn) {
      btn.addEventListener('click', function() { scrollToSection(btn.dataset.section); });
    });
    els.nav.querySelectorAll('.ap-nav-cat').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var c = categoryById[parseInt(btn.dataset.cat, 10)];
        if (c) showCategory(c);
      });
    });
  }

  function clearNavActive() {
    els.nav.querySelectorAll('.ap-nav-section, .ap-nav-cat').forEach(function(el) {
      el.classList.remove('active');
    });
  }

  function setNavActive(categoryId) {
    clearNavActive();
    var catBtn = els.nav.querySelector('.ap-nav-cat[data-cat="' + categoryId + '"]');
    if (catBtn) catBtn.classList.add('active');
    var s = categoryById[categoryId];
    if (s && s.sectionName) {
      tree.forEach(function(section) {
        if (section.name === s.sectionName) {
          var secBtn = els.nav.querySelector('.ap-nav-section[data-section="' + section.id + '"]');
          if (secBtn) secBtn.classList.add('active');
        }
      });
    }
  }

  // ============ 渲染：统计 ============
  function renderStats() {
    els.stats.innerHTML =
      '<div class="ap-stat"><strong>' + stats.sections + '</strong><span>板块</span></div>' +
      '<div class="ap-stat"><strong>' + stats.categories + '</strong><span>分类</span></div>' +
      '<div class="ap-stat"><strong>' + stats.prompts + '</strong><span>提示词</span></div>';
  }

  // ============ 渲染：思维导图 ============
  function renderMindmap() {
    var html = '<div class="ap-mm-root"><span>PROMPT COLLECTION</span>' +
      '<strong>AI提示词</strong><small>' + stats.sections + ' 板块 · ' + stats.prompts + ' 条提示词</small></div>' +
      '<div class="ap-mm-line"></div><div class="ap-mm-branches">';
    tree.forEach(function(s) {
      html += '<div class="ap-mm-branch">' +
        '<button class="ap-mm-section" data-section="' + s.id + '">' +
        '<span class="ap-nav-icon">' + (s.icon || '📂') + '</span>' +
        '<b>' + escapeHtml(s.name) + '</b><span>' + sectionCount(s) + '</span></button>' +
        '<div class="ap-mm-cats">';
      s.categories.forEach(function(c) {
        html += '<button class="ap-mm-chip" data-cat="' + c.id + '">' +
          escapeHtml(c.name) + ' · ' + c.prompts.length + '</button>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    els.mindmap.insertAdjacentHTML('beforeend', html);

    els.mindmap.querySelectorAll('.ap-mm-section').forEach(function(btn) {
      btn.addEventListener('click', function() { scrollToSection(btn.dataset.section); });
    });
    els.mindmap.querySelectorAll('.ap-mm-chip').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var c = categoryById[parseInt(btn.dataset.cat, 10)];
        if (c) showCategory(c);
      });
    });
  }

  // ============ 渲染：分类卡片总览 ============
  function renderCards() {
    if (tree.length === 0) {
      els.cards.innerHTML = '<div class="ap-empty"><strong>暂无提示词</strong>内容正在整理中，敬请期待</div>';
      return;
    }
    var html = '';
    tree.forEach(function(s) {
      html += '<div class="ap-section-group" id="section-' + s.id + '">' +
        '<div class="ap-section-head">' +
        '<span class="ap-nav-icon">' + (s.icon || '📂') + '</span>' +
        '<div class="ap-section-title">' +
        '<h3>' + escapeHtml(s.name) + '</h3>' +
        (s.description ? '<p class="ap-section-desc">' + escapeHtml(s.description) + '</p>' : '') +
        '</div>' +
        '<p class="ap-section-count">' + sectionCount(s) + ' 条提示词</p></div>' +
        '<div class="ap-category-grid">';
      s.categories.forEach(function(c) {
        html += '<article class="ap-category-card" data-cat="' + c.id + '">' +
          '<h4>' + escapeHtml(c.name) + '</h4>' +
          (c.description ? '<p>' + escapeHtml(c.description) + '</p>' : '') +
          '<div class="ap-cat-meta">' + c.prompts.length + ' 条提示词</div>' +
          '<span class="ap-cat-arrow">→</span></article>';
      });
      html += '</div></div>';
    });
    els.cards.innerHTML = html;

    els.cards.querySelectorAll('.ap-category-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var c = categoryById[parseInt(card.dataset.cat, 10)];
        if (c) showCategory(c);
      });
    });
  }

  // ============ 渲染：分类提示词列表 ============
  function renderCategoryPrompts(category) {
    var head = '<div class="ap-view-head">' +
      '<p class="ap-eyebrow">' + escapeHtml(category.sectionName) + '</p>' +
      '<h2>' + escapeHtml(category.name) + '</h2>' +
      (category.description ? '<p>' + escapeHtml(category.description) + '</p>' : '') +
      '</div>';
    var list = '<div class="ap-prompt-list">';
    if (category.prompts.length === 0) {
      list += '<div class="ap-empty"><strong>该分类暂无提示词</strong></div>';
    } else {
      category.prompts.forEach(function(p) {
        list += buildPromptCardHtml(p, '');
      });
    }
    list += '</div>';
    els.categoryPrompts.innerHTML = head + list;
    bindPromptCards(els.categoryPrompts);
  }

  // ============ 渲染：提示词卡片（HTML 字符串） ============
  function buildPromptCardHtml(p, q) {
    var text = displayText(p);
    var clamp = text.length > 90;
    var titleHtml = q ? highlight(p.title, q) : escapeHtml(p.title);
    return '<article class="ap-prompt-card" data-pid="' + p.id + '">' +
      '<div class="ap-card-top">' +
      '<h3 class="ap-card-title">' + titleHtml + '</h3>' +
      '<button class="ap-copy-btn" title="复制">📋</button></div>' +
      '<p class="ap-prompt-context">' + escapeHtml(p.sectionName + ' / ' + p.categoryName) + '</p>' +
      '<p class="ap-prompt-text' + (clamp ? ' clamp' : '') + '">' + escapeHtml(text) + '</p>' +
      (clamp ? '<button class="ap-expand-btn">展开全文</button>' : '') +
      '</article>';
  }

  function bindPromptCards(container) {
    container.querySelectorAll('.ap-prompt-card').forEach(function(card) {
      var p = promptById[parseInt(card.dataset.pid, 10)];
      if (!p) return;
      card.querySelector('.ap-card-title').addEventListener('click', function() { openModal(p); });
      card.querySelector('.ap-copy-btn').addEventListener('click', function(ev) {
        ev.stopPropagation();
        copyPrompt(p, this);
      });
      var expandBtn = card.querySelector('.ap-expand-btn');
      if (expandBtn) {
        expandBtn.addEventListener('click', function() {
          var txt = card.querySelector('.ap-prompt-text');
          var expanded = txt.classList.toggle('clamp');
          expandBtn.textContent = expanded ? '展开全文' : '收起';
        });
      }
    });
  }

  // ============ 搜索 ============
  function doSearch(q) {
    currentCategory = null;
    els.hero.style.display = 'none';
    els.mindmap.style.display = 'none';
    els.cards.style.display = 'none';
    els.categoryPrompts.hidden = true;
    els.copyAll.style.display = 'none';
    els.breadcrumbSub.textContent = '搜索：' + q;
    clearNavActive();

    var ql = q.toLowerCase();
    var hits = allPrompts.filter(function(p) {
      return p.title.toLowerCase().indexOf(ql) !== -1 ||
        (p.content && p.content.toLowerCase().indexOf(ql) !== -1) ||
        (p.excerpt && p.excerpt.toLowerCase().indexOf(ql) !== -1);
    });

    var html = '<p class="ap-search-summary">找到 ' + hits.length + ' 条与「' + escapeHtml(q) + '」相关的提示词</p>';
    if (hits.length === 0) {
      html += '<div class="ap-empty"><strong>未找到相关提示词</strong>换个关键词试试吧</div>';
    } else {
      html += '<div class="ap-search-results">';
      hits.forEach(function(p) {
        html += buildPromptCardHtml(p, q);
      });
      html += '</div>';
    }
    els.searchResults.innerHTML = html;
    els.searchResults.hidden = false;
    bindPromptCards(els.searchResults);
    closeDrawer();
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    els.search.addEventListener('input', function() {
      var q = this.value.trim();
      if (!q) {
        showOverview();
        return;
      }
      doSearch(q);
    });

    els.copyAll.addEventListener('click', function() {
      if (!currentCategory) return;
      var text = currentCategory.prompts.map(function(p) {
        return '【' + p.title + '】\n' + p.content;
      }).join('\n\n');
      copyToClipboard(text, '已复制当前分类全部提示词');
    });

    els.menuBtn.addEventListener('click', function() {
      document.body.classList.toggle('ap-menu-open');
    });

    els.modal.querySelectorAll('[data-close-modal]').forEach(function(el) {
      el.addEventListener('click', closeModal);
    });
    els.modalCopy.addEventListener('click', function() {
      if (currentPrompt) copyToClipboard(currentPrompt.content, '已复制到剪贴板');
    });
    els.commentSubmit.addEventListener('click', submitComment);
    els.commentInput.addEventListener('input', function() {
      var len = this.value.length;
      if (len > 500) this.value = this.value.slice(0, 500);
      els.commentChar.textContent = this.value.length + '/500';
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  function closeDrawer() {
    document.body.classList.remove('ap-menu-open');
  }

  // ============ 初始化 ============
  renderNav();
  renderStats();
  renderMindmap();
  renderCards();
  bindEvents();
})();
