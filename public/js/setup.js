(function () {
  'use strict';

  var STEPS = 3;
  var currentStep = 1;
  var formState = {
    username: '',
    password: '',
    confirmPassword: '',
    email: '',
    dbMode: 'balanced',
    customPragma: {}
  };

  var elements = {
    steps: document.querySelectorAll('.step'),
    dots: document.querySelectorAll('.step-dot'),
    lines: document.querySelectorAll('.step-line'),
    form: document.getElementById('setup-form'),
    alert: document.querySelector('.setup-container > .alert'),
    alertMessage: document.querySelector('.setup-container > .alert > span:last-child'),
    loading: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
  };

  // ====== Step Navigation ======

  function showStep(step) {
    if (step < 1 || step > STEPS) return;
    currentStep = step;

    elements.steps.forEach(function (el, i) {
      el.classList.toggle('active', i + 1 === step);
    });

    elements.dots.forEach(function (dot, i) {
      var idx = i + 1;
      dot.classList.remove('active', 'completed');
      if (idx === step) dot.classList.add('active');
      else if (idx < step) dot.classList.add('completed');
    });

    elements.lines.forEach(function (line, i) {
      line.classList.toggle('active', i + 1 < step);
    });

    // Scroll to top of form
    if (elements.form) {
      elements.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    hideAlert();
  }

  function goNext() {
    if (currentStep < STEPS) {
      if (validateStep(currentStep)) {
        collectFormData();
        if (currentStep === 2) renderSummary();
        showStep(currentStep + 1);
      }
    }
  }

  function goPrev() {
    if (currentStep > 1) {
      showStep(currentStep - 1);
    }
  }

  // ====== Global exports for onclick handlers ======
  window.goNext = goNext;
  window.goPrev = goPrev;
  window.nextStep = goNext;
  window.prevStep = goPrev;

  // ====== Alert ======

  function showAlert(message, type) {
    if (!elements.alert || !elements.alertMessage) return;
    var icon = type === 'error' ? '⚠️' : '✅';
    elements.alert.className = 'alert alert-' + type;
    elements.alertMessage.innerHTML = icon + ' ' + escapeHtml(message);
    elements.alert.style.display = 'flex';
  }

  function hideAlert() {
    if (elements.alert) {
      elements.alert.style.display = 'none';
    }
  }

  // ====== Step 1: Admin Account Validation ======

  function checkPasswordStrength(password) {
    var bar = document.getElementById('strength-bar');
    if (!bar) return;
    var score = 0;
    if (password.length >= 6) score += 1;
    if (password.length >= 10) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;

    var width = (score / 5) * 100;
    var bg = '#e0e0e0';
    if (score <= 1) bg = '#dc2626';
    else if (score <= 2) bg = '#f59e0b';
    else if (score <= 3) bg = '#10b981';
    else bg = '#059669';

    bar.style.width = width + '%';
    bar.style.background = bg;
  }

  function checkUsernameAvailability(username) {
    var errorEl = document.getElementById('username-error');
    if (!username || username.length < 3) {
      if (errorEl) errorEl.classList.remove('visible');
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/setup/check-username?username=' + encodeURIComponent(username), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4 && xhr.status === 200) {
        var data = JSON.parse(xhr.responseText);
        if (errorEl) {
          var usernameInput = document.getElementById('username');
          if (!data.available) {
            errorEl.textContent = '该用户名已被使用';
            errorEl.classList.add('visible');
            if (usernameInput) usernameInput.classList.add('error');
          } else {
            errorEl.classList.remove('visible');
            if (usernameInput) usernameInput.classList.remove('error');
          }
        }
      }
    };
    xhr.send();
  }

  // Debounced username check
  var usernameCheckTimer;
  document.addEventListener('input', function (e) {
    if (e.target.id === 'username') {
      clearTimeout(usernameCheckTimer);
      usernameCheckTimer = setTimeout(function () {
        checkUsernameAvailability(e.target.value);
      }, 400);
    }
  });

  function validateStep1() {
    var usernameInput = document.getElementById('username');
    var passwordInput = document.getElementById('password');
    var confirmInput = document.getElementById('confirm_password');
    var emailInput = document.getElementById('email');

    var username = usernameInput ? usernameInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    var confirmPassword = confirmInput ? confirmInput.value : '';

    var errorEl = document.getElementById('username-error');

    if (!username || username.length < 3) {
      showAlert('用户名至少需要3个字符', 'error');
      if (usernameInput) usernameInput.focus();
      return false;
    }

    if (errorEl && errorEl.classList.contains('visible')) {
      showAlert('该用户名已被使用，请选择其他用户名', 'error');
      if (usernameInput) usernameInput.focus();
      return false;
    }

    if (!password || password.length < 6) {
      showAlert('密码至少需要6个字符', 'error');
      if (passwordInput) passwordInput.focus();
      return false;
    }

    if (password !== confirmPassword) {
      showAlert('两次输入的密码不一致', 'error');
      if (confirmInput) confirmInput.focus();
      return false;
    }

    formState.username = username;
    formState.password = password;
    formState.confirmPassword = confirmPassword;
    formState.email = emailInput ? emailInput.value.trim() : '';

    return true;
  }

  // Real-time password match check
  document.addEventListener('input', function (e) {
    if (e.target.id === 'password' || e.target.id === 'confirm_password') {
      var pwInput = document.getElementById('password');
      var cpwInput = document.getElementById('confirm_password');
      var pw = pwInput ? pwInput.value : '';
      var cpw = cpwInput ? cpwInput.value : '';
      var errorEl = document.getElementById('confirm-error');
      if (errorEl) {
        if (cpw && pw !== cpw) {
          errorEl.textContent = '两次输入的密码不一致';
          errorEl.classList.add('visible');
        } else {
          errorEl.classList.remove('visible');
        }
      }
      if (e.target.id === 'password') {
        checkPasswordStrength(e.target.value);
      }
    }
  });

  // ====== Step 2: DB Mode Selection ======

  function selectMode(mode) {
    document.querySelectorAll('.preset-card').forEach(function (card) {
      card.classList.remove('selected');
    });

    var target = document.querySelector('[data-mode="' + mode + '"]');
    if (target) target.classList.add('selected');

    var customOptions = document.getElementById('custom-options');
    if (customOptions) {
      customOptions.style.display = mode === 'custom' ? 'block' : 'none';
    }

    formState.dbMode = mode;
    hideAlert();
  }

  window.selectMode = selectMode;

  function selectPreset(el, mode) {
    // Check the radio
    var radio = el.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;

    // Deselect all
    document.querySelectorAll('.preset-card').forEach(function (card) {
      card.classList.remove('selected');
    });

    // Select this one
    el.classList.add('selected');

    // Handle custom options
    var customOptions = document.getElementById('custom-options');
    if (customOptions) {
      customOptions.style.display = mode === 'custom' ? 'block' : 'none';
    }

    formState.dbMode = mode;
    hideAlert();
  }

  window.selectPreset = selectPreset;

  function validateStep2() {
    return true;
  }

  // ====== Step 3: Summary ======

  function renderSummary() {
    var usernameEl = document.getElementById('summary-username');
    if (usernameEl) usernameEl.textContent = formState.username;

    var emailEl = document.getElementById('summary-email');
    if (emailEl) emailEl.textContent = formState.email || '(未设置)';

    // DB mode label
    var modeEl = document.getElementById('summary-mode');
    var modeMap = {
      balanced: '均衡模式',
      performance: '高性能模式',
      safety: '安全模式',
      memory: '低内存模式',
      custom: '自定义模式'
    };
    if (modeEl) modeEl.textContent = modeMap[formState.dbMode] || formState.dbMode;
  }

  // ====== Form Submission ======

  function submitSetup() {
    if (!validateStep1()) return;

    var submitBtn = document.getElementById('submit-btn');
    if (submitBtn) submitBtn.disabled = true;

    showLoading('正在配置数据库...');

    var formData = new FormData();
    formData.append('username', formState.username);
    formData.append('password', formState.password);
    formData.append('email', formState.email);
    formData.append('confirm_password', formState.confirmPassword);
    formData.append('db_mode', formState.dbMode);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/setup', true);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        hideLoading();

        if (xhr.status === 200) {
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { data = { success: true }; }

          if (data.success) {
            showLoading('安装完成，即将进入管理后台...');
            setTimeout(function () {
              window.location.href = data.redirect || '/admin?setup=complete';
            }, 1000);
          } else {
            showAlert(data.message || '安装失败，请重试', 'error');
            if (submitBtn) submitBtn.disabled = false;
          }
        } else {
          var errMsg = '服务器错误 (' + xhr.status + ')';
          try {
            var errData = JSON.parse(xhr.responseText);
            if (errData.message) errMsg = errData.message;
          } catch (e) {
            // 忽略JSON解析错误，使用默认错误消息
            console.error('解析错误响应失败:', e);
          }
          showAlert(errMsg, 'error');
          if (submitBtn) submitBtn.disabled = false;
        }
      }
    };

    xhr.onerror = function () {
      hideLoading();
      showAlert('网络错误，请检查连接后重试', 'error');
      if (submitBtn) submitBtn.disabled = false;
    };

    xhr.send(formData);
  }

  window.submitSetup = submitSetup;

  // ====== Loading Overlay ======

  function showLoading(text) {
    if (elements.loading) elements.loading.style.display = 'flex';
    if (text && elements.loadingText) elements.loadingText.textContent = text;
  }

  function hideLoading() {
    if (elements.loading) elements.loading.style.display = 'none';
  }

  // ====== Validation Dispatcher ======

  function validateStep(step) {
    switch (step) {
      case 1: return validateStep1();
      case 2: return validateStep2();
      default: return true;
    }
  }

  function collectFormData() {
    var usernameInput = document.getElementById('username');
    var passwordInput = document.getElementById('password');
    var confirmInput = document.getElementById('confirm_password');
    var emailInput = document.getElementById('email');

    formState.username = usernameInput ? usernameInput.value.trim() : '';
    formState.password = passwordInput ? passwordInput.value : '';
    formState.confirmPassword = confirmInput ? confirmInput.value : '';
    formState.email = emailInput ? emailInput.value.trim() : '';
  }

  // ====== Utility ======

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  // ====== Keyboard Navigation ======

  document.addEventListener('keydown', function (e) {
    if (elements.loading && elements.loading.style.display === 'flex') return;
    if (e.key === 'Enter') {
      var activeStep = document.querySelector('.step.active');
      if (activeStep) {
        if (e.target.tagName === 'TEXTAREA') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;

        if (currentStep < STEPS) {
          goNext();
        } else {
          submitSetup();
        }
      }
    }
  });

  // ====== Init ======

  showStep(1);
  checkPasswordStrength('');

})();
