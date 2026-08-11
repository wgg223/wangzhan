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
    ['user_agreement', '<h3>第一条 总则</h3>\n<p>1.1 本协议是您与本平台之间关于使用本平台服务所订立的契约。请您在注册或使用本平台前仔细阅读本协议全部内容。</p>\n<p>1.2 您通过网络页面点击确认、实际使用本平台服务等方式，即表示您已充分理解并同意接受本协议的全部内容。</p>\n<p>1.3 如您为未满18周岁的未成年人，请在法定监护人的陪同下阅读本协议，并在获得法定监护人同意后使用本平台服务。</p>\n\n<h3>第二条 账户注册与管理</h3>\n<p>2.1 您应提供真实、准确、合法的注册信息，并在信息发生变更时及时更新。</p>\n<p>2.2 您应妥善保管账户及密码信息，因您保管不善导致的任何损失或损害，由您自行承担。</p>\n<p>2.3 每个邮箱和用户名仅能注册一个账户。如发现恶意注册多个账户，本平台有权冻结或删除相关账户。</p>\n<p>2.4 您的账户仅限您本人使用，未经本平台书面同意，不得以任何方式转让、赠与、借用、分享或出售。</p>\n<p>2.5 本平台有权根据实际情况对长期未使用的账户进行回收处理。</p>\n\n<h3>第三条 服务内容与使用规范</h3>\n<p>3.1 本平台提供文章发布、图片分享、小说阅读、社区互动等服务。具体服务内容以实际提供为准。</p>\n<p>3.2 您在使用本平台服务时，应遵守中华人民共和国相关法律法规，不得利用本平台从事以下行为：</p>\n<p>&emsp;• 发布、传播含有违反国家法律法规内容的信息；</p>\n<p>&emsp;• 发布虚假信息、垃圾广告或恶意内容；</p>\n<p>&emsp;• 侮辱、诽谤、骚扰、威胁其他用户；</p>\n<p>&emsp;• 侵犯他人知识产权、肖像权、隐私权等合法权益；</p>\n<p>&emsp;• 利用技术手段攻击、干扰、破坏本平台的正常运行；</p>\n<p>&emsp;• 其他违反法律法规或本协议约定的行为。</p>\n\n<h3>第四条 用户内容</h3>\n<p>4.1 您在本平台发布的文字、图片、视频等内容（以下简称"用户内容"），其知识产权归您所有。</p>\n<p>4.2 您在发布用户内容时，即授予本平台在全球范围内免费的、非独家的、可再许可的权利，使用、复制、修改、改编、出版、翻译、发行您发布的用户内容，用于本平台运营及推广。</p>\n<p>4.3 您保证对其发布的用户内容享有合法权利，不侵犯任何第三方的合法权益。如因您发布的内容引发纠纷，由您自行承担全部责任。</p>\n<p>4.4 本平台有权对违反法律法规或本协议的用户内容进行删除、屏蔽、断开链接等处理，并有权对违规用户进行处罚。</p>\n\n<h3>第五条 知识产权</h3>\n<p>5.1 本平台的Logo、品牌、界面设计、程序代码等知识产权归本平台所有。</p>\n<p>5.2 未经本平台书面许可，您不得以任何方式复制、修改、传播本平台的任何知识产权。</p>\n\n<h3>第六条 免责声明</h3>\n<p>6.1 本平台不对因不可抗力、系统维护、网络故障、第三方服务中断等原因导致的服务中断或终止承担责任。</p>\n<p>6.2 本平台不对用户发布内容的真实性、准确性、完整性作任何保证，亦不对因用户内容引发的任何损失承担责任。</p>\n<p>6.3 您理解并同意，使用本平台服务的风险由您自行承担。</p>\n\n<h3>第七条 协议修改与终止</h3>\n<p>7.1 本平台有权根据业务发展需要随时修改本协议条款。修改后的协议将在平台公示，如您继续使用本平台服务，即表示您同意修改后的协议。</p>\n<p>7.2 如您不同意修改后的协议，应立即停止使用本平台服务。</p>\n<p>7.3 本平台有权根据实际情况随时终止向您提供服务，终止前将尽可能提前通知。</p>\n\n<h3>第八条 法律适用与争议解决</h3>\n<p>8.1 本协议的订立、执行和解释均适用中华人民共和国法律。</p>\n<p>8.2 如双方就本协议内容发生争议，应友好协商解决；协商不成的，任何一方均可向本平台所在地有管辖权的人民法院提起诉讼。</p>\n\n<h3>第九条 其他条款</h3>\n<p>9.1 本协议中的标题仅为阅读方便而设，不影响对本协议条款含义的解释。</p>\n<p>9.2 本协议条款无论因何种原因部分无效或不可执行，其余条款仍然有效。</p>\n<p>9.3 本协议更新日期：2026年8月7日。</p>'],
    ['privacy_policy', '<h3>第一条 引言</h3>\n<p>1.1 本隐私政策适用于本平台提供的所有服务。我们深知个人信息对您的重要性，将尽全力保护您的个人信息安全。</p>\n<p>1.2 请您在使用本平台服务前，仔细阅读并充分理解本隐私政策的全部内容。</p>\n\n<h3>第二条 信息收集</h3>\n<p>2.1 <strong>您主动提供的信息</strong>：包括但不限于用户名、邮箱地址、密码（加密存储）、个人简介、头像等注册和编辑资料时填写的信息。</p>\n<p>2.2 <strong>您发布的内容</strong>：包括您在本平台发布的文章、图片、评论、小说、私信等内容。</p>\n<p>2.3 <strong>自动收集的信息</strong>：当您使用本平台服务时，我们可能自动收集以下信息：</p>\n<p>&emsp;• 设备信息：设备型号、操作系统版本、浏览器类型；</p>\n<p>&emsp;• 网络信息：IP地址、访问时间、访问页面、来源页面；</p>\n<p>&emsp;• 日志信息：操作日志、错误日志。</p>\n<p>2.4 <strong>第三方登录信息</strong>：当您使用第三方账号（如GitHub、Google等）登录时，我们会在您同意后获取您的第三方账号公开信息。</p>\n\n<h3>第三条 信息使用</h3>\n<p>3.1 我们将收集的信息用于以下目的：</p>\n<p>&emsp;• 为您提供本平台的各项功能和服务；</p>\n<p>&emsp;• 验证用户身份、保障账户安全；</p>\n<p>&emsp;• 优化平台性能、改善用户体验；</p>\n<p>&emsp;• 向您发送系统通知、服务变更等重要信息；</p>\n<p>&emsp;• 进行数据分析以改进服务质量；</p>\n<p>&emsp;• 预防和处理违法违规行为。</p>\n<p>3.2 未经您的同意，我们不会将您的个人信息用于上述目的之外的其他用途。</p>\n\n<h3>第四条 信息存储与保护</h3>\n<p>4.1 <strong>存储方式</strong>：您的个人信息存储在本平台服务器的数据库中，密码采用bcrypt算法加密存储，敏感配置采用AES-256-GCM加密。</p>\n<p>4.2 <strong>存储期限</strong>：我们将在您使用本平台服务期间及注销后合理期限内保留您的个人信息。您注销账户后，我们将在合理期限内删除您的个人信息。</p>\n<p>4.3 <strong>安全措施</strong>：我们采取以下措施保护您的个人信息安全：</p>\n<p>&emsp;• 数据传输采用HTTPS加密；</p>\n<p>&emsp;• 数据存储采用加密技术；</p>\n<p>&emsp;• 建立严格的数据访问权限控制机制；</p>\n<p>&emsp;• 定期进行安全审计和漏洞扫描；</p>\n<p>&emsp;• 制定安全事件应急响应预案。</p>\n<p>4.4 尽管采取上述安全措施，但受限于技术发展水平，无法保证信息的绝对安全。您理解并承担相关风险。</p>\n\n<h3>第五条 信息共享与披露</h3>\n<p>5.1 我们不会向第三方出售、出租或以其他方式分享您的个人信息，但以下情况除外：</p>\n<p>&emsp;• 获得您的明确同意或授权；</p>\n<p>&emsp;• 根据适用的法律法规、法律程序或政府机关的强制性要求；</p>\n<p>&emsp;• 为保护本平台、您或其他用户的合法权益；</p>\n<p>&emsp;• 在紧急情况下，为保护您或公众的人身财产安全。</p>\n<p>5.2 我们可能会与第三方服务提供商合作，这些提供商仅在为我们提供服务的范围内处理您的信息，并受本隐私政策的约束。</p>\n\n<h3>第六条 您的权利</h3>\n<p>6.1 您有权随时查询、更正或补充您的个人信息。</p>\n<p>6.2 您有权要求删除您的账户及个人信息。您可以通过本平台提供的注销功能或联系管理员进行操作。</p>\n<p>6.3 您有权撤回您此前给予的同意。撤回同意不影响此前基于您同意所进行的个人信息处理的合法性。</p>\n<p>6.4 您有权获取您的个人信息副本。</p>\n<p>6.5 行使上述权利时，您可通过本平台提供的功能或联系管理员进行操作。我们将在合理期限内响应您的请求。</p>\n\n<h3>第七条 Cookie及类似技术</h3>\n<p>7.1 本平台使用Cookie和类似技术来保障服务安全、改善用户体验。</p>\n<p>7.2 您可以通过浏览器设置管理Cookie。但请注意，禁用Cookie可能会影响您对本平台部分功能的使用。</p>\n\n<h3>第八条 未成年人保护</h3>\n<p>8.1 我们高度重视未成年人个人信息保护。如您为未满18周岁的未成年人，请在法定监护人陪同下使用本平台服务。</p>\n<p>8.2 对于经监护人同意而收集的未成年人个人信息，我们仅在法律允许、监护人明确同意或保护未成年人的范围内使用或披露。</p>\n\n<h3>第九条 隐私政策更新</h3>\n<p>9.1 我们可能适时修订本隐私政策。更新后的隐私政策将在平台公示。</p>\n<p>9.2 对于重大变更，我们将通过站内通知、邮件等方式告知您。</p>\n<p>9.3 如您在隐私政策更新后继续使用本平台服务，即表示您同意更新后的隐私政策。</p>\n\n<h3>第十条 联系方式</h3>\n<p>10.1 如您对本隐私政策有任何疑问、意见或建议，可通过以下方式联系我们：</p>\n<p>&emsp;• 站内信系统；</p>\n<p>&emsp;• 平台提供的其他联系方式。</p>\n<p>10.2 我们将在合理期限内回复您的请求。</p>\n\n<p><em>本隐私政策更新日期：2026年8月7日</em></p>'],
    ['oauth_privacy_policy', '<h3>第一条 引言</h3>\n<p>1.1 本政策适用于您通过第三方账号（包括但不限于GitHub、微信、QQ、微博、Google等）登录并使用本平台服务的场景。</p>\n<p>1.2 使用第三方账号登录本平台前，请您仔细阅读并充分理解本政策的全部内容。点击第三方登录按钮即表示您同意本政策。</p>\n\n<h3>第二条 我们收集的信息</h3>\n<p>2.1 当您使用第三方账号登录时，经您授权，我们从第三方平台获取以下信息：</p>\n<p>&emsp;• <strong>唯一标识</strong>：第三方平台分配的用户ID（open_id），用于识别您的账号；</p>\n<p>&emsp;• <strong>昵称</strong>：您在第三方平台设置的昵称，用于本平台用户展示；</p>\n<p>&emsp;• <strong>头像</strong>：您在第三方平台设置的头像图片地址；</p>\n<p>&emsp;• <strong>邮箱地址</strong>：您在第三方平台绑定的已验证邮箱（如有，且仅限GitHub和Google平台）。</p>\n<p>2.2 我们不会获取您在第三方平台的密码、好友列表、动态内容或其他非必要信息。</p>\n\n<h3>第三条 信息的使用目的</h3>\n<p>3.1 我们将收集的信息仅用于以下目的：</p>\n<p>&emsp;• 创建并管理您在本平台的用户账号；</p>\n<p>&emsp;• 验证您的身份并保障账号安全；</p>\n<p>&emsp;• 在本平台展示您的昵称和头像；</p>\n<p>&emsp;• 实现第三方账号与本平台账号的绑定和登录功能。</p>\n<p>3.2 我们不会将您的第三方账号信息用于上述目的之外的其他用途。</p>\n\n<h3>第四条 信息的存储与保护</h3>\n<p>4.1 您的第三方账号信息存储在本平台服务器的加密数据库中。</p>\n<p>4.2 第三方平台的访问令牌（access_token）采用加密方式存储，仅用于维持登录状态。</p>\n<p>4.3 我们采取合理的技术措施保护您的信息安全，防止未经授权的访问、使用或泄露。</p>\n\n<h3>第五条 信息的共享与披露</h3>\n<p>5.1 除以下情况外，我们不会向任何第三方共享您的第三方账号信息：</p>\n<p>&emsp;• 获得您的明确同意；</p>\n<p>&emsp;• 根据法律法规或政府机关的强制性要求；</p>\n<p>&emsp;• 为保护本平台、您或其他用户的合法权益。</p>\n<p>5.2 我们不会将您的第三方账号信息出售、出租或以其他方式提供给任何第三方用于商业营销目的。</p>\n\n<h3>第六条 您的权利</h3>\n<p>6.1 您可以随时在本平台的账号设置中解除第三方账号绑定。</p>\n<p>6.2 解除绑定后，我们将不再通过该第三方账号获取您的信息，但已创建的本平台账号不受影响。</p>\n<p>6.3 您可以通过注销本平台账号的方式，要求删除我们持有的您的所有信息，包括第三方账号信息。</p>\n<p>6.4 注销账号后，您的第三方登录绑定关系将同步解除，相关数据将在合理期限内删除。</p>\n\n<h3>第七条 第三方平台责任</h3>\n<p>7.1 第三方登录功能依赖于第三方平台的服务。第三方平台的服务中断、变更或终止可能影响您的登录体验。</p>\n<p>7.2 第三方平台自身的隐私政策和用户协议独立于本平台。建议您同时了解相关第三方平台的隐私政策。</p>\n\n<h3>第八条 未成年人保护</h3>\n<p>8.1 如果您是未满18周岁的未成年人，请在法定监护人的陪同下阅读本政策，并在获得法定监护人同意后使用第三方登录功能。</p>\n\n<h3>第九条 政策更新</h3>\n<p>9.1 我们可能会不时更新本政策。更新后的政策将在本平台公示。</p>\n<p>9.2 如您在政策更新后继续使用第三方登录功能，即表示您同意更新后的政策。</p>\n\n<h3>第十条 联系我们</h3>\n<p>10.1 如您对本政策有任何疑问、意见或建议，请通过本平台提供的联系方式与我们联系。</p>\n<p>10.2 本政策更新日期：2026年8月11日。</p>'],
    ['message_popup_enabled', '0'],
    ['delete_account_agreement', '<h3>账户注销协议</h3>\n<p>在您确认注销账户前，请您仔细阅读以下协议内容：</p>\n\n<h4>一、注销后果</h4>\n<p>1.1 账户注销后，您的所有个人数据将被永久删除，无法恢复。包括但不限于：</p>\n<p>&emsp;• 您发布的文章、图片、评论、小说等全部内容；</p>\n<p>&emsp;• 您的用户信息、权限、排行榜记录；</p>\n<p>&emsp;• 您的站内信和通知记录。</p>\n<p>1.2 您的用户名将被立即释放，其他人可以重新注册使用。</p>\n<p>1.3 此操作不可撤销，系统不提供账号恢复功能。</p>\n\n<h4>二、注销条件</h4>\n<p>2.1 您必须通过身份验证（密码验证 + 邮箱验证码确认）。</p>\n<p>2.2 您的账户必须处于正常状态（未被禁用或冻结）。</p>\n\n<h4>三、数据清理</h4>\n<p>3.1 我们将在确认注销后立即清理您的所有关联数据。</p>\n<p>3.2 部分已删除内容的缓存可能需要一定时间才能完全清除。</p>\n\n<h4>四、免责声明</h4>\n<p>4.1 您确认已充分了解注销后果，自愿放弃账户及所有关联数据的所有权。</p>\n<p>4.2 本平台不对因您自行注销导致的任何损失承担责任。</p>'],
    ['welcome_popup_enabled', '0'],
    ['welcome_popup_title', '欢迎访问'],
    ['welcome_popup_content', '<p>欢迎来到本站！我们致力于为您提供优质的内容和服务。</p><p>请浏览我们的文章、图片和小说，享受愉快的在线体验。</p>'],
    ['privacy_popup_enabled', '1'],
    ['cdn_enabled', '0'],
    ['cdn_provider', 'custom'],
    ['cdn_base_url', 'https://dalaowang233.top'],
    ['cdn_version', '1.0.0'],
    ['agreement_version', '1.0']
  ];

  settings.forEach(([key, value]) => {
    db.run('INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  });

  // 协议版本升级：当 agreement_version 变更时强制更新协议内容
  const AGREEMENT_CURRENT_VERSION = '1.0';
  const versionRow = queryAll(db, "SELECT setting_value FROM settings WHERE setting_key = 'agreement_version'");
  const currentVersion = versionRow.length > 0 ? versionRow[0].setting_value : '0';

  if (currentVersion !== AGREEMENT_CURRENT_VERSION) {
    const agreementEntry = settings.find(([k]) => k === 'user_agreement');
    const privacyEntry = settings.find(([k]) => k === 'privacy_policy');
    if (agreementEntry) {
      db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'user_agreement'", [agreementEntry[1]]);
    }
    if (privacyEntry) {
      db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'privacy_policy'", [privacyEntry[1]]);
    }
    db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'agreement_version'", [AGREEMENT_CURRENT_VERSION]);
  }

  // 插入默认权限（简化版：按模块合并，每个模块一个管理权限）
  const defaultPermissions = [
    // 前端访问权限
    ['homepage.access', '主页访问', '访问网站主页（默认授予）'],
    ['articles.access', '文章访问', '浏览文章列表和详情'],
    ['novels.access', '小说访问', '访问小说模块'],
    ['image-share.access', '图片分享访问', '访问图片分享模块'],
    ['poem-game.access', '诗词游戏访问', '访问诗词游戏模块'],
    // 站点统计权限
    ['site_stats.view', '站点统计', '查看站点基本统计数据（用户数、运行状态等）'],
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

  // 迁移：为所有已存在的活跃用户添加默认权限
  try {
    const defaultUserPerms = [
      'homepage.access', 'articles.access', 'novels.access',
      'image-share.access', 'poem-game.access', 'site_stats.view'
    ];
    const activeUsers = queryAll(db, "SELECT id FROM users WHERE status = 'active'");
    activeUsers.forEach(user => {
      defaultUserPerms.forEach(perm => {
        db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
          [user.id, perm, user.id]);
      });
    });
  } catch (e) {
    // 如果出错（比如表不存在），忽略
  }
}

module.exports = { insertDefaultDataIfNeeded };
