/**
 * 统一通知 / 邮件 / 告警服务
 * 能力：
 *   - createNotification：写入 notifications 表（站内通知中心）
 *   - getNotifLink：按 target_type 生成点击跳转地址（含管理员/普通用户分流）
 *   - notifyAdmins：通知全部管理员（站内 + 绑定邮箱邮件，无邮箱自动跳过）
 *   - broadcastToAllUsers：向全部活跃用户广播站内通知（维护模式等）
 *   - sendEmailsToUsers：仅向有邮箱且 SMTP 已配置的用户发送邮件
 *   - alertAdminsOnce：带内存节流的告警（限流 / 攻击 / 重启等，避免轰击管理员）
 * 说明：邮件发送全部异步兜底，失败只写日志，不影响主流程。
 */
const { queryAll, saveDatabase } = require('../config/database');
const { getSettings } = require('../utils/settings');
const { getSmtpConfig, sendMail } = require('../config/mailer');
const logger = require('../utils/logger');

// 告警/邮件节流表：key -> 最近一次触发时间
const throttleMap = new Map();
const THROTTLE_MAX_ENTRIES = 5000;
const THROTTLE_ENTRY_TTL = 60 * 60 * 1000;

/**
 * 创建一条站内通知
 * @param {object} db 数据库实例
 * @param {object} opts { userId, type, title, content, fromUserId, targetType, targetId }
 * @returns {boolean} 是否写入成功
 */
function createNotification(db, { userId, type, title, content, fromUserId, targetType, targetId }) {
  try {
    db.run(
      `INSERT INTO notifications (user_id, type, title, content, from_user_id, target_type, target_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, type, title, content || '', fromUserId || null, targetType || '', targetId || '']
    );
    return true;
  } catch (err) {
    console.error('[通知] 创建通知失败:', err.message);
    return false;
  }
}

/**
 * 生成通知点击跳转地址
 * @param {object} n 通知行（target_type / target_id）
 * @param {object} user 当前用户（含 role）
 * @returns {string|null} 站内跳转地址
 */
function getNotifLink(n, user) {
  const tt = n.target_type || '';
  const tid = n.target_id || '';
  const isAdminLike = Boolean(user && (user.role === 'admin' || user.role === 'super_admin'));
  const enc = (value) => encodeURIComponent(String(value));

  if (tt === 'article' && tid) return '/articles/' + enc(tid);
  if (tt === 'comment' && tid) return '/articles/' + enc(tid);
  if (tt === 'user' && tid) return '/user/' + enc(tid);
  if (tt === 'conversation' && tid) return '/chat/' + enc(tid);
  if (tt === 'image' && tid) return '/image-share/image?id=' + enc(tid);
  if (tt === 'community_post' && tid) return '/community/post/' + enc(tid);
  if (tt === 'novel' && tid) return '/novels/' + enc(tid);
  if (tt === 'prompt' && tid) return '/ai-prompts?prompt=' + enc(tid);
  if (tt === 'spreadsheet' && tid) return '/office/' + enc(tid);

  // 权限审批：管理员跳「我的审批」，申请者跳「权限申请」记录页
  if (tt === 'permission' || tt === 'permission_application') {
    if (isAdminLike) {
      return tid ? '/admin/my-approvals?id=' + enc(tid) : '/admin/my-approvals';
    }
    return '/permissions/apply';
  }

  // 维护通知：管理员直达维护设置，普通用户回首页
  if (tt === 'maintenance') {
    return isAdminLike ? '/admin/maintenance' : '/';
  }

  // 服务器/安全告警：仅管理员可见（普通用户即使误收也不跳后台）
  if (tt === 'server_alert' || tt === 'security_alert') {
    return isAdminLike ? '/admin/activity-logs' : '/';
  }

  // 管理员待办类通知
  if (tt === 'admin_users') {
    return tid === 'pending' ? '/admin/users?status=pending' : '/admin/users';
  }
  if (tt === 'admin_comments') return '/admin/comments';
  if (tt === 'admin_image_comments' || tt === 'admin_images') return '/admin/image-share';
  if (tt === 'admin_prompts') return '/admin/prompts';
  if (tt === 'admin_spreadsheets') return '/admin/spreadsheets';
  if (tt === 'admin_messages') return '/admin/messages';

  if (tt === 'account' || tt === 'email_bind') return '/account#bind-email';
  return null;
}

/**
 * HTML 转义（邮件模板中的用户输入必须转义）
 */
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 读取站点名称与站点地址（用于邮件标题和按钮绝对链接）
 * @returns {{siteName: string, siteUrl: string}}
 */
function getSiteInfo(db) {
  let settings = {};
  try {
    settings = getSettings(db) || {};
  } catch (err) {
    settings = {};
  }
  const siteName = settings.site_name || '本站';
  let siteUrl = String(process.env.SITE_URL || settings.site_url || '').trim();
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    siteUrl = 'https://' + siteUrl;
  }
  siteUrl = siteUrl.replace(/\/+$/, '');
  return { siteName, siteUrl };
}

/**
 * 构建通用事件邮件 HTML
 * @param {object} opts { siteName, siteUrl, title, content, details, actionPath, actionText }
 */
function buildEventEmail({ siteName, siteUrl, title, content, details, actionPath, actionText }) {
  const safeTitle = escapeHtml(title);
  const safeContent = escapeHtml(content || '').replace(/\n/g, '<br>');
  const detailRows = (details || [])
    .filter((item) => item && item.label && item.value !== undefined && item.value !== null && item.value !== '')
    .map((item) => `<tr>
      <td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(item.label)}</td>
      <td style="padding:6px 0;color:#0f172a;font-size:13px;word-break:break-all;">${escapeHtml(item.value)}</td>
    </tr>`)
    .join('');
  const actionUrl = actionPath && siteUrl ? siteUrl + actionPath : '';
  const action = actionUrl
    ? `<p style="margin:24px 0 8px;"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:11px 22px;background:#7c3aed;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;">${escapeHtml(actionText || '前往处理')}</a></p>
       <p style="margin:0;color:#94a3b8;font-size:12px;word-break:break-all;">若按钮无法点击，请复制链接：${escapeHtml(actionUrl)}</p>`
    : '';
  const year = new Date().getFullYear();

  return `<div style="max-width:640px;margin:0 auto;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 24px;background:#7c3aed;color:#ffffff;">
      <div style="font-size:12px;opacity:0.85;">${escapeHtml(siteName)}</div>
      <h2 style="margin:6px 0 0;font-size:20px;line-height:1.4;">${safeTitle}</h2>
    </div>
    <div style="padding:24px;">
      <div style="color:#334155;font-size:14px;line-height:1.8;">${safeContent}</div>
      ${detailRows ? `<table style="margin:18px 0 0;border-collapse:collapse;width:100%;">${detailRows}</table>` : ''}
      ${action}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.6;">
      此邮件由系统自动发送，请勿直接回复。<br>&copy; ${year} ${escapeHtml(siteName)}
    </div>
  </div>
</div>`;
}

/**
 * 查询有邮箱的活跃用户
 * @param {object} db
 * @param {number[]} userIds
 * @returns {Array<{id:number, username:string, email:string}>}
 */
function getEmailRecipients(db, userIds) {
  const ids = Array.from(new Set((userIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  try {
    const placeholders = ids.map(() => '?').join(',');
    return queryAll(
      db,
      `SELECT id, username, email FROM users
       WHERE id IN (${placeholders})
         AND status = 'active'
         AND email IS NOT NULL
         AND TRIM(email) != ''`,
      ids
    );
  } catch (err) {
    logger.error('[通知] 查询邮箱失败:', err.message);
    return [];
  }
}

/**
 * 向指定用户发送邮件（自动跳过未绑定邮箱用户与未配置 SMTP 的情况）
 * @param {object} db
 * @param {number[]} userIds
 * @param {object} options { subject, title, content, details, actionPath, actionText }
 * @returns {Promise<{sent:number,total:number,skipped:number}>}
 */
function sendEmailsToUsers(db, userIds, options) {
  const opts = options || {};
  if (!db) return Promise.resolve({ sent: 0, total: 0, skipped: 0 });

  let smtpConfig = null;
  try {
    smtpConfig = getSmtpConfig(db);
  } catch (err) {
    smtpConfig = null;
  }
  if (!smtpConfig) {
    return Promise.resolve({ sent: 0, total: 0, skipped: (userIds || []).length });
  }

  const recipients = getEmailRecipients(db, userIds);
  if (recipients.length === 0) {
    return Promise.resolve({ sent: 0, total: 0, skipped: (userIds || []).length });
  }

  const { siteName, siteUrl } = getSiteInfo(db);
  const subject = opts.subject || ('【' + siteName + '】' + (opts.title || '系统通知'));
  const html = buildEventEmail({
    siteName,
    siteUrl,
    title: opts.title || '系统通知',
    content: opts.content || '',
    details: opts.details || [],
    actionPath: opts.actionPath || '',
    actionText: opts.actionText || ''
  });

  return Promise.allSettled(recipients.map((user) => sendMail(db, {
    to: user.email,
    subject,
    html
  }).catch((err) => {
    logger.error('[通知] 邮件发送失败:', user.email, err.message);
    return null;
  }))).then((results) => {
    const sent = results.filter((item) => item.status === 'fulfilled' && item.value).length;
    return { sent, total: recipients.length, skipped: Math.max(0, (userIds || []).length - recipients.length) };
  });
}

/**
 * 查询全部活跃管理员（admin / super_admin）
 * @returns {Array<{id:number, username:string, email:string}>}
 */
function getActiveAdmins(db) {
  try {
    return queryAll(
      db,
      "SELECT id, username, email FROM users WHERE status = 'active' AND role IN ('admin', 'super_admin') ORDER BY id ASC"
    );
  } catch (err) {
    logger.error('[通知] 查询管理员失败:', err.message);
    return [];
  }
}

/**
 * 通知全部管理员：站内通知 + 邮件（无邮箱跳过）
 * @param {object} db
 * @param {object} opts {
 *   type, title, content, fromUserId, targetType, targetId,
 *   emailSubject, emailContent, emailDetails, emailActionPath, emailActionText,
 *   emailOnceKey, emailOnceWindowMs, sendEmail
 * }
 * @returns {{count:number}}
 */
function notifyAdmins(db, opts) {
  const options = opts || {};
  const admins = getActiveAdmins(db);
  admins.forEach((admin) => {
    createNotification(db, {
      userId: admin.id,
      type: options.type || 'system',
      title: options.title || '系统通知',
      content: options.content || '',
      fromUserId: options.fromUserId || null,
      targetType: options.targetType || '',
      targetId: options.targetId || ''
    });
  });
  if (admins.length > 0) saveDatabase();

  if (options.sendEmail !== false && admins.length > 0) {
    const onceKey = options.emailOnceKey ? 'email:' + options.emailOnceKey : '';
    const windowMs = Number(options.emailOnceWindowMs) > 0 ? Number(options.emailOnceWindowMs) : 5 * 60 * 1000;
    if (!onceKey || !wasTriggeredRecently(onceKey, windowMs)) {
      sendEmailsToUsers(db, admins.map((admin) => admin.id), {
        subject: options.emailSubject,
        title: options.emailTitle || options.title,
        content: options.emailContent || options.content,
        details: options.emailDetails || [],
        actionPath: options.emailActionPath || '',
        actionText: options.emailActionText || ''
      }).catch((err) => logger.error('[通知] 管理员邮件失败:', err.message));
    }
  }

  return { count: admins.length };
}

/**
 * 向全部活跃用户广播站内通知
 * @param {object} db
 * @param {object} opts { type, title, content, fromUserId, targetType, targetId }
 * @returns {number} 接收用户数
 */
function broadcastToAllUsers(db, opts) {
  const options = opts || {};
  let users = [];
  try {
    users = queryAll(db, "SELECT id FROM users WHERE status = 'active'");
  } catch (err) {
    logger.error('[通知] 广播查询用户失败:', err.message);
    return 0;
  }
  let count = 0;
  users.forEach((user) => {
    if (createNotification(db, {
      userId: user.id,
      type: options.type || 'system',
      title: options.title || '系统通知',
      content: options.content || '',
      fromUserId: options.fromUserId || null,
      targetType: options.targetType || '',
      targetId: options.targetId || ''
    })) {
      count++;
    }
  });
  if (count > 0) saveDatabase();
  return count;
}

/**
 * 判断节流 key 是否在窗口内已触发
 */
function wasTriggeredRecently(key, windowMs) {
  const now = Date.now();
  const last = throttleMap.get(key);
  if (last && now - last < windowMs) return true;
  throttleMap.set(key, now);

  // 防止异常 key 无限增长：超量时清理一小时前的记录
  if (throttleMap.size > THROTTLE_MAX_ENTRIES) {
    for (const [entryKey, timestamp] of throttleMap) {
      if (now - timestamp > THROTTLE_ENTRY_TTL) throttleMap.delete(entryKey);
    }
    if (throttleMap.size > THROTTLE_MAX_ENTRIES) {
      const overflow = throttleMap.size - THROTTLE_MAX_ENTRIES;
      let removed = 0;
      for (const entryKey of throttleMap.keys()) {
        if (removed >= overflow) break;
        throttleMap.delete(entryKey);
        removed++;
      }
    }
  }
  return false;
}

/**
 * 带节流的管理员告警（限流 / 攻击 / 重启等）
 * 同一 key 在窗口期内只通知一次，避免攻击流量把通知表刷爆。
 * @param {object} db
 * @param {string} key 节流键
 * @param {number} windowMs 节流窗口（毫秒）
 * @param {object} opts 同 notifyAdmins
 * @returns {boolean} 本次是否真正触发通知
 */
function alertAdminsOnce(db, key, windowMs, opts) {
  if (!db) return false;
  if (wasTriggeredRecently(key, windowMs)) return false;
  try {
    notifyAdmins(db, Object.assign({ type: 'server_alert' }, opts || {}));
  } catch (err) {
    logger.error('[通知] 管理员告警失败:', err.message);
  }
  return true;
}

module.exports = {
  createNotification,
  getNotifLink,
  buildEventEmail,
  sendEmailsToUsers,
  notifyAdmins,
  broadcastToAllUsers,
  alertAdminsOnce,
  getSiteInfo
};
