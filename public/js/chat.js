/**
 * AI 聊天交互脚本
 * 会话管理、消息发送/接收、流式输出、模型管理等
 *
 * 增强版 - 添加防抖渲染、消息编辑、对话搜索、导出等功能
 */

// ==================== 缓存管理 ====================

/**
 * 简单缓存管理器
 * 支持设置过期时间，自动清理过期缓存
 */
const CacheManager = {
  _cache: new Map(),

  /**
   * 设置缓存
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间（毫秒），默认5分钟
   */
  set(key, value, ttl = 5 * 60 * 1000) {
    this._cache.set(key, {
      value,
      expireAt: Date.now() + ttl
    });
  },

  /**
   * 获取缓存
   * @param {string} key - 缓存键
   * @returns {any|null} 缓存值，过期或不存在返回null
   */
  get(key) {
    const item = this._cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expireAt) {
      this._cache.delete(key);
      return null;
    }

    return item.value;
  },

  /**
   * 删除缓存
   * @param {string} key - 缓存键
   */
  delete(key) {
    this._cache.delete(key);
  },

  /**
   * 清空所有缓存
   */
  clear() {
    this._cache.clear();
  },

  /**
   * 清理过期缓存
   */
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this._cache.entries()) {
      if (now > item.expireAt) {
        this._cache.delete(key);
      }
    }
  }
};

// 每分钟清理一次过期缓存
setInterval(() => CacheManager.cleanup(), 60 * 1000);

// ==================== 工具函数 ====================

/**
 * 防抖函数
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟毫秒数
 * @returns {Function} 防抖后的函数
 */
function debounce(fn, delay) {
  let timer = null;
  const debounced = function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, args);
      timer = null;
    }, delay);
  };
  debounced.cancel = function() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  debounced.flush = function() {
    if (timer) {
      clearTimeout(timer);
      fn.apply(this, []);
      timer = null;
    }
  };
  return debounced;
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 基础 HTML 消毒（去除危险标签和属性）
 */
function sanitizeHtml(html) {
  if (typeof html !== 'string') return '';
  const allowedTags = ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table',
    'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div', 'del', 'sup', 'sub'];
  const allowedAttrs = { 'a': ['href', 'title', 'target', 'rel'], 'img': ['src', 'alt', 'title'], '*': ['class'] };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  function clean(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (!allowedTags.includes(tag)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          continue;
        }
        const attrs = Array.from(child.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          const tagAllowed = allowedAttrs[tag] || [];
          const globalAllowed = allowedAttrs['*'] || [];
          if (!tagAllowed.includes(name) && !globalAllowed.includes(name)) {
            child.removeAttribute(attr.name);
          }
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
            child.removeAttribute(attr.name);
          }
        }
        clean(child);
      }
    }
  }
  clean(doc.body);
  return doc.body.innerHTML;
}

/**
 * 获取 CSRF Token
 */
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

// ==================== 会话管理 ====================

const ConversationManager = {
  /**
   * 创建新会话
   */
  async create(title, model, systemPrompt) {
    try {
      const res = await fetch('/api/chat/conversation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({ title: title || '新对话', model: model || '', system_prompt: systemPrompt || '' })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      CacheManager.delete('conversation_list'); // 清除缓存
      return res.json();
    } catch (err) {
      console.error('[ConversationManager.create] 创建会话失败:', err);
      ChatUI.showToast(err.message || '创建会话失败', 'error');
      return { success: false, error: err.message };
    }
  },

  /**
   * 获取会话列表（带缓存）
   */
  async list() {
    const cacheKey = 'conversation_list';
    const cached = CacheManager.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch('/api/chat/conversations');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const result = await res.json();
      if (result.success) {
        CacheManager.set(cacheKey, result, 2 * 60 * 1000); // 缓存2分钟
      }
      return result;
    } catch (err) {
      console.error('[ConversationManager.list] 获取会话列表失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 删除会话
   */
  async delete(id) {
    try {
      const res = await fetch('/api/chat/conversation/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'CSRF-Token': getCsrfToken() }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      CacheManager.delete('conversation_list'); // 清除缓存
      return res.json();
    } catch (err) {
      console.error('[ConversationManager.delete] 删除会话失败:', err);
      ChatUI.showToast(err.message || '删除会话失败', 'error');
      return { success: false, error: err.message };
    }
  },

  /**
   * 重命名会话
   */
  async rename(id, title) {
    try {
      const res = await fetch('/api/chat/conversation/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({ title: title })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[ConversationManager.rename] 重命名会话失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 切换模型
   */
  async switchModel(id, model) {
    try {
      const res = await fetch('/api/chat/conversation/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({ model: model })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[ConversationManager.switchModel] 切换模型失败:', err);
      return { success: false, error: err.message };
    }
  }
};

// ==================== 消息管理 ====================

const MessageManager = {
  /**
   * 发送消息（非流式）
   */
  async send(convId, content, model) {
    try {
      const res = await fetch('/api/chat/conversation/' + encodeURIComponent(convId) + '/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify({ content: content, model: model || '' })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[MessageManager.send] 发送消息失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 发送消息（流式 SSE）
   */
  sendStream(convId, content, model, onToken, onDone, onError) {
    const xhr = new XMLHttpRequest();
    const url = '/api/chat/conversation/' + encodeURIComponent(convId) + '/stream';
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('CSRF-Token', getCsrfToken());
    xhr.setRequestHeader('Accept', 'text/event-stream');

    let lastIndex = 0;
    let parseErrorCount = 0;
    const MAX_PARSE_ERRORS = 10;

    xhr.onprogress = function() {
      const newData = xhr.responseText.substring(lastIndex);
      lastIndex = xhr.responseText.length;

      const lines = newData.split('\n');
      let currentEvent = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.substring(7).trim();
        } else if (line.startsWith('data: ')) {
          const dataStr = line.substring(6);
          try {
            const data = JSON.parse(dataStr);
            if (currentEvent === 'token' && data.token && onToken) {
              onToken(data.token);
            } else if (currentEvent === 'error' && data.error && onError) {
              onError(data.error);
            } else if (!currentEvent && data.token && onToken) {
              // 兼容没有 event 前缀的情况
              onToken(data.token);
            }
            if (data.error && onError) {
              onError(data.error);
            }
            parseErrorCount = 0;
          } catch (e) {
            parseErrorCount++;
            if (parseErrorCount > MAX_PARSE_ERRORS) {
              console.error('[MessageManager.sendStream] 连续解析错误过多，终止流');
              if (onError) onError('数据解析异常');
              xhr.abort();
              return;
            }
          }
        }
      }
    };

    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onDone) onDone();
      } else {
        let errorMsg = '请求失败 (' + xhr.status + ')';
        try {
          const errData = JSON.parse(xhr.responseText);
          errorMsg = errData.error || errorMsg;
        } catch (e) { /* ignore */ }
        if (onError) onError(errorMsg);
      }
    };

    xhr.onerror = function() {
      if (onError) onError('网络请求失败，请检查网络连接');
    };

    xhr.ontimeout = function() {
      if (onError) onError('请求超时，请稍后重试');
    };

    xhr.timeout = 120000; // 2分钟超时

    xhr.send(JSON.stringify({ content: content, model: model || '' }));

    return xhr; // 返回用于取消
  },

  /**
   * 重新生成回复
   */
  async regenerate(msgId) {
    try {
      const res = await fetch('/api/chat/regenerate/' + encodeURIComponent(msgId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[MessageManager.regenerate] 重新生成失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 加载历史消息（支持分页）
   * @param {string} convId - 会话ID
   * @param {Object} options - 选项
   * @param {number} options.page - 页码
   * @param {number} options.limit - 每页数量
   * @param {string} options.before - 获取此消息ID之前的消息
   */
  async loadHistory(convId, options = {}) {
    try {
      let url = '/api/chat/conversation/' + encodeURIComponent(convId) + '/messages';
      const params = new URLSearchParams();
      if (options.page) params.append('page', options.page);
      if (options.limit) params.append('limit', options.limit);
      if (options.before) params.append('before', options.before);
      if (params.toString()) url += '?' + params.toString();

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[MessageManager.loadHistory] 加载历史消息失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 搜索会话内的消息
   * @param {string} convId - 会话ID
   * @param {string} query - 搜索词
   */
  async search(convId, query) {
    try {
      const res = await fetch('/api/chat/conversation/' + encodeURIComponent(convId) + '/search?q=' + encodeURIComponent(query));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[MessageManager.search] 搜索消息失败:', err);
      return { success: false, error: err.message };
    }
  }
};

// ==================== 模型管理 ====================

const ModelManager = {
  /**
   * 获取可用模型列表（带缓存）
   */
  async list() {
    const cacheKey = 'model_list';
    const cached = CacheManager.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch('/api/chat/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.success) {
        CacheManager.set(cacheKey, result, 3 * 60 * 1000); // 缓存3分钟
      }
      return result;
    } catch (err) {
      console.error('[ModelManager.list] 获取模型列表失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 获取单个模型详情
   */
  async get(id) {
    try {
      const res = await fetch('/api/chat/models/' + encodeURIComponent(id));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      console.error('[ModelManager.get] 获取模型详情失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 添加自定义模型
   */
  async create(data) {
    try {
      const res = await fetch('/api/chat/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      CacheManager.delete('model_list'); // 清除缓存
      return res.json();
    } catch (err) {
      console.error('[ModelManager.create] 添加模型失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 编辑自定义模型
   */
  async update(id, data) {
    try {
      const res = await fetch('/api/chat/models/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': getCsrfToken()
        },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        CacheManager.delete('model_list'); // 清除缓存
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[ModelManager.update] 更新模型失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 删除自定义模型
   */
  async delete(id) {
    try {
      const res = await fetch('/api/chat/models/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'CSRF-Token': getCsrfToken() }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[ModelManager.delete] 删除模型失败:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * 测试模型连接
   */
  async test(id) {
    try {
      const res = await fetch('/api/chat/models/' + encodeURIComponent(id) + '/test', {
        method: 'POST',
        headers: { 'CSRF-Token': getCsrfToken() }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      console.error('[ModelManager.test] 测试模型连接失败:', err);
      return { success: false, error: err.message };
    }
  }
};

// ==================== 配额管理 ====================

const QuotaManager = {
  async getInfo() {
    try {
      const res = await fetch('/api/chat/quota');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      console.error('[QuotaManager.getInfo] 获取配额信息失败:', err);
      return { success: false, error: err.message };
    }
  }
};

// ==================== UI 工具 ====================

const ChatUI = {
  /**
   * 滚动到底部
   */
  scrollToBottom() {
    const list = document.getElementById('messageList');
    if (list) {
      // 使用 requestAnimationFrame 代替 setTimeout，更高效
      requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight;
      });
    }
  },

  /**
   * 自适应输入框高度
   */
  adjustTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  },

  /**
   * 显示 Toast 提示
   */
  showToast(msg, type) {
    if (!msg) return;
    const existing = document.querySelector('.ds-toast');
    if (existing) {
      existing.classList.add('ds-toast--hiding');
      setTimeout(() => existing.remove(), 250);
    }

    const toast = document.createElement('div');
    toast.className = 'ds-toast';
    toast.textContent = msg;

    // 使用 class 管理样式，而非内联样式
    toast.classList.add('ds-toast--' + (type === 'error' ? 'error' : 'success'));

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('ds-toast--hiding');
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  },

  /**
   * 切换侧边栏
   */
  toggleSidebar() {
    const sidebar = document.getElementById('dsSessionSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) {
      sidebar.classList.toggle('open');
      if (overlay) overlay.classList.toggle('open');
    }
  }
};

// ==================== Markdown 渲染 ====================

/**
 * 渲染 Markdown 为 HTML
 */
function renderMarkdown(text) {
  if (typeof text !== 'string') return '<p></p>';

  if (typeof marked === 'undefined') {
    // 降级：简单转义
    return '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
  }
  // 配置 marked（仅配置一次）
  if (!renderMarkdown.configured) {
    try {
      marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (e) {
              // fall through to escapeHtml
            }
          }
          return escapeHtml(code);
        }
      });
    } catch (e) {
      console.warn('[renderMarkdown] marked 配置失败:', e);
    }
    renderMarkdown.configured = true;
  }
  try {
    return sanitizeHtml(marked.parse(text));
  } catch (e) {
    console.warn('[renderMarkdown] 解析失败，使用降级渲染:', e);
    return '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
  }
}

/**
 * 为所有代码块添加复制按钮
 */
function addCopyButtonsToCodeBlocks(container) {
  if (!container) container = document;
  const preBlocks = container.querySelectorAll('.ds-message-text pre');
  if (preBlocks.length === 0) return;

  preBlocks.forEach(function(pre) {
    // 避免重复添加
    if (pre.querySelector('.copy-code-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = '📋 复制';
    btn.setAttribute('aria-label', '复制代码');

    btn.onclick = function(e) {
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;

      function showCopied() {
        btn.classList.add('copied');
        btn.textContent = '已复制';
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.textContent = '📋 复制';
        }, 2000);
      }

      // 优先使用 Clipboard API
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(showCopied).catch(function() {
          // 降级方案
          fallbackCopy(text, showCopied);
        });
      } else {
        fallbackCopy(text, showCopied);
      }
    };
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

/**
 * 降级复制方案（兼容旧浏览器）
 */
function fallbackCopy(text, callback) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    if (callback) callback();
  } catch (e) {
    console.warn('[fallbackCopy] 复制失败:', e);
  }
}

/**
 * 渲染消息内容（根据角色决定是否渲染 Markdown）
 */
function renderMessageContent(role, content) {
  if (role === 'assistant') {
    return renderMarkdown(content);
  }
  return '<p>' + escapeHtml(content).replace(/\n/g, '<br>') + '</p>';
}

// ==================== 流式渲染优化（防抖版） ====================

/**
 * 流式渲染控制器 - 使用防抖优化 Markdown 渲染性能
 */
const StreamRenderer = {
  buffer: '',
  debouncedRender: null,
  contentEl: null,
  lastRenderedLength: 0, // 上次渲染的长度，用于增量渲染
  renderCount: 0, // 渲染次数计数器

  /**
   * 初始化渲染器
   */
  init() {
    this.contentEl = document.getElementById('streamingContent');
    this.buffer = '';
    this.lastRenderedLength = 0;
    this.renderCount = 0;
    if (!this.debouncedRender) {
      this.debouncedRender = debounce(() => {
        this._doRender();
      }, 50);
    }
  },

  /**
   * 追加 token
   */
  append(token) {
    if (!this.contentEl) {
      this.contentEl = document.getElementById('streamingContent');
      if (!this.contentEl) return;
    }
    this.buffer += token;
    this.debouncedRender();
    ChatUI.scrollToBottom();
  },

  /**
   * 执行渲染（增量优化版）
   */
  _doRender() {
    if (!this.contentEl) return;

    // 增量渲染策略：
    // 1. 前10次渲染每次都全量渲染（确保初始内容正确显示）
    // 2. 之后每3次渲染一次全量（减少DOM操作）
    // 3. 其他时候只追加文本（最快）
    this.renderCount++;

    if (this.renderCount <= 10 || this.renderCount % 3 === 0) {
      // 全量渲染
      this.contentEl.innerHTML = renderMarkdown(this.buffer);
      this.lastRenderedLength = this.buffer.length;
    } else {
      // 增量渲染：只追加新内容
      const newContent = this.buffer.slice(this.lastRenderedLength);
      if (newContent) {
        // 创建临时元素来渲染新内容
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = renderMarkdown(newContent);
        // 追加到现有内容
        while (tempDiv.firstChild) {
          this.contentEl.appendChild(tempDiv.firstChild);
        }
        this.lastRenderedLength = this.buffer.length;
      }
    }
  },

  /**
   * 强制立即渲染（完成时调用）
   */
  flush() {
    if (this.debouncedRender) {
      this.debouncedRender.flush();
    }
    // 完成时强制全量渲染一次，确保内容完整
    this.contentEl.innerHTML = renderMarkdown(this.buffer);
    this.lastRenderedLength = this.buffer.length;
  },

  /**
   * 重置
   */
  reset() {
    this.buffer = '';
    this.lastRenderedLength = 0;
    this.renderCount = 0;
    if (this.debouncedRender) {
      this.debouncedRender.cancel();
    }
    if (this.contentEl) {
      this.contentEl.innerHTML = '';
    }
  },

  /**
   * 获取当前缓冲区内容
   */
  getContent() {
    return this.buffer;
  }
};

// ==================== 辅助函数 ====================

function autoResize(textarea) {
  ChatUI.adjustTextarea(textarea);
}

// ==================== 聊天页面交互函数 ====================

let currentStreamXHR = null;
let isSending = false;

/**
 * 发送消息
 */
async function sendMessage() {
  if (isSending) return;
  isSending = true;

  const input = document.getElementById('messageInput');
  if (!input) { isSending = false; return; }
  const content = input.value.trim();
  if (!content) { isSending = false; return; }

  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn && sendBtn.disabled) { isSending = false; return; }

  try {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const convId = pathParts[pathParts.length - 1];
    if (!convId || convId === 'new') {
      const modelSelect = document.getElementById('modelSelect');
      const model = modelSelect ? modelSelect.value : '';
      const result = await ConversationManager.create('新对话', model);
      if (result && result.success && result.data && result.data.id) {
        window.location.href = '/chat/' + result.data.id;
      } else {
        console.error('[sendMessage] 创建新对话失败:', result ? result.error : '请求无响应');
      }
      return;
    }

    input.value = '';
    ChatUI.adjustTextarea(input);

    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ds-spinner"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    }

    const modelSelect = document.getElementById('modelSelect');
    const model = modelSelect ? modelSelect.value : '';

    addMessageToUI('user', content);
    showStreamingPlaceholder();

    currentStreamXHR = MessageManager.sendStream(
      convId, content, model,
      (token) => { StreamRenderer.append(token); },
      () => {
        completeStreaming();
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        }
        currentStreamXHR = null; isSending = false;
      },
      (error) => {
        hideStreamingPlaceholder();
        // 在聊天窗口中显示"模型调用失败"的提示信息
        addErrorMessage('模型调用失败: ' + (error || '请检查API配置和网络连接'));
        ChatUI.showToast(error || '模型调用失败', 'error');
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        }
        currentStreamXHR = null; isSending = false;
      }
    );
  } catch (err) {
    console.error('[sendMessage] 发送消息异常:', err);
    ChatUI.showToast('发送消息时发生异常', 'error');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
    }
    currentStreamXHR = null; isSending = false;
  }
}

/**
 * 处理键盘事件
 */
function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

/**
 * 添加消息到界面
 */
function addMessageToUI(role, content, msgId) {
  const list = document.getElementById('messageList');
  if (!list) return;

  const welcome = list.querySelector('.ds-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = 'ds-message ' + role;
  if (msgId) bubble.dataset.msgId = msgId;

  const renderedContent = renderMessageContent(role, content);

  let actionsHtml = '';
  if (role === 'user') {
    actionsHtml = '<button onclick="copyMessage(this)" title="复制">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>' +
      '<button onclick="editMessage(this)" title="编辑">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>';
  }
  if (role === 'assistant') {
    actionsHtml = '<button onclick="copyMessage(this)" title="复制">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>' +
      '<button onclick="regenerateLastMessage()" title="重新生成">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="23 4 23 10 17 10"></polyline>' +
      '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>';
  }

  bubble.innerHTML = [
    '<div class="ds-message-avatar">',
    role === 'user'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>',
    '</div>',
    '<div class="ds-message-content">',
    '  <div class="ds-message-text' + (role === 'assistant' ? ' markdown-body' : '') + '">' + renderedContent + '</div>',
    '  <div class="ds-message-actions">' + actionsHtml + '</div>',
    '</div>'
  ].join('');

  list.appendChild(bubble);
  ChatUI.scrollToBottom();

  if (typeof hljs !== 'undefined') {
    try {
      bubble.querySelectorAll('pre code').forEach(function(block) { hljs.highlightElement(block); });
    } catch (e) { console.warn('[addMessageToUI] hljs 高亮失败:', e); }
  }
  addCopyButtonsToCodeBlocks(bubble);
}

/**
 * 显示流式输出占位
 */
function showStreamingPlaceholder() {
  const placeholder = document.getElementById('streamingPlaceholder');
  if (placeholder) {
    placeholder.style.display = 'block';
    StreamRenderer.init();
    StreamRenderer.reset();
    ChatUI.scrollToBottom();
  }
}

/**
 * 完成流式输出
 */
function completeStreaming() {
  const placeholder = document.getElementById('streamingPlaceholder');
  if (!placeholder) return;

  StreamRenderer.flush();

  const content = document.getElementById('streamingContent');
  if (!content) return;

  const html = content.innerHTML;
  if (!html) { placeholder.style.display = 'none'; return; }

  const list = document.getElementById('messageList');
  const bubble = placeholder.querySelector('.ds-message');
  if (bubble && list) {
    const clone = bubble.cloneNode(true);
    const cursor = clone.querySelector('.ds-typing-cursor');
    if (cursor) cursor.remove();

    const actions = clone.querySelector('.ds-message-actions') || document.createElement('div');
    if (!actions.parentNode) {
      actions.className = 'ds-message-actions';
      actions.innerHTML =
        '<button onclick="copyMessage(this)" title="复制">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>' +
        '<button onclick="regenerateLastMessage()" title="重新生成">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="23 4 23 10 17 10"></polyline>' +
        '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>';
      clone.querySelector('.ds-message-content').appendChild(actions);
    }
    list.appendChild(clone);
  }

  placeholder.style.display = 'none';
  ChatUI.scrollToBottom();

  if (typeof hljs !== 'undefined') {
    try {
      document.querySelectorAll('#messageList pre code:not(.hljs)').forEach(function(block) { hljs.highlightElement(block); });
    } catch (e) { console.warn('[completeStreaming] hljs 高亮失败:', e); }
  }
  addCopyButtonsToCodeBlocks(document.getElementById('messageList'));
  StreamRenderer.reset();
}

/**
 * 隐藏流式输出占位
 */
function hideStreamingPlaceholder() {
  const placeholder = document.getElementById('streamingPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  StreamRenderer.reset();
}

/**
 * 在聊天窗口中添加错误消息气泡
 * @param {string} errorMsg - 错误消息内容
 */
function addErrorMessage(errorMsg) {
  const list = document.getElementById('messageList');
  if (!list) return;

  const bubble = document.createElement('div');
  bubble.className = 'ds-message assistant ds-message-error';
  bubble.innerHTML = [
    '<div class="ds-message-avatar" style="background:#fff0f0">',
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#cc3333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
    '</svg></div>',
    '<div class="ds-message-content" style="background:#fff0f0;border-color:#ffcccc;color:#cc3333;">',
    '  <div class="ds-message-text">' + escapeHtml(errorMsg) + '</div>',
    '</div>'
  ].join('');

  list.appendChild(bubble);
  ChatUI.scrollToBottom();
}

/**
 * 复制消息内容
 */
function copyMessage(btn) {
  if (!btn) return;
  const bubble = btn.closest('.ds-message');
  const text = bubble ? bubble.querySelector('.ds-message-text') : null;
  if (!text) return;
  const content = text.textContent || text.innerText;

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(content).then(() => { ChatUI.showToast('已复制', 'success'); })
      .catch(() => { fallbackCopy(content, () => ChatUI.showToast('已复制', 'success')); });
  } else {
    fallbackCopy(content, () => ChatUI.showToast('已复制', 'success'));
  }
}

// ==================== 消息编辑功能 ====================

/**
 * 编辑用户消息
 */
function editMessage(btn) {
  if (!btn) return;
  const bubble = btn.closest('.ds-message');
  if (!bubble) return;
  const textEl = bubble.querySelector('.ds-message-text');
  if (!textEl) return;

  const currentContent = textEl.textContent || textEl.innerText;
  const msgId = bubble.dataset.msgId;

  const editContainer = document.createElement('div');
  editContainer.className = 'ds-message-edit-container';

  const textarea = document.createElement('textarea');
  textarea.className = 'ds-message-edit-textarea';
  textarea.value = currentContent;
  textarea.rows = 3;

  const btnGroup = document.createElement('div');
  btnGroup.className = 'ds-message-edit-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = '保存';
  saveBtn.onclick = async function() {
    const newContent = textarea.value.trim();
    if (!newContent) { ChatUI.showToast('内容不能为空', 'error'); return; }
    if (newContent === currentContent) { cancelEdit(); return; }

    if (msgId) {
      try {
        const res = await fetch('/api/chat/message/' + encodeURIComponent(msgId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'CSRF-Token': getCsrfToken() },
          body: JSON.stringify({ content: newContent })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || '更新失败');
        }
        textEl.innerHTML = renderMessageContent('user', newContent);
        ChatUI.showToast('已更新', 'success');
      } catch (err) {
        ChatUI.showToast(err.message || '更新失败', 'error');
      }
    } else {
      textEl.innerHTML = renderMessageContent('user', newContent);
    }
    editContainer.replaceWith(textEl);
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary btn-sm';
  cancelBtn.textContent = '取消';
  cancelBtn.onclick = cancelEdit;

  function cancelEdit() { editContainer.replaceWith(textEl); }

  btnGroup.appendChild(saveBtn);
  btnGroup.appendChild(cancelBtn);
  editContainer.appendChild(textarea);
  editContainer.appendChild(btnGroup);

  textEl.replaceWith(editContainer);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// ==================== 对话导出功能 ====================

/**
 * 导出当前对话为 Markdown 文件
 */
function exportConversation() {
  const list = document.getElementById('messageList');
  if (!list) return;
  const messages = list.querySelectorAll('.ds-message');
  if (messages.length === 0) { ChatUI.showToast('没有可导出的消息', 'error'); return; }

  let markdown = '# 对话记录\n\n导出时间: ' + new Date().toLocaleString('zh-CN') + '\n\n---\n\n';
  messages.forEach(function(msg) {
    const role = msg.classList.contains('user') ? '👤 **用户**' : '🤖 **AI**';
    const textEl = msg.querySelector('.ds-message-text');
    const content = textEl ? (textEl.textContent || textEl.innerText) : '';
    markdown += '### ' + role + '\n\n' + content + '\n\n---\n\n';
  });

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '对话记录_' + new Date().toISOString().slice(0, 10) + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ChatUI.showToast('对话已导出', 'success');
}

/**
 * 复制整个对话到剪贴板
 */
function copyConversation() {
  const list = document.getElementById('messageList');
  if (!list) return;
  const messages = list.querySelectorAll('.ds-message');
  if (messages.length === 0) { ChatUI.showToast('没有可复制的内容', 'error'); return; }

  let text = '';
  messages.forEach(function(msg) {
    const role = msg.classList.contains('user') ? '用户' : 'AI';
    const textEl = msg.querySelector('.ds-message-text');
    const content = textEl ? (textEl.textContent || textEl.innerText) : '';
    text += '【' + role + '】\n' + content + '\n\n';
  });

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => { ChatUI.showToast('已复制到剪贴板', 'success'); })
      .catch(() => { fallbackCopy(text, () => ChatUI.showToast('已复制到剪贴板', 'success')); });
  } else {
    fallbackCopy(text, () => ChatUI.showToast('已复制到剪贴板', 'success'));
  }
}

// ==================== 重新生成 ====================

async function regenerateLastMessage() {
  const list = document.getElementById('messageList');
  if (!list) return;
  const messages = list.querySelectorAll('.ds-message.assistant');
  if (messages.length === 0) return;
  const lastMsg = messages[messages.length - 1];
  const msgId = lastMsg.dataset.msgId;
  if (!msgId) {
    const btn = lastMsg.querySelector('[onclick*="regenerateMessage"]');
    if (btn) {
      const onclickAttr = btn.getAttribute('onclick');
      if (onclickAttr) {
        const match = onclickAttr.match(/\d+/);
        if (match) regenerateMessage(parseInt(match[0], 10));
      }
    }
    return;
  }
  regenerateMessage(msgId);
}

async function regenerateMessage(msgId) {
  if (!msgId) { ChatUI.showToast('消息 ID 无效', 'error'); return; }
  const result = await MessageManager.regenerate(msgId);
  if (result && result.success) {
    const list = document.getElementById('messageList');
    if (!list) return;
    const messages = list.querySelectorAll('.ds-message.assistant');
    for (const msg of messages) {
      const btn = msg.querySelector('[onclick*="regenerateMessage(' + msgId + ')"]');
      if (btn) {
        const textEl = msg.querySelector('.ds-message-text');
        if (textEl && result.data && result.data.content) {
          textEl.innerHTML = renderMarkdown(result.data.content);
        }
        ChatUI.showToast('已重新生成', 'success');
        return;
      }
    }
    location.reload();
  } else {
    ChatUI.showToast((result && result.error) || '重新生成失败', 'error');
  }
}

// ==================== 模型切换 ====================

async function switchModel(modelKey) {
  if (!modelKey) return;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const convId = pathParts[pathParts.length - 1];
  if (convId && convId !== 'new') {
    const result = await ConversationManager.switchModel(convId, modelKey);
    if (result && result.success) {
      ChatUI.showToast('已切换模型', 'success');
    } else {
      ChatUI.showToast((result && result.error) || '切换模型失败', 'error');
    }
  }
}

// ==================== 会话操作 ====================

async function renameConversation() {
  const titleEl = document.getElementById('chatTitle');
  if (!titleEl) return;
  const currentTitle = titleEl.textContent;
  const newTitle = prompt('请输入新标题：', currentTitle);
  if (!newTitle || newTitle === currentTitle) return;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const convId = pathParts[pathParts.length - 1];
  if (!convId || convId === 'new') return;
  const result = await ConversationManager.rename(convId, newTitle);
  if (result && result.success) {
    titleEl.textContent = newTitle;
    ChatUI.showToast('已重命名', 'success');
  } else {
    ChatUI.showToast((result && result.error) || '重命名失败', 'error');
  }
}

async function clearConversation() {
  if (!confirm('确定要删除当前对话吗？')) return;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const convId = pathParts[pathParts.length - 1];
  if (!convId || convId === 'new') return;
  const result = await ConversationManager.delete(convId);
  if (result && result.success) {
    window.location.href = '/chat';
  } else {
    ChatUI.showToast((result && result.error) || '删除失败', 'error');
  }
}

function toggleSidebar() { ChatUI.toggleSidebar(); }

/**
 * 移动端侧边栏切换
 */
function toggleMobileSidebar() {
  const sidebar = document.getElementById('dsSessionSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (sidebar) {
    sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
  }
}

/**
 * 创建新对话
 */
async function createNewConversation() {
  try {
    // 获取当前选中的模型
    const modelSelect = document.getElementById('sidebarModelSelect') || document.getElementById('homeModelSelect');
    const body = { title: '新对话' };
    if (modelSelect && modelSelect.value) {
      body.model = modelSelect.value;
      sessionStorage.setItem('selectedModel', modelSelect.value);
    }
    const res = await fetch('/api/chat/conversation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.success && data.data && data.data.id) {
      window.location.href = '/chat/' + data.data.id;
    } else {
      console.error('[createNewConversation] 创建失败:', data.error || '返回数据异常');
    }
  } catch (err) {
    console.error('[createNewConversation] 错误:', err);
  }
}

/**
 * 搜索侧边栏对话
 */
let sidebarSearchTimeout = null;
function searchSidebarConversations(query) {
  if (sidebarSearchTimeout) clearTimeout(sidebarSearchTimeout);
  sidebarSearchTimeout = setTimeout(function() {
    const list = document.getElementById('sidebarConvList');
    if (!list) return;
    const items = list.querySelectorAll('.ds-history-item');
    if (!query.trim()) {
      items.forEach(function(item) { item.style.display = ''; });
      return;
    }
    let hasResults = false;
    items.forEach(function(item) {
      const title = (item.querySelector('.ds-history-item-title')?.textContent || '').toLowerCase();
      if (title.includes(query.toLowerCase())) {
        item.style.display = '';
        hasResults = true;
      } else {
        item.style.display = 'none';
      }
    });
    const empty = list.querySelector('.ds-history-empty');
    if (!hasResults) {
      if (empty) {
        empty.style.display = '';
        empty.querySelector('p').textContent = '未找到匹配的对话';
      }
    } else if (empty) {
      empty.style.display = 'none';
    }
  }, 300);
}

async function loadSidebarConversations() {
  const list = document.getElementById('sidebarConvList');
  if (!list) return;
  const result = await ConversationManager.list();
  if (!result || !result.success) return;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const currentConvId = pathParts[pathParts.length - 1];
  list.innerHTML = '';

  if (result.data && result.data.length > 0) {
    result.data.forEach(function(conv) {
      const isActive = String(conv.id) === String(currentConvId);
      const item = document.createElement('a');
      item.href = '/chat/' + conv.id;
      item.className = 'ds-history-item' + (isActive ? ' active' : '');
      item.innerHTML =
        '<div class="ds-history-item-icon">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' +
        '</div>' +
        '<div class="ds-history-item-info">' +
        '<div class="ds-history-item-title">' + escapeHtml(conv.title || '未命名') + '</div>' +
        '<div class="ds-history-item-meta">' + escapeHtml(conv.model || '') + ' · ' + (conv.message_count || 0) + ' 条消息</div>' +
        '</div>';
      list.appendChild(item);
    });
  } else {
    list.innerHTML =
      '<div class="ds-history-empty">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ddd" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' +
      '<p>暂无对话记录</p>' +
      '<span>开始一段新的对话吧</span>' +
      '</div>';
  }
}

// ========== 右侧面板功能函数 ==========

/**
 * 切换侧边栏 Tab
 * @param {string} tab - tab 名称: history/settings/skills
 * @param {HTMLElement} btn - 点击的按钮元素
 */
function switchSidebarTab(tab, btn) {
  // 更新 Tab 按钮状态
  document.querySelectorAll('.sidebar-tab').forEach(function(t) { t.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // 更新 Tab 内容
  document.querySelectorAll('.sidebar-tab-content').forEach(function(c) { c.classList.remove('active'); });
  var content = document.getElementById('sidebar-' + tab);
  if (content) content.classList.add('active');
  // 切换时加载对应数据
  if (tab === 'settings') loadSidebarModels();
  if (tab === 'skills') loadSidebarRoles();
}

/**
 * 加载侧边栏模型列表
 */
async function loadSidebarModels() {
  var list = document.getElementById('sidebarModelList');
  if (!list) return;
  list.innerHTML = '<p class="sidebar-empty">加载中...</p>';
  try {
    var result = await ModelManager.list();
    if (!result || !result.success) {
      list.innerHTML = '<p class="sidebar-empty">加载失败</p>';
      return;
    }
    if (result.data.length === 0) {
      list.innerHTML = '<p class="sidebar-empty">暂无自定义模型，点击上方按钮添加</p>';
      return;
    }
    list.innerHTML = '';
    result.data.forEach(function(model) {
      var item = document.createElement('div');
      item.className = 'sidebar-model-item';
      item.innerHTML =
        '<div class="sidebar-model-info">' +
          '<div class="sidebar-model-name">' + escapeHtml(model.name) + '</div>' +
          '<div class="sidebar-model-meta">' + escapeHtml(model.provider || '') + ' · ' + escapeHtml(model.model_key || '') + '</div>' +
        '</div>' +
        '<div class="sidebar-model-actions">' +
          '<button class="btn btn-xs" onclick="editSidebarModel(' + model.id + ')" title="编辑">✏️</button>' +
          '<button class="btn btn-xs" onclick="deleteSidebarModel(' + model.id + ')" title="删除">🗑️</button>' +
          '<button class="btn btn-xs" onclick="testSidebarModel(' + model.id + ')" title="测试连接">🔌</button>' +
        '</div>';
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<p class="sidebar-empty">加载出错</p>';
  }
}

/**
 * 加载侧边栏角色列表
 */
async function loadSidebarRoles() {
  var list = document.getElementById('sidebarRoleList');
  if (!list) return;
  list.innerHTML = '<p class="sidebar-empty">加载中...</p>';
  try {
    var res = await fetch('/api/chat/roles');
    var result = await res.json();
    if (!result || !result.success) {
      list.innerHTML = '<p class="sidebar-empty">加载失败</p>';
      return;
    }
    if (result.data.length === 0) {
      list.innerHTML = '<p class="sidebar-empty">暂无角色，点击上方按钮创建</p>';
      return;
    }
    list.innerHTML = '';
    result.data.forEach(function(role) {
      var item = document.createElement('div');
      item.className = 'sidebar-role-item';
      item.innerHTML =
        '<div class="sidebar-role-avatar">' + (role.avatar || '🎭') + '</div>' +
        '<div class="sidebar-role-info">' +
          '<div class="sidebar-role-name">' + escapeHtml(role.name) + '</div>' +
          '<div class="sidebar-role-desc">' + escapeHtml(role.description || '') + '</div>' +
        '</div>' +
        '<div class="sidebar-role-actions">' +
          '<button class="btn btn-xs" onclick="startChatWithRole(' + role.id + ')" title="使用此角色开始对话">💬</button>' +
        '</div>';
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<p class="sidebar-empty">加载出错</p>';
  }
}

/**
 * 显示添加模型弹窗
 */
function showSidebarAddModel() {
  document.getElementById('sidebarEditModelId').value = '';
  document.getElementById('sidebarModelName').value = '';
  document.getElementById('sidebarModelKey').value = '';
  document.getElementById('sidebarModelProvider').value = 'openai';
  document.getElementById('sidebarModelEndpoint').value = '';
  document.getElementById('sidebarModelApiKey').value = '';
  document.getElementById('sidebarModelMaxTokens').value = '4096';
  document.getElementById('sidebarModelTemperature').value = '0.7';
  document.querySelector('#sidebarModelModal .modal-header h3').textContent = '添加自定义模型';
  openModal('sidebarModelModal');
}

/**
 * 编辑模型
 */
async function editSidebarModel(id) {
  try {
    var result = await ModelManager.get(id);
    if (!result || !result.success) {
      ChatUI.showToast('获取模型信息失败', 'error');
      return;
    }
    var model = result.data;
    document.getElementById('sidebarEditModelId').value = model.id;
    document.getElementById('sidebarModelName').value = model.name || '';
    document.getElementById('sidebarModelKey').value = model.model_key || '';
    document.getElementById('sidebarModelProvider').value = model.provider || 'openai';
    document.getElementById('sidebarModelEndpoint').value = model.endpoint || '';
    document.getElementById('sidebarModelApiKey').value = model.api_key || '';
    document.getElementById('sidebarModelMaxTokens').value = model.max_tokens || '4096';
    document.getElementById('sidebarModelTemperature').value = model.temperature || '0.7';
    document.querySelector('#sidebarModelModal .modal-header h3').textContent = '编辑自定义模型';
    openModal('sidebarModelModal');
  } catch (e) {
    ChatUI.showToast('加载模型信息失败', 'error');
  }
}

/**
 * 保存模型（新建或更新）
 */
async function saveSidebarModel(event) {
  event.preventDefault();
  var id = document.getElementById('sidebarEditModelId').value;
  var data = {
    name: document.getElementById('sidebarModelName').value.trim(),
    model_key: document.getElementById('sidebarModelKey').value.trim(),
    provider: document.getElementById('sidebarModelProvider').value,
    endpoint: document.getElementById('sidebarModelEndpoint').value.trim(),
    api_key: document.getElementById('sidebarModelApiKey').value.trim(),
    max_tokens: parseInt(document.getElementById('sidebarModelMaxTokens').value) || 4096,
    temperature: parseFloat(document.getElementById('sidebarModelTemperature').value) || 0.7
  };
  if (!data.name || !data.model_key || !data.api_key) {
    ChatUI.showToast('请填写必填字段', 'error');
    return;
  }
  try {
    var result;
    if (id) {
      result = await ModelManager.update(id, data);
    } else {
      result = await ModelManager.create(data);
    }
    if (result && result.success) {
      ChatUI.showToast(id ? '模型已更新' : '模型已添加', 'success');
      closeModal('sidebarModelModal');
      loadSidebarModels();
    } else {
      ChatUI.showToast((result && result.error) || '保存失败', 'error');
    }
  } catch (e) {
    ChatUI.showToast('保存失败: ' + e.message, 'error');
  }
}

/**
 * 删除模型
 */
async function deleteSidebarModel(id) {
  if (!confirm('确定要删除此模型吗？')) return;
  try {
    var result = await ModelManager.delete(id);
    if (result && result.success) {
      ChatUI.showToast('模型已删除', 'success');
      loadSidebarModels();
    } else {
      ChatUI.showToast((result && result.error) || '删除失败', 'error');
    }
  } catch (e) {
    ChatUI.showToast('删除失败: ' + e.message, 'error');
  }
}

/**
 * 测试模型连接
 */
async function testSidebarModel(id) {
  try {
    var result = await ModelManager.test(id);
    if (result && result.success) {
      ChatUI.showToast('✅ 连接成功: ' + (result.data || '模型响应正常'), 'success');
    } else {
      ChatUI.showToast('❌ 连接失败: ' + ((result && result.error) || '无法连接到模型服务'), 'error');
    }
  } catch (e) {
    ChatUI.showToast('❌ 连接失败: ' + e.message, 'error');
  }
}

/**
 * 显示添加角色弹窗
 */
function showSidebarAddRole() {
  document.getElementById('sidebarEditRoleId').value = '';
  document.getElementById('sidebarRoleName').value = '';
  document.getElementById('sidebarRoleAvatar').value = '';
  document.getElementById('sidebarRoleDescription').value = '';
  document.getElementById('sidebarRoleSystemPrompt').value = '';
  document.querySelector('#sidebarRoleModal .modal-header h3').textContent = '创建角色（技能）';
  openModal('sidebarRoleModal');
}

/**
 * 保存角色
 */
async function saveSidebarRole(event) {
  event.preventDefault();
  var id = document.getElementById('sidebarEditRoleId').value;
  var data = {
    name: document.getElementById('sidebarRoleName').value.trim(),
    avatar: document.getElementById('sidebarRoleAvatar').value.trim() || '🎭',
    description: document.getElementById('sidebarRoleDescription').value.trim(),
    system_prompt: document.getElementById('sidebarRoleSystemPrompt').value.trim()
  };
  if (!data.name || !data.system_prompt) {
    ChatUI.showToast('请填写必填字段', 'error');
    return;
  }
  try {
    var url = '/api/chat/roles' + (id ? '/' + id : '');
    var method = id ? 'PUT' : 'POST';
    var res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify(data)
    });
    var result = await res.json();
    if (result && result.success) {
      ChatUI.showToast(id ? '角色已更新' : '角色已创建', 'success');
      closeModal('sidebarRoleModal');
      loadSidebarRoles();
    } else {
      ChatUI.showToast((result && result.error) || '保存失败', 'error');
    }
  } catch (e) {
    ChatUI.showToast('保存失败: ' + e.message, 'error');
  }
}

/**
 * 使用角色开始聊天
 */
async function startChatWithRole(roleId) {
  try {
    var res = await fetch('/api/chat/roles/' + roleId);
    var result = await res.json();
    if (!result || !result.success) {
      ChatUI.showToast('获取角色信息失败', 'error');
      return;
    }
    var role = result.data;
    // 创建新对话并使用该角色的系统提示词
    var convResult = await ConversationManager.create('', '', role.system_prompt || '');
    if (convResult && convResult.success && convResult.data && convResult.data.id) {
      window.location.href = '/chat/' + convResult.data.id;
    } else {
      ChatUI.showToast('创建对话失败', 'error');
      console.error('[startChatWithRole] 创建对话失败:', convResult ? convResult.error : '请求无响应');
    }
  } catch (e) {
    ChatUI.showToast('操作失败: ' + e.message, 'error');
  }
}

/**
 * 打开弹窗
 */
function openModal(modalId) {
  document.getElementById(modalId).style.display = 'flex';
  document.getElementById('sidebarModalOverlay').style.display = 'block';
}

/**
 * 关闭弹窗
 */
function closeModal(modalId) {
  document.getElementById(modalId).style.display = 'none';
  document.getElementById('sidebarModalOverlay').style.display = 'none';
}

/**
 * 关闭所有侧边栏弹窗
 */
function closeAllSidebarModals() {
  document.querySelectorAll('.modal-overlay').forEach(function(m) { m.style.display = 'none'; });
  document.getElementById('sidebarModalOverlay').style.display = 'none';
}
