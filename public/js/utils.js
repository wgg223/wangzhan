/**
 * 前端共享工具函数
 * 在所有页面中通过 <script src="/js/utils.js"> 引入
 */

/**
 * HTML 转义，防止 XSS
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

/**
 * 获取 CSRF Token
 */
function getCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

/**
 * 显示 Toast 提示
 * @param {string} message
 * @param {string} type - success, error, warning, info
 * @param {number} duration - 毫秒，默认3000
 */
function showToast(message, type, duration) {
  if (!message) return;
  duration = duration || Math.max(3000, Math.min(8000, message.length * 80));

  var existing = document.querySelector('.toast-message, .admin-toast, .ds-toast');
  if (existing) {
    existing.classList.add('hiding', 'ds-toast--hiding');
    setTimeout(function() { existing.remove(); }, 300);
  }

  var toast = document.createElement('div');
  toast.className = 'toast-message admin-toast';
  if (type) toast.classList.add('toast-' + type);
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(function() {
    toast.classList.add('hiding');
    setTimeout(function() { toast.remove(); }, 300);
  }, duration);
}

/**
 * 复制文本到剪贴板（带回退）
 * @param {string} text
 * @param {string} successMsg
 */
function copyToClipboard(text, successMsg) {
  successMsg = successMsg || '已复制到剪贴板';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showToast(successMsg, 'success');
    }).catch(function() {
      fallbackCopy(text, successMsg);
    });
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast(successMsg || '已复制到剪贴板', 'success');
  } catch (err) {
    showToast('复制失败，请手动复制', 'error');
  }
  document.body.removeChild(textarea);
}

/**
 * 带 CSRF Token 的 fetch 封装（含超时控制）
 * @param {string} url
 * @param {Object} options - fetch 选项，自动注入 CSRF token
 * @param {number} timeoutMs - 超时毫秒数，默认15秒
 * @returns {Promise}
 */
function csrfFetch(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  options = options || {};
  options.headers = options.headers || {};
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  options.headers['X-CSRF-Token'] = getCsrfToken();
  // AJAX 标识：服务端依赖 X-Requested-With 区分 JSON 响应与页面重定向
  options.headers['X-Requested-With'] = 'XMLHttpRequest';

  var controller = null;
  var timer = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  }

  return fetch(url, options).then(function(response) {
    if (timer) clearTimeout(timer);
    return response.json();
  }).catch(function(err) {
    if (timer) clearTimeout(timer);
    if (err.name === 'AbortError') {
      showToast('请求超时，请检查网络后重试', 'error');
    }
    throw err;
  });
}

/**
 * 按钮加载状态封装
 * @param {HTMLElement} btn
 * @param {string} loadingText
 * @param {Function} asyncFn - 返回 Promise 的异步函数
 */
function withButtonLoading(btn, loadingText, asyncFn) {
  var originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText || '处理中...';
  return asyncFn().finally(function() {
    btn.disabled = false;
    btn.textContent = originalText;
  });
}

/**
 * 打开模态框
 */
function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.style.display = 'block';
}

/**
 * 关闭模态框
 */
function closeModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

/**
 * 格式化相对时间
 * @param {string|number} timestamp
 * @returns {string}
 */
function formatTime(timestamp) {
  var date = new Date(timestamp);
  var now = new Date();
  var diff = (now - date) / 1000;

  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';

  var month = (date.getMonth() + 1).toString().padStart(2, '0');
  var day = date.getDate().toString().padStart(2, '0');
  return month + '/' + day;
}
