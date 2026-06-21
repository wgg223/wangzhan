/**
 * 数据库表结构定义
 * 所有 CREATE TABLE 和 ALTER TABLE 迁移
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
    reset_token TEXT,
    reset_token_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 用户表字段迁移
  const userMigrations = [
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0',
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
  userMigrations.forEach(sql => { try { db.run(sql); } catch (e) { /* 列已存在 */ } });

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
  try { db.run("ALTER TABLE pages ADD COLUMN font_color TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }

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
  try { db.run("ALTER TABLE articles ADD COLUMN location TEXT DEFAULT 'home'"); } catch (e) { /* 列已存在 */ }

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
  try { db.run("ALTER TABLE permission_applications ADD COLUMN reject_reason TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }

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
  try { db.run("ALTER TABLE activity_logs ADD COLUMN route TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE activity_logs ADD COLUMN method TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }

  // 创建诗词游戏排行榜表
  db.run(`CREATE TABLE IF NOT EXISTS poem_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    game_mode TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    category TEXT DEFAULT '全部',
    score INTEGER NOT NULL,
    combo_max INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cate_id) REFERENCES image_categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  try { db.run('ALTER TABLE images ADD COLUMN download_count INTEGER DEFAULT 0'); } catch (e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT 'public'"); } catch (e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE images ADD COLUMN allowed_user_ids TEXT DEFAULT '[]'"); } catch (e) { /* 列已存在 */ }

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
  try { db.run("ALTER TABLE projects ADD COLUMN github_url TEXT DEFAULT ''"); } catch (e) { /* 列已存在 */ }
  try { db.run("ALTER TABLE projects ADD COLUMN deploy_status TEXT DEFAULT 'none'"); } catch (e) { /* 列已存在 */ }

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
  try { db.run('ALTER TABLE ai_messages ADD COLUMN is_pinned INTEGER DEFAULT 0'); } catch (e) { /* 列已存在 */ }
  try { db.run('ALTER TABLE ai_messages ADD COLUMN quoted_message_id INTEGER'); } catch (e) { /* 列已存在 */ }

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

  // AI 角色预设表
  db.run(`CREATE TABLE IF NOT EXISTS ai_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    description TEXT DEFAULT '',
    system_prompt TEXT NOT NULL,
    category TEXT DEFAULT 'default',
    is_official INTEGER DEFAULT 0,
    user_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
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
    ['ai_rag_min_score', '0.5']
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
}

module.exports = { createTables };
