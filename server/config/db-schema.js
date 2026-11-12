/**
 * 数据库表结构定义（DDL）
 * 作用：集中定义全站业务表的 CREATE TABLE IF NOT EXISTS，仅用于全新初始化建库。
 * 说明：
 *   - 每个表创建前都有对应的注释（见下方各表段）；
 *   - 本文件是表结构的唯一事实来源：所有列都直接写在 CREATE TABLE 中，
 *     不再保留针对存量库的 ALTER TABLE 增量迁移。字段变更请直接修改此处，
 *     并重新初始化数据库（v8.21.0 起不再支持旧库原地升级）；
 *   - app_setup 表必须第一个创建，因为数据库初始化流程依赖它记录安装状态。
 */

function createTables(db) {
  // 创建安装状态表（必须第一个创建，因为其他函数依赖它）
  db.run(`CREATE TABLE IF NOT EXISTS app_setup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setup_key TEXT UNIQUE NOT NULL,
    setup_value TEXT
  )`);

  // 创建用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'pending',
    must_change_password INTEGER DEFAULT 0,
    token_version INTEGER DEFAULT 0,
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    reset_token TEXT,
    reset_token_expires DATETIME,
    nickname TEXT,
    avatar TEXT DEFAULT '/assets/images/default-avatar.png',
    bio TEXT DEFAULT '',
    image_no_review INTEGER DEFAULT 0,
    delete_token TEXT,
    delete_token_expires DATETIME,
    deactivated_at DATETIME,
    uid TEXT DEFAULT '',
    superior_id INTEGER,
    ai_chat_help_seen INTEGER DEFAULT 0,
    ai_ui_settings TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 创建会话表（express-session 自定义 SQLite 存储，降低内存驻留）
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');

  // 创建页面表
  db.run(`CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    content TEXT,
    type TEXT DEFAULT 'page',
    status TEXT DEFAULT 'published',
    parent_id INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    font_color TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 创建文章表
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    cover_image TEXT,
    category TEXT,
    location TEXT DEFAULT 'home',
    status TEXT DEFAULT 'published',
    author_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id)
  )`);

  // 文章草稿表
  db.run(`CREATE TABLE IF NOT EXISTS article_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER,
    title TEXT,
    content TEXT,
    user_id INTEGER NOT NULL,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_article_drafts_user ON article_drafts(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_article_drafts_article ON article_drafts(article_id)');

  // 内容标签表
  db.run(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#6b7280',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 内容-标签关联表
  db.run(`CREATE TABLE IF NOT EXISTS content_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_content_tags_unique ON content_tags(target_type, target_id, tag_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_content_tags_tag ON content_tags(tag_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_content_tags_target ON content_tags(target_type, target_id)');

  // 内容版本管理表
  db.run(`CREATE TABLE IF NOT EXISTS content_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    version_number INTEGER NOT NULL,
    title TEXT,
    content TEXT,
    editor_id INTEGER,
    change_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (editor_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_content_versions_target ON content_versions(target_type, target_id, version_number DESC)');

  // 创建媒体文件表
  db.run(`CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    file_path TEXT NOT NULL,
    file_type TEXT,
    file_size INTEGER,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`);

  // 创建网站设置表
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT
  )`);

  // 创建权限表
  // category：权限类别（basic 前端访问 / content 内容管理 / community 社区与消息 /
  //            image 图片分享 / ai AI应用 / spreadsheet 在线表格 / system 系统管理）
  // high_risk：高危标记（授予后影响账号/权限/站点配置/可批量删除内容等，审批走二级链）
  // sort_order：同类目内展示排序
  db.run(`CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    perm_key TEXT UNIQUE NOT NULL,
    perm_name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'system',
    high_risk INTEGER DEFAULT 0,
    ultra_high_risk INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 创建用户权限关联表
  // expires_at：权限有效期（NULL=永不过期；到期后权限匹配自动失效）
  db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    perm_key TEXT NOT NULL,
    granted_by INTEGER,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
  )`);

  // 创建权限申请表
  // 二级审批流字段：approval_stage（1=待对应管理员审批 2=待上级审批）、high_risk（高危标记）、
  // approved_by_admin / approved_by_superior（一级/二级审批人）、system_confirmed_at（系统确认生效时间）
  db.run(`CREATE TABLE IF NOT EXISTS permission_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    perm_key TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    reject_reason TEXT DEFAULT '',
    approval_stage INTEGER DEFAULT 1,
    high_risk INTEGER DEFAULT 0,
    approved_by_admin INTEGER,
    approved_by_admin_at DATETIME,
    approved_by_superior INTEGER,
    approved_by_superior_at DATETIME,
    system_confirmed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id)
  )`);

  // 用户批量导入历史表
  db.run(`CREATE TABLE IF NOT EXISTS user_import_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    file_type TEXT DEFAULT 'csv',
    total_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    failed_details TEXT DEFAULT '[]',
    operator_id INTEGER,
    operator_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_user_import_logs_time ON user_import_logs(created_at DESC)');

  // 创建评论表
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    user_id INTEGER,
    visitor_name TEXT,
    visitor_email TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    parent_id INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // 创建小说表
  db.run(`CREATE TABLE IF NOT EXISTS novels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    cover_image TEXT,
    description TEXT,
    status TEXT DEFAULT 'published',
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`);

  // 创建小说章节表
  db.run(`CREATE TABLE IF NOT EXISTS novel_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT,
    chapter_number INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  )`);

  // 创建媒体评论表
  db.run(`CREATE TABLE IF NOT EXISTS media_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    user_id INTEGER,
    visitor_name TEXT,
    visitor_email TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // 创建操作活动日志表
  db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT DEFAULT '',
    target_title TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    route TEXT DEFAULT '',
    method TEXT DEFAULT '',
    created_at DATETIME
  )`);

  // ============ 图片分享模块表 ============

  // 图片分类表
  db.run(`CREATE TABLE IF NOT EXISTS image_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    is_guest INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 图片表
  db.run(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    cate_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    visibility TEXT DEFAULT 'public',
    allowed_user_ids TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cate_id) REFERENCES image_categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // 图片操作日志表
  db.run(`CREATE TABLE IF NOT EXISTS image_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES users(id)
  )`);

  // 图片分享配置表
  db.run(`CREATE TABLE IF NOT EXISTS image_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT UNIQUE NOT NULL,
    config_value TEXT
  )`);

  // 图片评论表
  db.run(`CREATE TABLE IF NOT EXISTS image_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // 图片收藏表
  db.run(`CREATE TABLE IF NOT EXISTS image_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_image_favorites_unique ON image_favorites(user_id, image_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_image_favorites_user ON image_favorites(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_image_favorites_image ON image_favorites(image_id)');

  // 图片标签表
  db.run(`CREATE TABLE IF NOT EXISTS image_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 图片-标签关联表
  db.run(`CREATE TABLE IF NOT EXISTS image_tag_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES image_tags(id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_image_tag_unique ON image_tag_relations(image_id, tag_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_image_tag_tag ON image_tag_relations(tag_id)');

  // 图片分享链接表（source_type: image=图片分享 / ai_image=AI生图；options 存嵌入开关等扩展配置）
  db.run(`CREATE TABLE IF NOT EXISTS image_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL,
    view_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    options TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_image_shares_source ON image_shares(source_type, source_id)');

  // ============ 站内信表 ============
  db.run(`CREATE TABLE IF NOT EXISTS internal_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER,
    from_username TEXT DEFAULT '系统',
    to_user_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    is_popup INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ============ 用户关注表 ============
  db.run(`CREATE TABLE IF NOT EXISTS user_follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follows_unique ON user_follows(follower_id, following_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id)');

  // ============ 通知表 ============
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    from_user_id INTEGER,
    target_type TEXT,
    target_id TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)');

  // ============ 点赞/感谢表 ============
  db.run(`CREATE TABLE IF NOT EXISTS content_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    like_type TEXT DEFAULT 'like',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_content_likes_unique ON content_likes(user_id, target_type, target_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_content_likes_target ON content_likes(target_type, target_id)');

  // ============ 社区动态表 ============

  // 用户动态表
  db.run(`CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    status TEXT DEFAULT 'published',
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_community_posts_user ON community_posts(user_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_community_posts_status ON community_posts(status, created_at DESC)');

  // 动态评论表
  db.run(`CREATE TABLE IF NOT EXISTS community_post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'approved',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_post_comments_post ON community_post_comments(post_id, created_at DESC)');

  // ============ 用户私信系统表 ============

  // 对话表
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_conv_user1 ON conversations(user1_id, last_message_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_conv_user2 ON conversations(user2_id, last_message_at DESC)');

  // 私信表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_pm_conv ON private_messages(conversation_id, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pm_unread ON private_messages(conversation_id, is_read)');

  // 私信权限设置表
  db.run(`CREATE TABLE IF NOT EXISTS user_message_settings (
    user_id INTEGER PRIMARY KEY,
    allow_from TEXT DEFAULT 'all',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ============ 项目管理表 ============
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    tables TEXT NOT NULL,
    file_dirs TEXT,
    icon TEXT,
    github_url TEXT DEFAULT '',
    deploy_status TEXT DEFAULT 'none',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ============ AI 聊天模块表 ============

  // AI 会话表
  // 角色/分支/记忆/RAG 开关、生成参数（SillyTavern 风格，per-conversation 覆盖模型默认值）、
  // 群聊（Group Chats：is_group + group_members + group_mode）
  db.run(`CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT DEFAULT 'deepseek-chat',
    system_prompt TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    role_id INTEGER,
    current_branch_id INTEGER DEFAULT 0,
    memory_enabled INTEGER DEFAULT 1,
    memory_mode TEXT DEFAULT 'summary',
    rag_enabled INTEGER DEFAULT 1,
    gen_temperature REAL,
    gen_top_p REAL,
    gen_top_k INTEGER,
    gen_frequency_penalty REAL,
    gen_presence_penalty REAL,
    gen_max_tokens INTEGER,
    author_note TEXT DEFAULT '',
    author_note_depth INTEGER DEFAULT 4,
    prompt_template_id INTEGER,
    is_group INTEGER DEFAULT 0,
    group_members TEXT DEFAULT '',
    group_mode TEXT DEFAULT 'round',
    book_imported INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // AI 消息表
  // 分支/状态/错误信息、消息滑动（alternate_of + is_active）、场景图片消息（is_image + image_url）、
  // 群聊说话人归属（speaker_role_id）、精确 token 统计（input_tokens / output_tokens）、
  // 推理过程（reasoning）与生成参数快照（gen_info，swipe_info 语义）
  db.run(`CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    model TEXT,
    is_streaming INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    quoted_message_id INTEGER,
    branch_id INTEGER DEFAULT 0,
    status TEXT DEFAULT 'done',
    error TEXT DEFAULT '',
    alternate_of INTEGER,
    is_active INTEGER DEFAULT 1,
    speaker_role_id INTEGER,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    is_image INTEGER DEFAULT 0,
    image_url TEXT DEFAULT '',
    reasoning TEXT DEFAULT '',
    gen_info TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);

  // AI 世界书（World Book）：按触发词注入上下文的设定条目
  // 增强项（SillyTavern 式）：二级触发词 secondary_keys / 选择性触发 selective /
  // 概率触发 probability / 深度注入 depth
  db.run(`CREATE TABLE IF NOT EXISTS ai_world_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    position TEXT DEFAULT 'before_char',
    sort_order INTEGER DEFAULT 0,
    constant INTEGER DEFAULT 0,
    secondary_keys TEXT DEFAULT '',
    selective INTEGER DEFAULT 0,
    probability INTEGER DEFAULT 100,
    depth INTEGER DEFAULT 4,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);

  // AI 默认世界书（全局模板）：新会话创建时自动复制进会话世界书，后台可管理
  db.run(`CREATE TABLE IF NOT EXISTS ai_default_world_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    position TEXT DEFAULT 'before_char',
    sort_order INTEGER DEFAULT 0,
    constant INTEGER DEFAULT 0,
    secondary_keys TEXT DEFAULT '',
    selective INTEGER DEFAULT 0,
    probability INTEGER DEFAULT 100,
    depth INTEGER DEFAULT 4,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // AI 正则后处理脚本（SillyTavern Regex / RP-Hub 正则管线 式）：
  // placement=prompt（发送前替换 messages）/ display（渲染前替换正文）/ both；
  // min_depth/max_depth 按距最后一条消息的深度限定作用范围（NULL=不限）。
  db.run(`CREATE TABLE IF NOT EXISTS ai_regex_scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    find_regex TEXT NOT NULL DEFAULT '',
    replace_string TEXT NOT NULL DEFAULT '',
    flags TEXT NOT NULL DEFAULT 'g',
    placement TEXT NOT NULL DEFAULT 'display',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    min_depth INTEGER,
    max_depth INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // AI 记忆（摘要记忆 + 向量记忆）
  // 记忆系统 v2：逐轮总结（round_index / user_input / status）、逐轮向量（emb_model）、
  // 二次压缩分组（group_start / group_end）
  db.run(`CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'summary',
    content TEXT NOT NULL,
    embedding TEXT,
    source_start_msg INTEGER,
    source_end_msg INTEGER,
    round_index INTEGER,
    user_input TEXT DEFAULT '',
    status TEXT DEFAULT 'done',
    emb_model TEXT DEFAULT '',
    group_start INTEGER,
    group_end INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);

  // AI 剧情分支
  db.run(`CREATE TABLE IF NOT EXISTS ai_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    name TEXT DEFAULT '新分支',
    parent_message_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);

  // AI 聊天模型提供商预设（内置，前台选提供商自动带出端点/默认模型，镜像 ai_image_providers）
  db.run(`CREATE TABLE IF NOT EXISTS ai_chat_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    api_base TEXT DEFAULT '',
    default_model TEXT DEFAULT '',
    models TEXT DEFAULT '[]',
    api_key_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ============ 第三方登录模块表 ============

  // 第三方登录配置表
  db.run(`CREATE TABLE IF NOT EXISTS oauth_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    client_id TEXT,
    client_secret TEXT,
    redirect_uri TEXT,
    icon TEXT DEFAULT '',
    color TEXT DEFAULT '#000000',
    is_enabled INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 第三方登录绑定表
  db.run(`CREATE TABLE IF NOT EXISTS user_oauth_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    open_id TEXT NOT NULL,
    union_id TEXT DEFAULT '',
    access_token TEXT DEFAULT '',
    refresh_token TEXT DEFAULT '',
    nickname TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(provider, open_id)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_user_oauth_user ON user_oauth_bindings(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_oauth_provider ON user_oauth_bindings(provider, open_id)');

  // AI 角色预设表（角色卡，完整兼容 Character Card V2/V3 与 SillyTavern 字段）
  // 卡面字段：description / personality / scenario / greeting(first_mes) / examples(mes_example) /
  //           system_prompt / post_history_instructions / alternate_greetings / creator_notes /
  //           creator / character_version / tags
  // 世界书：world_book 存归一化后的 character_book JSON（{name, description, entries[]}），
  //         用该角色新建会话时由前端弹窗勾选后注入 ai_world_book（book_imported 防重复弹窗）
  // 溯源与分享：source_type 四值（self 本站表单创建 / external 外部文件或 URL 导入 /
  //           hub 从站内广场导入他人卡 / official 官方种子卡）+ source_role_id(站内来源卡)
  //           + source_url(外部来源) + license(版权标注)；is_shared / share_token 控制是否
  //           公开到角色卡广场，import_count / view_count 为广场统计；
  //           self/external 可分享可导出；hub 仅可自己使用：不可再次分享、不可导出（防内容外溢）；
  //           official 全站可用、由后台治理、不可分享（见 services/ai-chat/characters.js 的
  //           SOURCE_TYPES / NO_EXPORT_SOURCE / canExportCard / canShareCard）
  db.run(`CREATE TABLE IF NOT EXISTS ai_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    description TEXT DEFAULT '',
    system_prompt TEXT NOT NULL,
    greeting TEXT DEFAULT '',
    personality TEXT DEFAULT '',
    scenario TEXT DEFAULT '',
    examples TEXT DEFAULT '',
    category TEXT DEFAULT 'default',
    is_official INTEGER DEFAULT 0,
    user_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    post_history_instructions TEXT DEFAULT '',
    alternate_greetings TEXT DEFAULT '[]',
    creator_notes TEXT DEFAULT '',
    creator TEXT DEFAULT '',
    character_version TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    world_book TEXT DEFAULT '',
    extensions TEXT DEFAULT '{}',
    source_type TEXT DEFAULT 'self',
    source_role_id INTEGER,
    source_url TEXT DEFAULT '',
    license TEXT DEFAULT '',
    is_shared INTEGER DEFAULT 0,
    share_token TEXT DEFAULT '',
    shared_at DATETIME,
    import_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // 角色卡屏蔽表（管理员治理：被屏蔽的卡在广场仅上传者本人可见）
  // 独立成表而非给 ai_roles 加列：遵守「只 CREATE TABLE、不做 ALTER 迁移」约定，存量库下次启动自动建表
  db.run(`CREATE TABLE IF NOT EXISTS ai_role_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL UNIQUE,
    reason TEXT DEFAULT '',
    blocked_by INTEGER,
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES ai_roles(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // AI 用户配额表
  db.run(`CREATE TABLE IF NOT EXISTS ai_quota (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    daily_limit INTEGER DEFAULT 50,
    daily_used INTEGER DEFAULT 0,
    total_limit INTEGER DEFAULT 1000,
    total_used INTEGER DEFAULT 0,
    last_reset_date TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // AI 模型配置表
  db.run(`CREATE TABLE IF NOT EXISTS ai_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    model_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_endpoint TEXT,
    api_key TEXT,
    is_enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    user_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    max_tokens INTEGER DEFAULT 4096,
    temperature REAL DEFAULT 0.7,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // AI 系统设置表
  db.run(`CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT
  )`);

  // 插入默认 AI 系统设置
  const defaultAiSettings = [
    ['ai_enabled', '1'],
    ['ai_default_model', ''],
    ['ai_allow_user_models', '1'],
    ['ai_default_daily_limit', '50'],
    ['ai_default_total_limit', '1000'],
    ['ai_rag_enabled', '0'],
    ['ai_rag_max_results', '5'],
    ['ai_rag_min_score', '0.5'],
    ['ai_memory_enabled', '1'],
    ['ai_memory_mode', 'summary'],
    ['ai_memory_interval', '10'],
    ['ai_memory_keep_recent', '10'],
    ['ai_memory_recall_min_score', '0.48'],
    ['ai_memory_recall_max', '10'],
    ['ai_memory_group_recent', '25'],
    ['ai_memory_group_size', '5'],
    ['ai_embedding_api_base', ''],
    ['ai_embedding_model', ''],
    ['ai_embedding_api_key', ''],
    ['ai_stream_enabled', '1'],
    // 世界书增强（SillyTavern 式）：递归扫描 / token 预算 / 扫描深度
    ['ai_world_recursion', '1'],
    ['ai_world_recursion_steps', '4'],
    ['ai_world_budget_percent', '25'],
    ['ai_world_scan_depth', '6'],
    // 世界书自动识别（扫描期叠加，不改用户原始条目）：总开关 / 自动二级键 / 自动常驻
    ['ai_world_auto_enhance', '1'],
    ['ai_world_auto_secondary', '1'],
    ['ai_world_auto_constant', '1'],
    // 上下文与生成：总上下文预算（token）、历史窗口、抗截断自动续写
    ['ai_context_size', '16000'],
    ['ai_history_window', '3000'],
    ['ai_auto_continue', '1'],
    ['ai_auto_continue_max', '3'],
    ['ai_reasoning_enabled', '1'],
    // 预测建议回复（用户可能发送的下一条消息）
    ['ai_predict_enabled', '1'],
    ['ai_predict_count', '3']
  ];
  for (const [key, value] of defaultAiSettings) {
    db.run('INSERT OR IGNORE INTO ai_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  }

  // ============ AI 知识库（RAG）表 ============

  // 知识库文档表
  db.run(`CREATE TABLE IF NOT EXISTS ai_knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT DEFAULT 'manual',
    source_id TEXT DEFAULT '',
    chunk_count INTEGER DEFAULT 0,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // 知识库文档分块表
  db.run(`CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id) REFERENCES ai_knowledge_docs(id) ON DELETE CASCADE
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_ai_knowledge_docs_source ON ai_knowledge_docs(source_type, source_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ai_knowledge_docs_created ON ai_knowledge_docs(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_doc ON ai_knowledge_chunks(doc_id, chunk_index)');

  // AI 生成参数预设（用户/全局，SillyTavern 风格）
  db.run(`CREATE TABLE IF NOT EXISTS ai_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    temperature REAL DEFAULT 0.7,
    top_p REAL DEFAULT 1.0,
    top_k INTEGER DEFAULT 0,
    frequency_penalty REAL DEFAULT 0,
    presence_penalty REAL DEFAULT 0,
    max_tokens INTEGER DEFAULT 4096,
    is_default INTEGER DEFAULT 0,
    is_global INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // AI 提示词模板（管理员定义 + 用户自定义，支持变量替换）
  db.run(`CREATE TABLE IF NOT EXISTS ai_prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_global INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ============ AI 提示词模块表 ============
  // 板块表（一级）
  db.run(`CREATE TABLE IF NOT EXISTS prompt_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '',
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 分类表（二级，挂在板块下）
  db.run(`CREATE TABLE IF NOT EXISTS prompt_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (section_id) REFERENCES prompt_sections(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_prompt_categories_section ON prompt_categories(section_id)');

  // 提示词表（三级）
  db.run(`CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES prompt_categories(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category_id)');

  // 提示词评论表
  db.run(`CREATE TABLE IF NOT EXISTS prompt_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_prompt_comments_prompt ON prompt_comments(prompt_id)');

  // ============ 文章附件表 ============
  db.run(`CREATE TABLE IF NOT EXISTS article_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER,
    original_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_article_attachments_article ON article_attachments(article_id)');

  // ============ API Token 表（原生 App 鉴权） ============
  db.run(`CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    expires_at DATETIME,
    last_used_at DATETIME,
    token_version INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)');

  // ============ API 访问日志表（原生 App / 客户端访问记录） ============
  db.run(`CREATE TABLE IF NOT EXISTS api_access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT DEFAULT '',
    method TEXT DEFAULT 'GET',
    path TEXT DEFAULT '',
    status INTEGER DEFAULT 0,
    ip TEXT DEFAULT '',
    client TEXT DEFAULT 'app',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_access_logs(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_logs_user ON api_access_logs(user_id)');

  // ============ AI 图片生成模块表 ============
  // AI 生图服务商配置表（Key 密文存储）
  db.run(`CREATE TABLE IF NOT EXISTS ai_image_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    api_key_enc TEXT DEFAULT '',
    api_base TEXT DEFAULT '',
    api_path TEXT DEFAULT '',
    default_model TEXT DEFAULT '',
    models TEXT DEFAULT '[]',
    api_key_url TEXT DEFAULT '',
    supports_negative INTEGER DEFAULT 0,
    supports_n INTEGER DEFAULT 1,
    supports_img2img INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_aiprovider_key ON ai_image_providers(provider_key)');

  // AI 生图生成记录表
  db.run(`CREATE TABLE IF NOT EXISTS ai_image_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT DEFAULT '',
    size TEXT DEFAULT '',
    seed INTEGER DEFAULT 0,
    style TEXT DEFAULT '',
    reference_image TEXT DEFAULT '',
    status TEXT DEFAULT 'success',
    image_path TEXT DEFAULT '',
    error TEXT DEFAULT '',
    shared INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_aiimg_records_user ON ai_image_records(user_id, created_at DESC)');

  // 用户自填的 AI 生图服务商 Key（加密存储；用户 Key 优先于后台全局 Key）
  db.run(`CREATE TABLE IF NOT EXISTS ai_image_user_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider_key TEXT NOT NULL,
    api_key_enc TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_id, provider_key)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_aiimg_user_keys_user ON ai_image_user_keys(user_id)');

  // ============ 在线表格模块表（Univer 重构版） ============
  // 表格元数据表
  // doc_* 为新版 Univer 文档列；luckysheet_* 为旧版遗留列（仅作历史数据导入源，新数据不写入）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    page_size INTEGER DEFAULT 20,
    luckysheet_data TEXT,
    is_luckysheet INTEGER DEFAULT 0,
    is_locked INTEGER DEFAULT 0,
    locked_by INTEGER,
    doc_data TEXT,
    doc_version INTEGER DEFAULT 0,
    is_public_read INTEGER DEFAULT 0,
    doc_type TEXT DEFAULT 'spreadsheet',
    doc_file TEXT DEFAULT '',
    doc_template TEXT DEFAULT 'blank',
    slide_count INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_spreadsheets_status ON spreadsheets(status)');

  // 版本历史表（历史版本记录与恢复）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    doc_data TEXT,
    change_desc TEXT DEFAULT '',
    sheet_count INTEGER DEFAULT 1,
    size_bytes INTEGER DEFAULT 0,
    user_id INTEGER,
    username TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE,
    UNIQUE(spreadsheet_id, version)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_versions ON spreadsheet_versions(spreadsheet_id, version)');

  // 批注表（单元格锚定评论、@提及、回复、任务指派）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    sheet_id TEXT NOT NULL DEFAULT '',
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    parent_id INTEGER,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    mentions TEXT DEFAULT '[]',
    assigned_to INTEGER,
    task_status TEXT DEFAULT 'none',
    resolved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_comments ON spreadsheet_comments(spreadsheet_id, resolved, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_comments_assign ON spreadsheet_comments(assigned_to, task_status)');

  // 图表配置表（自建 ECharts 图表层：柱状/折线/饼/散点/面积等）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_charts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    sheet_id TEXT NOT NULL DEFAULT '',
    name TEXT DEFAULT '',
    chart_type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    anchor TEXT DEFAULT '{}',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_charts ON spreadsheet_charts(spreadsheet_id)');

  // 旧结构化数据表（历史遗留：新版不写入，仅保留表结构以兼容旧读取代码）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    field_key TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    width INTEGER DEFAULT 150,
    sort_order INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    options TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_columns_sheet ON spreadsheet_columns(spreadsheet_id, sort_order)');

  // 表格行数据表（row_data 为 JSON 字符串，key=field_key, value=单元格值）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    row_data TEXT DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_rows_sheet ON spreadsheet_rows(spreadsheet_id, sort_order)');

  // 文档级用户权限表（每个表格独立权限）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    perm_type TEXT NOT NULL DEFAULT 'view',
    granted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(spreadsheet_id, user_id, perm_type)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_perm_sheet ON spreadsheet_user_permissions(spreadsheet_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_perm_user ON spreadsheet_user_permissions(user_id)');

  // 文档权限申请表
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_permission_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    perm_type TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    handled_by INTEGER,
    handled_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_app_sheet ON spreadsheet_permission_applications(spreadsheet_id, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_app_user ON spreadsheet_permission_applications(user_id, status)');

  // 单元格编辑历史表（实时协同 + 历史追溯）
  db.run(`CREATE TABLE IF NOT EXISTS spreadsheet_cell_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spreadsheet_id INTEGER NOT NULL,
    sheet_index INTEGER NOT NULL DEFAULT 0,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_edits_sheet_cell ON spreadsheet_cell_edits(spreadsheet_id, sheet_index, row, col, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ss_edits_sheet_time ON spreadsheet_cell_edits(spreadsheet_id, id)');

  // 音乐播放曲目表（后台上传 / 外链；public/music 目录文件为运行时扫描，不入库）
  db.run(`CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    src TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'url',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

module.exports = { createTables };
