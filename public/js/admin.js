 // 后台管理JavaScript文件

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

/**
 * 显示 Toast 提示
 * @param {string} message - 提示消息
 * @param {string} type - 提示类型: success, error, warning, info
 */
function showToast(message, type) {
  if (!message) return;
  
  // 移除已有的toast
  var existing = document.querySelector('.admin-toast');
  if (existing) {
    existing.classList.add('hiding');
    setTimeout(function() {
      existing.remove();
    }, 300);
  }
  
  // 创建新的toast
  var toast = document.createElement('div');
  toast.className = 'admin-toast';
  toast.textContent = message;
  
  // 添加类型样式
  if (type) {
    toast.classList.add('toast-' + type);
  }
  
  document.body.appendChild(toast);
  
  // 3秒后自动消失
  setTimeout(function() {
    toast.classList.add('hiding');
    setTimeout(function() {
      toast.remove();
    }, 300);
  }, 3000);
}

document.addEventListener('DOMContentLoaded', function() {
  // 初始化代码
});

// ============ 管理员重置用户密码 ============
function resetPassword(userId, username) {
  if (!confirm('确定要重置用户 "' + username + '" 的密码吗？\n重置后用户将收到随机密码，下次登录需要修改密码。')) {
    return;
  }

  var btn = event.target;
  btn.disabled = true;
  btn.textContent = '重置中...';

  fetch('/auth/admin-reset-password/' + userId, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  })
    .then(function(response) {
      return response.json();
    })
    .then(function(data) {
      if (data.success) {
        showToast('密码已重置成功！\n\n用户名: ' + data.username + '\n新密码: ' + data.newPassword + '\n\n请妥善保管新密码，并告知用户。\n用户下次登录时需要修改密码。', 'success');
        btn.disabled = false;
        btn.textContent = '重置密码';
      } else {
        showToast('重置失败: ' + (data.error || '未知错误'), 'error');
        btn.disabled = false;
        btn.textContent = '重置密码';
      }
    })
    .catch(function(err) {
      showToast('网络错误: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '重置密码';
    });
}

// 复制链接到剪贴板
function copyUrl(url) {
  var fullUrl = window.location.origin + url;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(fullUrl).then(function() {
      showToast('链接已复制到剪贴板', 'success');
    }).catch(function() {
      fallbackCopy(fullUrl);
    });
  } else {
    fallbackCopy(fullUrl);
  }
}

function fallbackCopy(text) {
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('链接已复制到剪贴板', 'success');
  } catch (err) {
    showToast('复制失败，请手动复制', 'error');
  }
  document.body.removeChild(textarea);
}

// 打开媒体选择器
function openMediaSelector(targetInputId) {
  var modal = document.getElementById('media-modal');
  if (!modal) return;

  modal.style.display = 'block';
  loadMediaFiles(targetInputId);

  // 点击外部关闭
  window.onclick = function(event) {
    if (event.target === modal) {
      closeMediaSelector();
    }
  };
}

// 关闭媒体选择器
function closeMediaSelector() {
  var modal = document.getElementById('media-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// 加载媒体文件列表
function loadMediaFiles(targetInputId) {
  fetch('/admin/media/list')
    .then(response => response.json())
    .then(media => {
      var mediaList = document.getElementById('media-list');
      if (!mediaList) return;

      var html = '';
      if (media.length > 0) {
        media.forEach(function(item) {
          if (item.file_type && item.file_type.startsWith('image/')) {
            // 使用 escapeHtml 转义用户输入，防止 XSS 攻击
            var safeFilePath = escapeHtml(item.file_path || '');
            var safeOriginalName = escapeHtml(item.original_name || '');
            var safeFilename = escapeHtml(item.filename || '');
            html += '<div class="media-item" onclick="selectMedia(\'' + safeFilePath + '\', \'' + escapeHtml(targetInputId || 'cover_image') + '\')">';
            html += '  <img src="' + safeFilePath + '" alt="' + safeOriginalName + '">';
            html += '  <p>' + (safeOriginalName || safeFilename) + '</p>';
            html += '</div>';
          }
        });
      }

      mediaList.innerHTML = html || '<p style="text-align:center;padding:20px;color:#999;">没有图片文件</p>';
    })
    .catch(function(err) {
      console.error('加载媒体文件失败:', err);
    });
}

// 选择媒体文件
function selectMedia(url, targetInputId) {
  var input = document.getElementById(targetInputId);
  if (input) {
    input.value = url;
  }
  closeMediaSelector();
}

// 确认删除对话框
function confirmDelete(message) {
  return confirm(message || '确定要删除吗？');
}

// 表单验证
function validateForm(formId) {
  var form = document.getElementById(formId);
  if (!form) return true;

  var required = form.querySelectorAll('[required]');
  for (var i = 0; i < required.length; i++) {
    if (!required[i].value.trim()) {
      showToast('请填写所有必填字段', 'warning');
      required[i].focus();
      return false;
    }
  }
  return true;
}

// 上传进度条
function uploadFile(url, formData, progressCallback, successCallback, errorCallback) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);

  xhr.upload.addEventListener('progress', function(e) {
    if (e.lengthComputable && progressCallback) {
      var percent = Math.round((e.loaded / e.total) * 100);
      progressCallback(percent);
    }
  });

  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        var response = JSON.parse(xhr.responseText);
        if (response.success && successCallback) {
          successCallback(response);
        } else if (!response.success && errorCallback) {
          errorCallback(response.error || '上传失败');
        }
      } catch (e) {
        if (successCallback) successCallback({ success: true });
      }
    } else {
      if (errorCallback) errorCallback('上传失败，状态码: ' + xhr.status);
    }
  };

  xhr.onerror = function() {
    if (errorCallback) errorCallback('网络错误');
  };

  xhr.send(formData);
}

// ============ 管理员手动创建账户 ============
function openCreateUserModal() {
  var modal = document.getElementById('create-user-modal');
  if (modal) {
    modal.style.display = 'flex';
    // 清除之前的内容和错误
    document.getElementById('new-username').value = '';
    document.getElementById('new-email').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('new-role').value = 'user';
    hideCreateUserError();
    // 移除禁用状态
    document.getElementById('submit-create-user').disabled = false;
    document.getElementById('submit-create-user').textContent = '创建账户';
  }
}

function closeCreateUserModal() {
  var modal = document.getElementById('create-user-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function showCreateUserError(message) {
  var errorDiv = document.getElementById('create-user-error');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
  }
}

function hideCreateUserError() {
  var errorDiv = document.getElementById('create-user-error');
  if (errorDiv) {
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';
  }
}

function submitCreateUser() {
  var username = document.getElementById('new-username').value.trim();
  var email = document.getElementById('new-email').value.trim();
  var password = document.getElementById('new-password').value;
  var role = document.getElementById('new-role').value;

  // 前端验证
  if (!username) {
    showCreateUserError('请输入用户名');
    document.getElementById('new-username').focus();
    return;
  }
  if (username.length < 3) {
    showCreateUserError('用户名至少3个字符');
    document.getElementById('new-username').focus();
    return;
  }
  if (!password) {
    showCreateUserError('请输入密码');
    document.getElementById('new-password').focus();
    return;
  }
  if (password.length < 6) {
    showCreateUserError('密码至少6位');
    document.getElementById('new-password').focus();
    return;
  }

  var btn = document.getElementById('submit-create-user');
  btn.disabled = true;
  btn.textContent = '创建中...';
  hideCreateUserError();

  fetch('/admin/users/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username: username, email: email, password: password, role: role })
  })
    .then(function(response) {
      return response.json().then(function(data) {
        if (response.ok) {
          return data;
        } else {
          throw new Error(data.error || '创建失败');
        }
      });
    })
    .then(function(data) {
      if (data.success) {
        showToast('账户创建成功！\n\n用户名: ' + username + '\n角色: ' + (role === 'admin' ? '管理员' : role === 'visitor' ? '访客' : '用户'), 'success');
        closeCreateUserModal();
        // 刷新页面显示新用户
        location.reload();
      } else {
        showCreateUserError(data.error || '创建失败');
        btn.disabled = false;
        btn.textContent = '创建账户';
      }
    })
    .catch(function(err) {
      showCreateUserError(err.message || '网络错误，请重试');
      btn.disabled = false;
      btn.textContent = '创建账户';
    });
}

// 点击模态框外部关闭
document.addEventListener('click', function(e) {
  var modal = document.getElementById('create-user-modal');
  if (modal && e.target === modal) {
    closeCreateUserModal();
  }
});
