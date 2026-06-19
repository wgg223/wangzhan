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
    ['welcome_popup_content', '<p>欢迎来到本站！我们致力于为您提供优质的内容和服务。</p><p>请浏览我们的文章、图片和小说，享受愉快的在线体验。</p>'],
    ['cdn_enabled', '0'],
    ['cdn_provider', 'custom'],
    ['cdn_base_url', 'https://dalaowang233.top'],
    ['cdn_version', '1.0.0']
  ];

  settings.forEach(([key, value]) => {
    db.run('INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  });

  // 插入默认权限（简化版：按模块合并，每个模块一个管理权限）
  const defaultPermissions = [
    // 前端访问权限
    ['homepage.access', '主页访问', '访问网站主页（默认授予）'],
    ['articles.access', '文章访问', '浏览文章列表和详情'],
    ['novels.access', '小说访问', '访问小说模块'],
    ['image-share.access', '图片分享访问', '访问图片分享模块'],
    ['poem-game.access', '诗词游戏访问', '访问诗词游戏模块'],
    // 内容管理权限
    ['articles.manage', '文章管理', '文章的查看、创建、编辑、删除、发布及评论管理'],
    ['novels.manage', '小说管理', '小说的查看、创建、编辑、删除及章节管理'],
    ['pages.manage', '页面管理', '页面的查看、创建、编辑、删除和发布'],
    ['media.manage', '媒体管理', '媒体文件的查看、上传、编辑和删除'],
    // 用户与权限管理
    ['users.manage', '用户管理', '用户的查看、创建、编辑、删除、禁用及角色管理'],
    ['permissions.manage', '权限管理', '权限的查看、审批、撤销'],
    // 社区与消息
    ['messages.manage', '站内信管理', '站内信的查看、发送、删除和群发'],
    ['comments.manage', '评论管理', '评论的查看、审核、编辑和删除'],
    // 图片分享管理
    ['image-share.manage', '图片分享管理', '图片的查看、上传、编辑、删除、审核、分类及用户管理'],
    // 系统管理
    ['settings.manage', '系统设置', '网站基础设置、SMTP、协议、弹窗、CDN等配置'],
    ['data.manage', '数据管理', '数据备份、恢复、导入和导出'],
    ['leaderboard.manage', '排行榜管理', '排行榜数据的查看和管理']
  ];

  defaultPermissions.forEach(([key, name, desc]) => {
    db.run('INSERT OR IGNORE INTO permissions (perm_key, perm_name, description) VALUES (?, ?, ?)', [key, name, desc]);
  });

  // 迁移旧权限到新权限（为已有用户映射旧权限到新权限）
  try {
    const oldToNewMap = {
      'articles.view': 'articles.manage', 'articles.create': 'articles.manage',
      'articles.edit.own': 'articles.manage', 'articles.edit.all': 'articles.manage',
      'articles.delete.own': 'articles.manage', 'articles.delete.all': 'articles.manage',
      'articles.publish': 'articles.manage', 'articles.category': 'articles.manage',
      'articles.comment.view': 'articles.manage', 'articles.comment.create': 'articles.manage',
      'articles.comment.delete.own': 'articles.manage', 'articles.comment.delete.all': 'articles.manage',
      'articles.comment.moderate': 'articles.manage',
      'novels.view': 'novels.manage', 'novels.create': 'novels.manage',
      'novels.edit.own': 'novels.manage', 'novels.edit.all': 'novels.manage',
      'novels.delete.own': 'novels.manage', 'novels.delete.all': 'novels.manage',
      'novels.chapters.view': 'novels.manage', 'novels.chapters.create': 'novels.manage',
      'novels.chapters.edit.own': 'novels.manage', 'novels.chapters.edit.all': 'novels.manage',
      'novels.chapters.delete.own': 'novels.manage', 'novels.chapters.delete.all': 'novels.manage',
      'image-share.view': 'image-share.manage', 'image-share.upload': 'image-share.manage',
      'image-share.upload.batch': 'image-share.manage', 'image-share.edit.own': 'image-share.manage',
      'image-share.edit.all': 'image-share.manage', 'image-share.delete.own': 'image-share.manage',
      'image-share.delete.all': 'image-share.manage', 'image-share.download': 'image-share.manage',
      'image-share.favorite': 'image-share.manage', 'image-share.comment.view': 'image-share.manage',
      'image-share.comment.create': 'image-share.manage', 'image-share.comment.delete.own': 'image-share.manage',
      'image-share.comment.delete.all': 'image-share.manage', 'image-share.categories.view': 'image-share.manage',
      'image-share.categories.manage': 'image-share.manage', 'image-share.review': 'image-share.manage',
      'image-share.no-review': 'image-share.manage', 'image-share.users.manage': 'image-share.manage',
      'image-share.comments.manage': 'image-share.manage',
      'pages.view': 'pages.manage', 'pages.create': 'pages.manage',
      'pages.edit': 'pages.manage', 'pages.delete': 'pages.manage', 'pages.publish': 'pages.manage',
      'users.view': 'users.manage', 'users.create': 'users.manage',
      'users.edit': 'users.manage', 'users.delete': 'users.manage',
      'users.disable': 'users.manage', 'users.role.view': 'users.manage',
      'users.role.edit': 'users.manage', 'users.permissions.view': 'users.manage',
      'permissions.view': 'permissions.manage', 'permissions.applications.view': 'permissions.manage',
      'permissions.applications.approve': 'permissions.manage', 'permissions.applications.reject': 'permissions.manage',
      'permissions.revoke': 'permissions.manage',
      'comments.view': 'comments.manage', 'comments.moderate': 'comments.manage',
      'comments.edit': 'comments.manage', 'comments.delete': 'comments.manage',
      'media.view': 'media.manage', 'media.upload': 'media.manage',
      'media.edit': 'media.manage', 'media.delete': 'media.manage',
      'settings.view': 'settings.manage', 'settings.basic': 'settings.manage',
      'settings.smtp': 'settings.manage', 'settings.agreement': 'settings.manage',
      'settings.popup': 'settings.manage', 'settings.seo': 'settings.manage',
      'settings.advanced': 'settings.manage', 'settings.manage': 'settings.manage',
      'data.backup': 'data.manage', 'data.restore': 'data.manage',
      'data.export': 'data.manage', 'data.import': 'data.manage',
      'logs.view': 'data.manage', 'logs.activity': 'data.manage',
      'logs.export': 'data.manage', 'logs.delete': 'data.manage',
      'messages.admin.view': 'messages.manage', 'messages.admin.send': 'messages.manage',
      'messages.admin.broadcast': 'messages.manage', 'messages.admin.delete': 'messages.manage',
      'messages.view': 'messages.manage', 'messages.send': 'messages.manage',
      'messages.delete.own': 'messages.manage', 'messages.mark-read': 'messages.manage',
      'community.follow': 'community.access', 'community.unfollow': 'community.access',
      'community.like': 'community.access', 'community.unlike': 'community.access',
      'community.favorite': 'community.access', 'community.unfavorite': 'community.access',
      'community.notification.view': 'community.access', 'community.notification.mark-read': 'community.access',
      'community.access': 'community.access', 'messages.access': 'messages.access',
      'search.access': 'homepage.access', 'novels.read': 'novels.access',
      'image-share.browse': 'image-share.access',
      'leaderboard.view': 'leaderboard.manage'
    };

    const migratedUsers = new Set();
    const userPerms = queryAll(db, 'SELECT user_id, perm_key FROM user_permissions');
    userPerms.forEach(({ user_id, perm_key }) => {
      const newKey = oldToNewMap[perm_key];
      if (newKey && newKey !== perm_key) {
        db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
          [user_id, newKey, user_id]);
        migratedUsers.add(user_id);
      }
    });

    // 迁移待审核的权限申请
    const pendingApps = queryAll(db, "SELECT id, user_id, perm_key FROM permission_applications WHERE status = 'pending'");
    pendingApps.forEach(({ id, user_id, perm_key }) => {
      const newKey = oldToNewMap[perm_key];
      if (newKey && newKey !== perm_key) {
        db.run('UPDATE permission_applications SET perm_key = ? WHERE id = ?', [newKey, id]);
      }
    });

    if (migratedUsers.size > 0) {
      console.log(`[db-seed] 已为 ${migratedUsers.size} 个用户迁移权限到新版本`);
    }
  } catch (e) {
    // 迁移失败不影响启动
    console.error('[db-seed] 权限迁移出错:', e.message);
  }

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
