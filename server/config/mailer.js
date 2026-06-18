/**
 * SMTP邮件发送模块
 * 从数据库读取SMTP配置并发送邮件
 */
const nodemailer = require('nodemailer');
const { logActivity } = require('./activity');
const { decrypt } = require('./crypto-secure');

/**
 * 从数据库获取SMTP配置
 * @param {Object} db - 数据库实例
 * @returns {Object} SMTP配置对象
 */
function getSmtpConfig(db) {
  if (!db) return null;

  try {
    const { queryAll } = require('./database');
    const settings = queryAll(db, 'SELECT * FROM settings');
    const config = {};
    settings.forEach(s => {
      config[s.setting_key] = s.setting_value;
    });

    // 检查SMTP配置是否完整
    if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
      return null;
    }

    return {
      host: config.smtp_host,
      port: parseInt(config.smtp_port) || 465,
      secure: config.smtp_secure === 'true' || config.smtp_port === '465',
      user: config.smtp_user,
      pass: decrypt(config.smtp_pass),
      from_name: config.smtp_from_name || config.site_name || '网站系统',
      from_email: config.smtp_from_email || config.smtp_user
    };
  } catch (err) {
    console.error('获取SMTP配置失败:', err.message);
    return null;
  }
}

/**
 * 发送邮件
 * @param {Object} db - 数据库实例
 * @param {Object} options - 邮件选项
 * @param {string} options.to - 收件人邮箱
 * @param {string} options.subject - 邮件主题
 * @param {string} options.html - HTML邮件内容
 * @param {string} [options.text] - 纯文本邮件内容（可选）
 * @returns {Promise} 发送结果
 */
function sendMail(db, options) {
  return new Promise((resolve, reject) => {
    try {
      const smtpConfig = getSmtpConfig(db);

      if (!smtpConfig) {
        // 记录SMTP未配置日志
        try {
          logActivity(db, {
            user_id: 0,
            username: '系统',
            action: 'email_send_fail',
            target_type: 'email',
            target_title: options.subject || '邮件',
            detail: `邮件发送失败: ${options.to} - SMTP服务器未配置`,
            ip: ''
          });
        } catch (logErr) {
          console.error('记录邮件发送日志出错:', logErr.message);
        }
        reject(new Error('SMTP服务器未配置，请在网站设置中配置SMTP'));
      }

      const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: {
          user: smtpConfig.user,
          pass: smtpConfig.pass
        }
      });

      const mailOptions = {
        from: `"${smtpConfig.from_name}" <${smtpConfig.from_email}>`,
        to: options.to,
        subject: options.subject,
        html: options.html
      };

      if (options.text) {
        mailOptions.text = options.text;
      }

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('邮件发送失败:', err.message);
          // 记录邮件发送失败日志
          try {
            logActivity(db, {
              user_id: 0,
              username: '系统',
              action: 'email_send_fail',
              target_type: 'email',
              target_title: options.subject || '邮件',
              detail: `邮件发送失败: ${options.to} - 主题: ${options.subject} - 错误: ${err.message}`,
              ip: ''
            });
          } catch (logErr) {
            // 日志记录失败不影响主流程
          }
          reject(err);
        } else {
          // 记录邮件发送成功日志
          try {
            logActivity(db, {
              user_id: 0,
              username: '系统',
              action: 'email_send_success',
              target_type: 'email',
              target_title: options.subject || '邮件',
              detail: `邮件发送成功: ${options.to} - 主题: ${options.subject} - MessageID: ${info.messageId}`,
              ip: ''
            });
          } catch (logErr) {
            // 日志记录失败不影响主流程
          }
          resolve(info);
        }
      });
    } catch (err) {
      // 记录邮件发送异常日志
      try {
        logActivity(db, {
          user_id: 0,
          username: '系统',
          action: 'email_send_fail',
          target_type: 'email',
          target_title: options.subject || '邮件',
          detail: `邮件发送异常: ${options.to} - 错误: ${err.message}`,
          ip: ''
        });
      } catch (logErr) {
        // 日志记录失败不影响主流程
      }
      reject(err);
    }
  });
}

/**
 * 测试SMTP配置是否有效
 * @param {Object} config - SMTP配置
 * @param {string} config.host - SMTP服务器地址
 * @param {number} config.port - SMTP端口
 * @param {boolean} config.secure - 是否使用SSL
 * @param {string} config.user - 用户名
 * @param {string} config.pass - 密码
 * @returns {Promise} 验证结果
 */
function testSmtpConfig(config) {
  return new Promise((resolve, reject) => {
    try {
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.user,
          pass: config.pass
        },
        // 增加超时和 TLS 选项，提高兼容性
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
      });

      // 验证SMTP连接
      transporter.verify((err, success) => {
        if (err) {
          reject(new Error('SMTP连接验证失败: ' + err.message));
        } else {
          resolve({ success: true, message: 'SMTP连接验证成功' });
        }
      });
    } catch (err) {
      reject(new Error('SMTP测试失败: ' + err.message));
    }
  });
}

/**
 * 构建密码重置邮件HTML
 * @param {string} code - 验证码
 * @returns {string} HTML内容
 */
function buildResetPasswordEmail(code) {
  return `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
    <h2 style="color:#333;">密码重置验证码</h2>
    <p style="color:#666;font-size:14px;">您正在请求重置密码，请使用以下验证码：</p>
    <div style="background:#f5f5f5;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
      <span style="font-size:32px;font-weight:bold;color:#007bff;letter-spacing:5px;">${code}</span>
    </div>
    <p style="color:#999;font-size:12px;">验证码有效期为10分钟，请勿泄露给他人。</p>
    <p style="color:#999;font-size:12px;">如果这不是您本人的操作，请忽略此邮件。</p>
  </div>`;
}
/**
 * 构建注册验证码邮件HTML
 * @param {string} code - 验证码
 * @param {string} username - 用户名（可选）
 * @returns {string} HTML内容
 */
function buildRegisterVerificationEmail(code, username) {
  return `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
    <h2 style="color:#333;">注册验证码</h2>
    <p style="color:#666;font-size:14px;">${username ? `用户 <strong>${username}</strong>，您` : '您'}正在进行账号注册，请使用以下验证码完成注册：</p>
    <div style="background:#f5f5f5;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
      <span style="font-size:32px;font-weight:bold;color:#28a745;letter-spacing:5px;">${code}</span>
    </div>
    <p style="color:#999;font-size:12px;">验证码有效期为10分钟，请勿泄露给他人。</p>
    <p style="color:#999;font-size:12px;">如果这不是您本人的操作，请忽略此邮件。</p>
  </div>`;
}


function buildDeleteAccountEmail(code, username, siteUrl) {
  const deleteLink = `${siteUrl}/auth/delete-account?token=${code}`;
  return `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
    <h2 style="color:#dc3545;">账号注销确认</h2>
    <p style="color:#666;font-size:14px;">用户 <strong>${username}</strong>，您正在申请注销账号。</p>
    <p style="color:#666;font-size:14px;">请使用以下验证码完成注销操作：</p>
    <div style="background:#f5f5f5;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
      <span style="font-size:32px;font-weight:bold;color:#dc3545;letter-spacing:5px;">${code}</span>
    </div>
    <p style="color:#666;font-size:14px;">您也可以点击以下安全链接直接完成验证：</p>
    <p style="text-align:center;margin:20px 0;">
      <a href="${deleteLink}" style="background:#dc3545;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-size:16px;">确认注销账号</a>
    </p>
    <p style="color:#999;font-size:12px;">验证码和链接有效期为10分钟，请勿泄露给他人。</p>
    <p style="color:#999;font-size:12px;">如果这不是您本人的操作，请忽略此邮件，您的账号仍然安全。</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="color:#999;font-size:12px;"><strong>重要提醒：</strong>注销后您的所有数据将被永久删除且无法恢复，包括文章、图片、评论、小说等。</p>
  </div>`;
}

/**
 * 构建账号注销成功通知邮件HTML
 * @param {string} username - 用户名
 * @param {string} siteName - 站点名称
 * @returns {string} HTML内容
 */
function buildAccountDeactivatedEmail(username, siteName) {
  const year = new Date().getFullYear();
  return `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
    <h2 style="color:#dc3545;">账号已成功注销</h2>
    <p style="color:#666;font-size:14px;">用户 <strong>${username}</strong>，您好：</p>
    <p style="color:#666;font-size:14px;">您的账号已于 <strong>${new Date().toLocaleString('zh-CN')}</strong> 成功注销。</p>
    <div style="background:#f5f5f5;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #dc3545;">
      <p style="color:#666;font-size:14px;margin:5px 0;"><strong>注销详情：</strong></p>
      <ul style="color:#666;font-size:13px;line-height:1.8;padding-left:20px;">
        <li>您的所有个人数据已被永久删除</li>
        <li>您的用户名已释放，其他人可以重新注册</li>
        <li>此操作不可撤销，账号无法恢复</li>
      </ul>
    </div>
    <p style="color:#999;font-size:12px;margin-top:20px;">如果您误操作了此账号，很抱歉我们无法恢复。您可以重新注册一个新账号。</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="color:#999;font-size:12px;">此邮件由系统自动发送，请勿回复。</p>
    <p style="color:#999;font-size:12px;">&copy; ${year} ${siteName}。保留所有权利。</p>
  </div>`;
}

module.exports = {
  getSmtpConfig,
  sendMail,
  testSmtpConfig,
  buildResetPasswordEmail,
  buildRegisterVerificationEmail,
  buildDeleteAccountEmail,
  buildAccountDeactivatedEmail
};
