// 前端主要JavaScript文件

/**
 * HTML 转义函数，防止 XSS 攻击
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ============ 暗色模式切换 ============
function initThemeToggle() {
  const toggleBtn = document.getElementById('themeToggle');
  if (!toggleBtn) return;

  // 从 localStorage 读取主题偏好
  function getTheme() {
    try {
      return localStorage.getItem('theme') || 'light';
    } catch (e) {
      return 'light';
    }
  }

  // 应用主题
  function setTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      toggleBtn.textContent = '☀️';
      toggleBtn.title = '切换到亮色模式';
    } else {
      document.documentElement.removeAttribute('data-theme');
      toggleBtn.textContent = '🌙';
      toggleBtn.title = '切换到暗色模式';
    }
    try {
      localStorage.setItem('theme', theme);
    } catch (e) { /* ignore */ }
  }

  // 初始化
  setTheme(getTheme());

  // 切换事件
  toggleBtn.addEventListener('click', function() {
    const current = getTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
  });
}

// ============ 移动端菜单 ============
function initMobileMenu() {
  const menuBtn = document.getElementById('mobileMenuBtn');
  const navLinks = document.getElementById('navLinks');
  if (!menuBtn || !navLinks) return;

  menuBtn.addEventListener('click', function() {
    navLinks.classList.toggle('open');
    menuBtn.textContent = navLinks.classList.contains('open') ? '✕' : '☰';
  });

  // 点击导航链接后关闭菜单
  navLinks.querySelectorAll('a').forEach(function(link) {
    link.addEventListener('click', function() {
      navLinks.classList.remove('open');
      menuBtn.textContent = '☰';
    });
  });
}

// ============ 骨架屏 ============
function showSkeleton(container, count, type) {
  if (!container) return;
  type = type || 'card';
  var html = '';
  for (var i = 0; i < count; i++) {
    if (type === 'card') {
      html += '<div class="skeleton-card">' +
        '<div class="skeleton-block skeleton-image"></div>' +
        '<div class="skeleton-block skeleton-title"></div>' +
        '<div class="skeleton-block skeleton-text"></div>' +
        '<div class="skeleton-block skeleton-text short"></div>' +
        '</div>';
    } else if (type === 'list') {
      html += '<div class="skeleton-list-item">' +
        '<div class="skeleton-block skeleton-avatar"></div>' +
        '<div class="skeleton-list-content">' +
        '<div class="skeleton-block skeleton-title"></div>' +
        '<div class="skeleton-block skeleton-text"></div>' +
        '</div>' +
        '</div>';
    } else if (type === 'detail') {
      html += '<div class="skeleton-detail">' +
        '<div class="skeleton-block skeleton-title wide"></div>' +
        '<div class="skeleton-block skeleton-text"></div>' +
        '<div class="skeleton-block skeleton-text"></div>' +
        '<div class="skeleton-block skeleton-text short"></div>' +
        '<div class="skeleton-block skeleton-image tall"></div>' +
        '</div>';
    }
  }
  container.innerHTML = html;
}

function hideSkeleton(container) {
  if (!container) return;
  container.innerHTML = '';
}

// ============ 图片懒加载增强 ============
function initLazyLoading() {
  if (!('IntersectionObserver' in window)) return;

  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        if (img.dataset.srcset) {
          img.srcset = img.dataset.srcset;
          img.removeAttribute('data-srcset');
        }
        img.classList.remove('lazy');
        img.classList.add('lazy-loaded');
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '200px 0px',
    threshold: 0.01
  });

  document.querySelectorAll('img.lazy, img[data-src]').forEach(function(img) {
    observer.observe(img);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  // 用户下拉菜单 - 鼠标悬停增强（解决纯CSS hover的空隙问题）
  const userDropdown = document.querySelector('.user-dropdown');
  if (userDropdown) {
    const dropdownMenu = userDropdown.querySelector('.dropdown-menu');
    let hideTimeout = null;

    const showMenu = function() {
      clearTimeout(hideTimeout);
      if (dropdownMenu) dropdownMenu.style.display = 'block';
    };

    const hideMenu = function() {
      hideTimeout = setTimeout(function() {
        if (dropdownMenu) dropdownMenu.style.display = '';
      }, 100); // 100ms延迟，防止鼠标短暂离开时菜单闪烁
    };

    userDropdown.addEventListener('mouseenter', showMenu);
    userDropdown.addEventListener('mouseleave', hideMenu);

    if (dropdownMenu) {
      dropdownMenu.addEventListener('mouseenter', showMenu);
      dropdownMenu.addEventListener('mouseleave', hideMenu);
    }
  }

  // 初始化暗色模式
  initThemeToggle();

  // 初始化移动端菜单
  initMobileMenu();

  // 初始化图片懒加载
  initLazyLoading();

  // 返回顶部按钮
  const backToTop = document.createElement('button');
  backToTop.innerHTML = '↑';
  backToTop.className = 'back-to-top';
  backToTop.setAttribute('aria-label', '返回顶部');
  document.body.appendChild(backToTop);

  window.addEventListener('scroll', function() {
    if (window.pageYOffset > 300) {
      backToTop.classList.add('visible');
    } else {
      backToTop.classList.remove('visible');
    }
  });

  backToTop.addEventListener('click', function() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// ============ 站内信弹窗功能 ============
function checkMessagePopup() {
  fetch('/messages/check-popup')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.hasPopup) {
        var popup = document.getElementById('message-popup');
        if (popup) {
          document.getElementById('popup-title').textContent = data.message.title;
          // 使用 escapeHtml 转义内容，防止 XSS 攻击
          document.getElementById('popup-content').innerHTML = escapeHtml(data.message.content).replace(/\n/g, '<br>');
          popup.style.display = 'block';
        }
      }
    })
    .catch(function() {});
}

function closeMessagePopup() {
  var popup = document.getElementById('message-popup');
  if (popup) popup.style.display = 'none';
}

function refreshUnreadCount() {
  fetch('/messages/unread-count')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var badge = document.getElementById('msg-unread-badge');
      if (badge) {
        if (data.count > 0) {
          badge.textContent = data.count;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }
    })
    .catch(function() {});
}

document.addEventListener('DOMContentLoaded', function() {
  refreshUnreadCount();
  checkMessagePopup();
});

window.addEventListener('click', function(event) {
  var popup = document.getElementById('message-popup');
  if (popup && event.target === popup) {
    closeMessagePopup();
  }
  var welcomePopup = document.getElementById('welcome-popup');
  if (welcomePopup && event.target === welcomePopup) {
    closeWelcomePopup();
  }
});

// ============ 欢迎弹窗功能 ============
function checkWelcomePopup() {
  var welcomePopup = document.getElementById('welcome-popup');
  if (!welcomePopup) return;

  var dismissed = false;
  try {
    dismissed = localStorage.getItem('welcome_popup_dismissed') === '1';
  } catch (e) { /* ignore */ }

  if (!dismissed) {
    setTimeout(function() {
      welcomePopup.style.display = 'block';
    }, 500);
  }
}

function closeWelcomePopup() {
  var popup = document.getElementById('welcome-popup');
  if (popup) popup.style.display = 'none';
  try {
    localStorage.setItem('welcome_popup_dismissed', '1');
  } catch (e) { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', function() {
  checkWelcomePopup();
});
