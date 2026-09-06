/**
 * 数据库表结构定义（DDL 与迁移）
 * 作用：集中定义全站 40+ 张业务表的 CREATE TABLE IF NOT EXISTS，
 *       以及存量数据库的 ALTER TABLE 增量迁移。
 * 说明：
 *   - 每个表创建前都有对应的注释（见下方各表段）；
 *   - 迁移语句单独执行并捕获 "duplicate column name" 异常（列已存在的正常噪音），
 *     其余错误打印日志后继续，保证旧库可平滑升级到新结构；
 *   - app_setup 表必须第一个创建，因为数据库初始化流程依赖它记录安装状态。
 */

const { queryAll } = require('./db-helpers');

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 用户表字段迁移
  const userMigrations = [
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN totp_secret TEXT',
    'ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN reset_token TEXT',
    'ALTER TABLE users ADD COLUMN reset_token_expires DATETIME',
    'ALTER TABLE users ADD COLUMN nickname TEXT',
    "ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '/assets/images/default-avatar.png'",
    "ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN image_no_review INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN delete_token TEXT',
    'ALTER TABLE users ADD COLUMN delete_token_expires DATETIME',
    'ALTER TABLE users ADD COLUMN deactivated_at DATETIME',
    "ALTER TABLE users ADD COLUMN uid TEXT DEFAULT ''"
  ];
  userMigrations.forEach(sql => {
    try { db.run(sql); } catch (e) {
      if (!e.message || !e.message.includes('duplicate column name')) {
        console.error('[DB迁移] 执行失败:', sql, '错误:', e.message);
      }
    }
  });

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
  try { db.run("ALTER TABLE pages ADD COLUMN font_color TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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
  try { db.run("ALTER TABLE articles ADD COLUMN location TEXT DEFAULT 'home'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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
  db.run(`CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    perm_key TEXT UNIQUE NOT NULL,
    perm_name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 创建用户权限关联表
  db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    perm_key TEXT NOT NULL,
    granted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
  )`);

  // 创建权限申请表
  db.run(`CREATE TABLE IF NOT EXISTS permission_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    perm_key TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id)
  )`);
  try { db.run("ALTER TABLE permission_applications ADD COLUMN reject_reason TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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
  try { db.run("ALTER TABLE activity_logs ADD COLUMN route TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE activity_logs ADD COLUMN method TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cate_id) REFERENCES image_categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  try { db.run('ALTER TABLE images ADD COLUMN download_count INTEGER DEFAULT 0'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT 'public'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE images ADD COLUMN allowed_user_ids TEXT DEFAULT '[]'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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

  // 图片分享链接表（source_type: image=图片分享 / ai_image=AI生图）
  db.run(`CREATE TABLE IF NOT EXISTS image_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL,
    view_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
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
  try { db.run("ALTER TABLE projects ADD COLUMN github_url TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE projects ADD COLUMN deploy_status TEXT DEFAULT 'none'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

  // ============ AI 聊天模块表 ============

  // AI 会话表
  db.run(`CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT DEFAULT 'deepseek-chat',
    system_prompt TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // AI 消息表
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);
  try { db.run('ALTER TABLE ai_messages ADD COLUMN is_pinned INTEGER DEFAULT 0'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run('ALTER TABLE ai_messages ADD COLUMN quoted_message_id INTEGER'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  // 分支/状态/错误信息（AI 聊天模块 v1）
  try { db.run('ALTER TABLE ai_messages ADD COLUMN branch_id INTEGER DEFAULT 0'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_messages ADD COLUMN status TEXT DEFAULT 'done'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_messages ADD COLUMN error TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run('ALTER TABLE ai_conversations ADD COLUMN role_id INTEGER'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run('ALTER TABLE ai_conversations ADD COLUMN current_branch_id INTEGER DEFAULT 0'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run('ALTER TABLE ai_conversations ADD COLUMN memory_enabled INTEGER DEFAULT 1'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_conversations ADD COLUMN memory_mode TEXT DEFAULT 'summary'"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run('ALTER TABLE ai_conversations ADD COLUMN rag_enabled INTEGER DEFAULT 1'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

  // AI 世界书（World Book）：按触发词注入上下文的设定条目
  db.run(`CREATE TABLE IF NOT EXISTS ai_world_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    position TEXT DEFAULT 'before_char',
    sort_order INTEGER DEFAULT 0,
    constant INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  )`);
  try { db.run('ALTER TABLE ai_world_book ADD COLUMN constant INTEGER DEFAULT 0'); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

  // AI 默认世界书（全局模板）：新会话创建时自动复制进会话世界书，后台可管理
  db.run(`CREATE TABLE IF NOT EXISTS ai_default_world_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    position TEXT DEFAULT 'before_char',
    sort_order INTEGER DEFAULT 0,
    constant INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // AI 记忆（摘要记忆 + 向量记忆）
  db.run(`CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'summary',
    content TEXT NOT NULL,
    embedding TEXT,
    source_start_msg INTEGER,
    source_end_msg INTEGER,
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

  // 为已有用户生成UID（如果还没有的话）
  try {
    const usersWithoutUid = queryAll(db, "SELECT id FROM users WHERE uid IS NULL OR uid = ''");
    if (usersWithoutUid.length > 0) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      usersWithoutUid.forEach(u => {
        let uid = '';
        for (let i = 0; i < 8; i++) {
          uid += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        db.run('UPDATE users SET uid = ? WHERE id = ?', [uid, u.id]);
      });
    }
  } catch (e) { /* 忽略 */ }

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

  // AI 角色预设表
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // AI 角色卡字段（开场白/性格/场景/示例对话）— 存量库迁移
  try { db.run("ALTER TABLE ai_roles ADD COLUMN greeting TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_roles ADD COLUMN personality TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_roles ADD COLUMN scenario TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }
  try { db.run("ALTER TABLE ai_roles ADD COLUMN examples TEXT DEFAULT ''"); } catch (e) { if (!e.message || !e.message.includes('duplicate column name')) { console.error('[DB迁移] 列添加失败:', e.message); } }

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
    ['ai_embedding_api_base', ''],
    ['ai_embedding_model', ''],
    ['ai_embedding_api_key', ''],
    ['ai_stream_enabled', '1']
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
  // api_tokens 表迁移（存量库补充 token_version 列）
  try { db.run('ALTER TABLE api_tokens ADD COLUMN token_version INTEGER DEFAULT 0'); } catch (e) {
    if (!e.message || !e.message.includes('duplicate column name')) {
      console.error('[DB迁移] 执行失败: api_tokens.token_version', e.message);
    }
  }

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
  // 存量表迁移：补充 api_key_url 列
  try { db.run("ALTER TABLE ai_image_providers ADD COLUMN api_key_url TEXT DEFAULT ''"); } catch (e) {
    if (!e.message || !e.message.includes('duplicate column name')) {
      console.error('[DB迁移] ai_image_providers.api_key_url 添加失败:', e.message);
    }
  }

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

  // 存量 admin 补权迁移：admin 权限改为走 user_permissions 表后，
  // 为已有 admin 用户补齐全量权限记录，避免升级后 admin 丢失后台访问权限。
  try {
    const admins = queryAll(db, "SELECT id FROM users WHERE role = 'admin'");
    admins.forEach(a => {
      const perms = queryAll(db, 'SELECT perm_key FROM permissions');
      perms.forEach(p => db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)', [a.id, p.perm_key, a.id]));
    });
  } catch (e) { /* 新库无表时忽略 */ }
}

module.exports = { createTables };
