// 后台管理公共脚本
// 由 views/admin/layout.ejs 在页面内容（<%- body %>）之后加载。
// 媒体选择器由各编辑器视图（article-editor / page-editor）内联实现，此处不再提供，
// 避免与本文件同名函数相互覆盖。
// 通用工具（escapeHtml / showToast / copyToClipboard / withButtonLoading 等）位于 utils.js，先于本文件加载。

// ============ 管理员重置用户密码 ============
function resetPassword(userId, username, btn) {
  if (!confirm('确定要重置用户 "' + username + '" 的密码吗？\n重置后用户将收到随机密码，下次登录需要修改密码。')) {
    return;
  }

  var request = function() {
    return fetch('/auth/admin-reset-password/' + userId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function(response) {
        // 非 JSON 响应（如网关错误页）按空对象处理，统一走失败分支
        return response.json().catch(function() { return {}; });
      })
      .then(function(data) {
        if (data.success) {
          showToast('密码已重置成功！\n\n用户名: ' + data.username + '\n新密码: ' + data.newPassword +
            '\n\n请妥善保管新密码，并告知用户。\n用户下次登录时需要修改密码。', 'success');
        } else {
          showToast('重置失败: ' + (data.error || '未知错误'), 'error');
        }
      })
      .catch(function(err) {
        showToast('网络错误: ' + err.message, 'error');
      });
  };

  if (btn) {
    withButtonLoading(btn, '重置中...', request);
  } else {
    request();
  }
}

function resetPasswordFromBtn(el) {
  resetPassword(parseInt(el.getAttribute('data-user-id'), 10), el.getAttribute('data-username'), el);
}

// ============ 管理员手动创建账户 ============
function openCreateUserModal() {
  var modal = document.getElementById('create-user-modal');
  if (!modal) return;

  ['new-username', 'new-email', 'new-password'].forEach(function(id) {
    var input = document.getElementById(id);
    if (input) input.value = '';
  });
  var roleSelect = document.getElementById('new-role');
  if (roleSelect) roleSelect.value = 'user';
  hideCreateUserError();

  var submitBtn = document.getElementById('submit-create-user');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = '创建账户';
  }
  modal.style.display = 'flex';
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

  hideCreateUserError();

  withButtonLoading(document.getElementById('submit-create-user'), '创建中...', function() {
    return fetch('/admin/users/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, email: email, password: password, role: role })
    })
      .then(function(response) {
        return response.json().catch(function() { return {}; }).then(function(data) {
          if (!response.ok) {
            throw new Error(data.error || '创建失败 (HTTP ' + response.status + ')');
          }
          return data;
        });
      })
      .then(function(data) {
        if (data.success) {
          showToast('账户创建成功！\n\n用户名: ' + username + '\n角色: ' +
            (role === 'admin' ? '管理员' : role === 'visitor' ? '访客' : '用户'), 'success');
          closeCreateUserModal();
          // 刷新页面显示新用户
          location.reload();
        } else {
          showCreateUserError(data.error || '创建失败');
        }
      })
      .catch(function(err) {
        showCreateUserError(err.message || '网络错误，请重试');
      });
  });
}

// 点击模态框遮罩关闭（全局注册一次，不覆盖 window.onclick，避免与视图脚本冲突）
document.addEventListener('click', function(event) {
  var userModal = document.getElementById('create-user-modal');
  if (userModal && event.target === userModal) {
    closeCreateUserModal();
  }
});
