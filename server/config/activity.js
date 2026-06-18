/**
 * 操作活动日志模块
 * 记录用户在后台的各类操作历史，用于在仪表盘展示
 */

const { queryOne, queryAll, saveDatabase } = require('./database');

/**
 * 记录用户操作
 * @param {Object} db - 数据库实例
 * @param {Object} options - 日志选项
 * @param {number} options.user_id - 操作用户ID
 * @param {string} options.username - 操作用户名
 * @param {string} options.action - 操作类型 (create/update/delete/approve/reject/login/logout)
 * @param {string} options.target_type - 操作对象类型 (article/page/media/user/comment/media_comment/novel/novel_chapter/setting)
 * @param {string} options.target_id - 操作对象ID (可选)
 * @param {string} options.target_title - 操作对象标题/名称 (可选)
 * @param {string} options.detail - 操作详情描述 (可选)
 * @param {string} options.ip - 操作者IP地址 (可选)
 */
function logActivity(db, options) {
  if (!db) return;

  const {
    user_id,
    username,
    action,
    target_type,
    target_id,
    target_title,
    detail,
    ip,
    route,
    method
  } = options;

  if (user_id === undefined || user_id === null || !username || !action || !target_type) {
    console.error('活动日志记录缺少必要参数', JSON.stringify({ user_id, username, action, target_type }));
    return;
  }

  try {
    db.run(
      `INSERT INTO activity_logs (user_id, username, action, target_type, target_id, target_title, detail, ip, route, method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))`,
      [
        user_id,
        username,
        action,
        target_type,
        target_id || '',
        target_title || '',
        detail || '',
        ip || '',
        route || '',
        method || ''
      ]
    );
    saveDatabase();
  } catch (err) {
    console.error('活动日志写入失败:', err.message);
  }
}

/**
 * 获取最近的用户操作日志
 * @param {Object} db - 数据库实例
 * @param {number} limit - 获取条数 (默认20)
 * @returns {Array} 操作日志列表
 */
function getRecentActivities(db, limit = 20) {
  if (!db) return [];
  const logs = queryAll(
    db,
    'SELECT * FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?',
    [limit]
  );
  // 为每条日志添加中文标签
  return logs.map(log => ({
    ...log,
    action_label: actionLabels[log.action] || log.action,
    target_label: targetLabels[log.target_type] || log.target_type
  }));
}

/**
 * 获取指定用户的操作日志
 * @param {Object} db - 数据库实例
 * @param {number} userId - 用户ID
 * @param {number} limit - 获取条数 (默认20)
 * @returns {Array} 操作日志列表
 */
function getUserActivities(db, userId, limit = 20) {
  if (!db) return [];
  return queryAll(
    db,
    'SELECT * FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [userId, limit]
  );
}

/**
 * 获取操作类型统计数据
 * @param {Object} db - 数据库实例
 * @param {number} days - 统计天数 (默认7)
 * @returns {Object} 操作统计 - { total, today, by_action, by_target_type }
 */
function getActivityStats(db, days = 7) {
  if (!db) return { total: 0, today: 0, by_action: {}, by_target_type: {} };

  try {
    const total = queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0;
    const today = queryOne(db,
      "SELECT COUNT(*) as count FROM activity_logs WHERE created_at >= datetime('now', '-1 day', '+8 hours')"
    )?.count || 0;

    // 各操作类型统计
    const actionStats = queryAll(db,
      `SELECT action, COUNT(*) as count FROM activity_logs 
       WHERE created_at >= datetime('now', ?, '+8 hours')
       GROUP BY action ORDER BY count DESC`,
      [`-${days} days`]
    ) || [];
    const by_action = {};
    actionStats.forEach(s => { by_action[s.action] = s.count; });

    // 各目标类型统计
    const targetStats = queryAll(db,
      `SELECT target_type, COUNT(*) as count FROM activity_logs 
       WHERE created_at >= datetime('now', ?, '+8 hours')
       GROUP BY target_type ORDER BY count DESC`,
      [`-${days} days`]
    ) || [];
    const by_target_type = {};
    targetStats.forEach(s => { by_target_type[s.target_type] = s.count; });

    return { total, today, by_action, by_target_type };
  } catch (e) {
    return { total: 0, today: 0, by_action: {}, by_target_type: {} };
  }
}

/**
 * 获取用户活跃度统计
 * @param {Object} db - 数据库实例
 * @param {number} days - 统计天数 (默认7)
 * @param {number} limit - 返回用户数 (默认10)
 * @returns {Array} 活跃用户排行
 */
function getActiveUsers(db, days = 7, limit = 10) {
  if (!db) return [];
  try {
    return queryAll(db,
      `SELECT user_id, username, COUNT(*) as action_count, 
              MAX(created_at) as last_action
       FROM activity_logs 
       WHERE created_at >= datetime('now', ?, '+8 hours')
       GROUP BY user_id 
       ORDER BY action_count DESC 
       LIMIT ?`,
      [`-${days} days`, limit]
    ) || [];
  } catch (e) {
    return [];
  }
}

// 操作类型对应的中文描述
const actionLabels = {
  // 基础CRUD
  create: '创建',
  update: '编辑',
  delete: '删除',
  // 页面访问
  view: '访问',
  submit: '提交',
  // 审批
  approve: '通过',
  reject: '拒绝',
  // 用户认证
  login: '登录',
  logout: '登出',
  register: '注册',
  register_info: '填写注册信息',
  register_verify: '验证注册邮箱',
  register_success: '注册成功',
  login_fail: '登录失败',
  // 密码
  reset: '重置密码',
  change_password: '修改密码',
  force_change_password: '强制修改密码',
  forgot_password: '忘记密码',
  forgot_send_code: '发送重置验证码',
  forgot_reset: '重置密码成功',
  // 邮箱
  email_send: '发送邮件',
  email_send_success: '邮件发送成功',
  email_send_fail: '邮件发送失败',
  email_verify: '邮箱验证',
  email_resend: '重新发送验证码',
  // 上传
  upload: '上传',
  batch_upload: '批量上传',
  // 权限
  grant: '授权',
  revoke: '撤销',
  disable: '禁用',
  // 安全
  captcha_fail: '图形验证码失败',
  email_domain_blocked: '邮箱域名被拦截',
  password_sha: 'SHA密码升级',
  // 站内信
  send_message: '发送站内信',
  delete_message: '删除站内信',
  // 账号注销
  delete_account: '注销账号',
  // ===== 新增：服务器运维 =====
  server_start: '服务启动',
  server_stop: '服务关闭',
  server_restart: '服务重启',
  server_reload: '服务重载',
  backup_create: '创建备份',
  backup_restore: '恢复备份',
  cache_clear: '清除缓存',
  database_optimize: '数据库优化',
  // ===== 新增：用户综合操作 =====
  user_login: '用户登录',
  user_logout: '用户登出',
  user_register: '用户注册',
  user_register_success: '注册成功',
  user_register_fail: '注册失败',
  user_verify_email: '验证邮箱',
  user_verify_success: '邮箱验证成功',
  user_verify_fail: '邮箱验证失败',
  user_resend_code: '重新发送验证码',
  user_batch_register: '批量注册',
  user_batch_import: '批量导入',
  // ===== 新增：用户状态管理 =====
  user_enable: '启用用户',
  user_disable: '禁用用户',
  user_approve: '审核通过用户',
  user_reject: '拒绝用户',
  user_lock: '锁定用户',
  user_unlock: '解锁用户',
  // ===== 新增：权限管理 =====
  role_create: '创建角色',
  role_update: '编辑角色',
  role_delete: '删除角色',
  perm_batch_update: '批量更新权限',
  // ===== 新增：评论操作 =====
  comment_batch_approve: '批量通过评论',
  comment_batch_reject: '批量驳回评论',
  comment_batch_delete: '批量删除评论',
  comment_reply: '回复评论',
  // ===== 新增：媒体操作 =====
  media_batch_upload: '批量上传',
  media_batch_delete: '批量删除',
  media_replace: '替换文件',
  media_compress: '压缩文件',
  // ===== 新增：配置操作 =====
  config_update: '更新配置',
  config_reset: '重置配置',
  config_backup: '备份配置',
  config_import: '导入配置',
  config_export: '导出配置',
  // ===== 新增：系统操作 =====
  system_maintenance: '系统维护',
  system_update: '系统更新',
  system_cleanup: '系统清理',
  system_log_clear: '清理日志',
  // ===== 新增：维护工具操作 =====
  clear_cache: '清除缓存',
  clean_temp: '清理临时文件',
  optimize_db: '优化数据库',
  clean_logs: '清理活动日志'
};

// 操作对象类型对应的中文描述
const targetLabels = {
  article: '文章',
  page: '页面',
  media: '媒体文件',
  user: '用户',
  comment: '文章评论',
  media_comment: '图片评论',
  novel: '小说',
  novel_chapter: '小说章节',
  permission: '权限',
  user_role: '用户角色',
  setting: '网站设置',
  settings: '网站设置',
  system: '系统',
  // 认证相关
  auth: '用户认证',
  password: '密码',
  email: '邮件',
  captcha: '图形验证码',
  // 用户状态
  user_status: '用户状态',
  user_account: '用户账号',
  // 站内信
  message: '站内信',
  // ===== 新增：运维相关 =====
  server: '服务器',
  backup: '数据备份',
  cache_system: '缓存系统',
  database: '数据库',
  // ===== 新增：权限角色 =====
  role: '角色',
  user_permission: '用户权限',
  // ===== 新增：日志相关 =====
  activity_log: '操作日志',
  config: '系统配置',
  // ===== 新增：图片分享模块 =====
  image_share: '图片分享',
  // ===== 新增：全局日志目标类型 =====
  admin: '后台管理',
  ai_chat: 'AI聊天',
  rp_hub: '角色扮演',
  frontend: '前台页面',
  poem_game: '诗词游戏',
  profile: '个人资料',
  search: '搜索',
  setup: '系统安装',
  // ===== 新增：维护工具目标类型 =====
  cache: '缓存',
  temp_files: '临时文件',
  activity_logs: '活动日志'
};

/**
 * 格式化操作日志为可读描述
 * @param {Object} log - 日志对象
 * @returns {string} 格式化描述
 */
function formatActivity(log) {
  const action = actionLabels[log.action] || log.action;
  const target = targetLabels[log.target_type] || log.target_type;
  let desc = `${log.username} ${action}了${target}`;
  if (log.target_title) {
    desc += `「${log.target_title}」`;
  }
  if (log.detail) {
    desc += ` - ${log.detail}`;
  }
  return desc;
}

module.exports = {
  logActivity,
  getRecentActivities,
  getUserActivities,
  getActivityStats,
  getActiveUsers,
  formatActivity,
  actionLabels,
  targetLabels
};
