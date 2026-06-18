/**
 * 数据库默认数据播种
 * 使用 INSERT OR IGNORE 保证幂等
 */

const { queryAll } = require('./db-helpers');

function insertDefaultDataIfNeeded(db) {
  // 插入默认图片分享配置
  const imageConfigs = [
    ['site_name', '图片分享网'],
    ['site_description', '分享精彩瞬间，记录美好生活'],
    ['site_logo', '/assets/images/default-avatar.png'],
    ['review_enabled', '1'],
    ['comment_enabled', '1'],
    ['comment_review_enabled', '1'],
    ['guest_view_enabled', '1'],
    ['guest_upload_enabled', '0'],
    ['max_size', '10'],
    ['allowed_formats', 'jpg,png,jpeg,gif,webp'],
    ['images_per_page', '12'],
    ['hot_images_count', '12'],
    ['icp_number', '']
  ];

  imageConfigs.forEach(([key, value]) => {
    db.run('INSERT OR IGNORE INTO image_configs (config_key, config_value) VALUES (?, ?)', [key, value]);
  });

  // 插入默认图片分类
  const defaultImageCategories = [
    ['风景', 1, 1, 1],
    ['人物', 2, 1, 0],
    ['动物', 3, 1, 0],
    ['建筑', 4, 1, 0],
    ['美食', 5, 1, 0],
    ['抽象', 6, 1, 1]
  ];

  defaultImageCategories.forEach(([name, sort, status, is_guest]) => {
    db.run('INSERT OR IGNORE INTO image_categories (name, sort, status, is_guest) VALUES (?, ?, ?, ?)',
      [name, sort, status, is_guest]);
  });

  // 插入默认设置
  const settings = [
    ['site_name', '我的网站'],
    ['site_description', '这是一个功能完整的网站管理系统'],
    ['icp_beian', ''],
    ['icp_number', ''],
    ['police_beian', ''],
    ['icp_link', 'https://beian.miit.gov.cn/'],
    ['background_image', ''],
    ['logo', ''],
    ['footer_text', ''],
    ['smtp_host', ''],
    ['smtp_port', '465'],
    ['smtp_secure', 'true'],
    ['smtp_user', ''],
    ['smtp_pass', ''],
    ['smtp_from_name', ''],
    ['smtp_from_email', ''],
    ['user_agreement', '<h3>一、总则</h3>\n<p>1.1 欢迎使用本站（以下简称"本平台"）。在注册成为本平台用户之前，请您仔细阅读本协议的全部内容。</p>\n<p>1.2 如您不同意本协议的任何条款，请勿注册或使用本平台服务。您点击"同意"或注册即视为您已阅读、理解并接受本协议的全部内容。</p>\n\n<h3>二、用户账户</h3>\n<p>2.1 您注册时需提供真实、准确、完整的个人信息，并在信息变更后及时更新。</p>\n<p>2.2 您应妥善保管账户名和密码，因账户密码泄露导致的损失由您自行承担。</p>\n<p>2.3 每个邮箱和用户名仅能注册一个账户，禁止恶意注册多个账户。</p>\n\n<h3>三、用户行为规范</h3>\n<p>3.1 用户不得利用本平台从事违法违规活动，包括但不限于传播色情、暴力、赌博、毒品等违法信息。</p>\n<p>3.2 用户不得发布虚假、骚扰、侮辱、诽谤等不良信息。</p>\n<p>3.3 用户不得侵犯他人知识产权、隐私权等合法权益。</p>\n<p>3.4 用户不得利用技术手段攻击、破坏本平台的正常运行。</p>\n\n<h3>四、内容发布</h3>\n<p>4.1 用户在本平台发布的内容（包括但不限于文章、评论、图片等）的知识产权归用户所有。</p>\n<p>4.2 用户授予本平台在全球范围内免费的、非独家的使用许可，用于平台展示和推广。</p>\n<p>4.3 本平台有权对违法违规内容进行删除、屏蔽等处理。</p>\n\n<h3>五、免责声明</h3>\n<p>5.1 本平台对因不可抗力、系统维护、网络故障等原因导致的服务中断不承担责任。</p>\n<p>5.2 本平台不对用户发布内容的真实性、准确性、完整性作任何保证。</p>\n<p>5.3 用户因使用本平台而产生的风险由用户自行承担。</p>\n\n<h3>六、协议修改</h3>\n<p>6.1 本平台有权随时修改本协议条款，修改后的协议一经发布即生效。</p>\n<p>6.2 如用户不同意修改后的协议，应停止使用本平台服务。</p>\n\n<h3>七、法律适用</h3>\n<p>7.1 本协议的订立、执行和解释适用中华人民共和国法律。</p>\n<p>7.2 如双方发生争议，应友好协商解决；协商不成的，提交本平台所在地有管辖权的人民法院诉讼解决。</p>'],
    ['privacy_policy', '<h3>一、信息收集</h3>\n<p>1.1 我们收集您提供的个人信息，包括但不限于：用户名、邮箱地址、密码（加密存储）等注册信息。</p>\n<p>1.2 我们自动收集您的使用信息，包括IP地址、浏览器类型、访问时间、浏览记录等。</p>\n<p>1.3 我们使用Cookie和类似技术来改善您的体验。</p>\n\n<h3>二、信息使用</h3>\n<p>2.1 用于为您提供本平台各项功能和服务。</p>\n<p>2.2 用于账户安全验证和用户身份识别。</p>\n<p>2.3 用于优化平台性能和用户体验。</p>\n<p>2.4 用于向您发送系统通知和服务相关的重要信息。</p>\n\n<h3>三、信息保护</h3>\n<p>3.1 我们采用业界通用的安全技术和措施保护您的个人信息，包括SSL加密传输、数据加密存储等。</p>\n<p>3.2 我们建立严格的数据访问权限控制机制，防止信息泄露。</p>\n<p>3.3 尽管采取上述措施，但无法保证绝对的信息安全，您理解并承担相关风险。</p>\n\n<h3>四、信息共享</h3>\n<p>4.1 我们不会向第三方出售或出租您的个人信息。</p>\n<p>4.2 在以下情况下，我们可能会分享您的信息：</p>\n<p>&emsp;• 获得您的明确同意；</p>\n<p>&emsp;• 根据法律法规要求；</p>\n<p>&emsp;• 保护本平台的合法权益；</p>\n<p>&emsp;• 在紧急情况下保护用户人身安全。</p>\n\n<h3>五、用户权利</h3>\n<p>5.1 您有权查询、更正您的个人信息。</p>\n<p>5.2 您有权要求删除您的账户和个人信息。</p>\n<p>5.3 您有权拒绝我们收集部分非必要信息。</p>\n\n<h3>六、政策更新</h3>\n<p>6.1 我们可能适时更新本隐私政策，更新后将在平台公示。</p>\n<p>6.2 如重大变更，我们将通过邮件或站内通知等方式告知。</p>\n\n<h3>七、联系方式</h3>\n<p>7.1 如您对本隐私政策有任何疑问，请通过站内信或邮箱联系我们。</p>'],
    ['message_popup_enabled', '0'],
    ['delete_account_agreement', '<h3>账户注销协议</h3>\n<p>在您确认注销账户前，请您仔细阅读以下协议内容：</p>\n\n<h4>一、注销后果</h4>\n<p>1.1 账户注销后，您的所有个人数据将被永久删除，无法恢复。包括但不限于：</p>\n<p>&emsp;• 您发布的文章、图片、评论、小说等全部内容；</p>\n<p>&emsp;• 您的用户信息、权限、排行榜记录；</p>\n<p>&emsp;• 您的站内信和通知记录。</p>\n<p>1.2 您的用户名将被立即释放，其他人可以重新注册使用。</p>\n<p>1.3 此操作不可撤销，系统不提供账号恢复功能。</p>\n\n<h4>二、注销条件</h4>\n<p>2.1 您必须通过身份验证（密码验证 + 邮箱验证码确认）。</p>\n<p>2.2 您的账户必须处于正常状态（未被禁用或冻结）。</p>\n\n<h4>三、数据清理</h4>\n<p>3.1 我们将在确认注销后立即清理您的所有关联数据。</p>\n<p>3.2 部分已删除内容的缓存可能需要一定时间才能完全清除。</p>\n\n<h4>四、免责声明</h4>\n<p>4.1 您确认已充分了解注销后果，自愿放弃账户及所有关联数据的所有权。</p>\n<p>4.2 本平台不对因您自行注销导致的任何损失承担责任。</p>'],
    ['welcome_popup_enabled', '0'],
    ['welcome_popup_title', '欢迎访问'],
    ['welcome_popup_content', '<p>欢迎来到本站！我们致力于为您提供优质的内容和服务。</p><p>请浏览我们的文章、图片和小说，享受愉快的在线体验。</p>']
  ];

  settings.forEach(([key, value]) => {
    db.run('INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  });

  // 插入默认权限
  const defaultPermissions = [
    ['homepage.access', '主页访问', '访问网站主页（默认授予）'],
    ['articles.access', '文章访问', '浏览文章列表和详情'],
    ['search.access', '搜索访问', '使用搜索功能'],
    ['community.access', '社区访问', '访问社区功能'],
    ['messages.access', '站内信访问', '发送和接收站内信'],
    ['novels.access', '小说访问', '访问小说模块'],
    ['novels.read', '小说阅读', '阅读小说内容'],
    ['poem-game.access', '诗词游戏访问', '访问诗词游戏模块'],
    ['image-share.access', '图片分享访问', '访问图片分享模块'],
    ['image-share.browse', '图片浏览', '浏览图片列表和详情'],
    ['articles.view', '查看文章', '查看文章列表和详情'],
    ['articles.create', '发布文章', '创建新文章'],
    ['articles.edit.own', '编辑自己的文章', '编辑自己发布的文章'],
    ['articles.edit.all', '编辑所有文章', '编辑任何用户的文章'],
    ['articles.delete.own', '删除自己的文章', '删除自己发布的文章'],
    ['articles.delete.all', '删除所有文章', '删除任何用户的文章'],
    ['articles.publish', '发布/下架文章', '设置文章发布状态'],
    ['articles.category', '文章分类管理', '管理文章分类'],
    ['articles.comment.view', '查看文章评论', '查看文章下的评论'],
    ['articles.comment.create', '发表文章评论', '在文章下发表评论'],
    ['articles.comment.delete.own', '删除自己的评论', '删除自己发表的评论'],
    ['articles.comment.delete.all', '删除所有评论', '删除任何用户的评论'],
    ['articles.comment.moderate', '评论审核', '审核文章评论'],
    ['novels.view', '查看小说', '查看小说列表和详情'],
    ['novels.create', '发布小说', '创建新小说'],
    ['novels.edit.own', '编辑自己的小说', '编辑自己发布的小说'],
    ['novels.edit.all', '编辑所有小说', '编辑任何用户的小说'],
    ['novels.delete.own', '删除自己的小说', '删除自己发布的小说'],
    ['novels.delete.all', '删除所有小说', '删除任何用户的小说'],
    ['novels.chapters.view', '查看章节', '查看小说章节内容'],
    ['novels.chapters.create', '创建章节', '为小说添加新章节'],
    ['novels.chapters.edit.own', '编辑自己的章节', '编辑自己创建的章节'],
    ['novels.chapters.edit.all', '编辑所有章节', '编辑任何章节'],
    ['novels.chapters.delete.own', '删除自己的章节', '删除自己创建的章节'],
    ['novels.chapters.delete.all', '删除所有章节', '删除任何章节'],
    ['image-share.view', '查看图片', '查看图片列表和详情'],
    ['image-share.upload', '上传图片', '上传新图片'],
    ['image-share.upload.batch', '批量上传', '批量上传多张图片'],
    ['image-share.edit.own', '编辑自己的图片', '编辑自己上传的图片信息'],
    ['image-share.edit.all', '编辑所有图片', '编辑任何用户的图片信息'],
    ['image-share.delete.own', '删除自己的图片', '删除自己上传的图片'],
    ['image-share.delete.all', '删除所有图片', '删除任何用户的图片'],
    ['image-share.download', '下载图片', '下载图片文件'],
    ['image-share.favorite', '收藏图片', '收藏喜欢的图片'],
    ['image-share.comment.view', '查看图片评论', '查看图片下的评论'],
    ['image-share.comment.create', '发表图片评论', '在图片下发表评论'],
    ['image-share.comment.delete.own', '删除自己的评论', '删除自己发表的图片评论'],
    ['image-share.comment.delete.all', '删除所有评论', '删除任何用户的图片评论'],
    ['image-share.categories.view', '查看图片分类', '查看图片分类列表'],
    ['image-share.categories.manage', '管理图片分类', '创建、编辑、删除图片分类'],
    ['image-share.review', '图片审核', '审核用户上传的图片'],
    ['image-share.no-review', '免审核上传', '上传图片无需审核'],
    ['image-share.users.manage', '管理可信用户', '管理图片分享可信用户列表'],
    ['image-share.comments.manage', '管理图片评论', '审核和管理图片评论'],
    ['community.follow', '关注用户', '关注/取消关注其他用户'],
    ['community.unfollow', '取消关注', '取消关注其他用户'],
    ['community.like', '点赞', '对内容进行点赞'],
    ['community.unlike', '取消点赞', '取消对内容的点赞'],
    ['community.favorite', '收藏', '收藏内容'],
    ['community.unfavorite', '取消收藏', '取消收藏内容'],
    ['community.notification.view', '查看通知', '查看系统通知'],
    ['community.notification.mark-read', '标记已读', '标记通知为已读'],
    ['messages.view', '查看站内信', '查看收到的站内信'],
    ['messages.send', '发送站内信', '给其他用户发送站内信'],
    ['messages.delete.own', '删除自己的站内信', '删除自己收到的站内信'],
    ['messages.mark-read', '标记已读', '标记站内信为已读'],
    ['pages.view', '查看页面', '查看页面列表和详情'],
    ['pages.create', '创建页面', '创建新页面'],
    ['pages.edit', '编辑页面', '编辑页面内容'],
    ['pages.delete', '删除页面', '删除页面'],
    ['pages.publish', '发布/下架页面', '设置页面发布状态'],
    ['users.view', '查看用户', '查看用户列表和详情'],
    ['users.create', '创建用户', '创建新用户'],
    ['users.edit', '编辑用户', '编辑用户信息'],
    ['users.delete', '删除用户', '删除用户'],
    ['users.disable', '禁用用户', '禁用/启用用户'],
    ['users.role.view', '查看用户角色', '查看用户角色信息'],
    ['users.role.edit', '修改用户角色', '修改用户角色'],
    ['users.permissions.view', '查看用户权限', '查看用户的权限列表'],
    ['permissions.view', '查看权限', '查看权限列表和用户权限'],
    ['permissions.applications.view', '查看权限申请', '查看权限申请列表'],
    ['permissions.applications.approve', '批准权限申请', '批准用户的权限申请'],
    ['permissions.applications.reject', '拒绝权限申请', '拒绝用户的权限申请'],
    ['permissions.revoke', '撤销权限', '撤销用户已有的权限'],
    ['comments.view', '查看评论', '查看评论列表'],
    ['comments.moderate', '评论审核', '审核待审核的评论'],
    ['comments.edit', '编辑评论', '编辑评论内容'],
    ['comments.delete', '删除评论', '删除评论'],
    ['media.view', '查看媒体', '查看媒体文件列表'],
    ['media.upload', '上传媒体', '上传媒体文件'],
    ['media.edit', '编辑媒体', '编辑媒体文件信息'],
    ['media.delete', '删除媒体', '删除媒体文件'],
    ['settings.view', '查看设置', '查看网站设置'],
    ['settings.basic', '基础设置', '修改网站基础设置'],
    ['settings.smtp', 'SMTP配置', '配置SMTP邮件服务'],
    ['settings.agreement', '协议管理', '管理用户协议和隐私政策'],
    ['settings.popup', '弹窗设置', '管理弹窗和欢迎信息'],
    ['settings.seo', 'SEO设置', '管理SEO相关设置'],
    ['settings.advanced', '高级设置', '修改高级系统设置'],
    ['data.backup', '数据备份', '备份网站数据'],
    ['data.restore', '数据恢复', '恢复网站数据'],
    ['data.export', '数据导出', '导出网站数据'],
    ['data.import', '数据导入', '导入网站数据'],
    ['logs.view', '查看日志', '查看系统日志'],
    ['logs.activity', '活动日志', '查看用户活动日志'],
    ['logs.export', '导出日志', '导出日志数据'],
    ['logs.delete', '删除日志', '删除日志记录'],
    ['leaderboard.view', '查看排行榜', '查看游戏排行榜'],
    ['leaderboard.manage', '管理排行榜', '管理排行榜数据'],
    ['messages.admin.view', '查看所有站内信', '查看系统所有站内信'],
    ['messages.admin.send', '发送系统站内信', '发送系统站内信给用户'],
    ['messages.admin.broadcast', '群发站内信', '群发站内信给所有用户'],
    ['messages.admin.delete', '删除站内信', '删除任何站内信']
  ];

  defaultPermissions.forEach(([key, name, desc]) => {
    db.run('INSERT OR IGNORE INTO permissions (perm_key, perm_name, description) VALUES (?, ?, ?)', [key, name, desc]);
  });

  // 插入默认项目数据
  const defaultProjects = [
    ['blog', '博客系统', '文章、页面、评论',
      JSON.stringify(['articles', 'comments', 'pages']),
      JSON.stringify(['uploads']), '📄'],
    ['novel', '小说系统', '小说和章节管理',
      JSON.stringify(['novels', 'novel_chapters']),
      JSON.stringify(['uploads/novels']), '📚'],
    ['image', '图片分享', '图片、分类、评论',
      JSON.stringify(['images', 'image_categories', 'image_comments', 'image_logs', 'image_configs']),
      JSON.stringify(['uploads/images']), '🖼️'],
    ['poem', '诗词游戏', '排行榜数据',
      JSON.stringify(['poem_leaderboard']),
      JSON.stringify([]), '🎮']
  ];

  defaultProjects.forEach(([id, name, desc, tables, dirs, icon]) => {
    db.run('INSERT OR IGNORE INTO projects (id, name, description, tables, file_dirs, icon) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, desc, tables, dirs, icon]);
  });

  // 迁移：为所有已存在的活跃用户添加主页访问权限
  try {
    const activeUsers = queryAll(db, "SELECT id FROM users WHERE status = 'active'");
    activeUsers.forEach(user => {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [user.id, 'homepage.access', user.id]);
    });
  } catch (e) {
    // 如果出错（比如表不存在），忽略
  }
}

module.exports = { insertDefaultDataIfNeeded };
