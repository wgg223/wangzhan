/**
 * 数据库索引创建
 * 作用：应用启动时批量创建各业务表的常用查询索引（CREATE INDEX IF NOT EXISTS，
 *       重复执行安全）。索引按业务模块分组：
 *   - 文章/页面/评论：状态、作者、时间、slug 等高频筛选字段；
 *   - 小说/章节：连载状态与章节顺序；
 *   - 权限/媒体/活动日志：外键与时间线查询；
 *   - 图片分享：分类、用户、状态、url 反查（上传保护中间件依赖）；
 *   - AI 聊天：会话、消息、角色、模型、世界书/记忆/分支；
 *   - OAuth、用户、通知、私信：外键与状态查询。
 * 全部索引用 IF NOT EXISTS 包裹，存量库与增量库均可安全执行。
 */

function createIndexes(db) {
  if (!db) return;

  try {
    // ===== 文章表：状态筛选、作者、时间线、位置 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_location ON articles(location)');

    // ===== 页面表：slug 路由、发布状态、父子层级、排序 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_sort ON pages(sort_order)');

    // ===== 评论表：按文章/用户/状态/时间查询 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at)');

    // ===== 小说/章节：连载状态、章节归属与顺序 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_novels_status ON novels(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chapters_novel ON novel_chapters(novel_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chapters_number ON novel_chapters(novel_id, chapter_number)');

    // ===== 用户权限：查用户权限 + 唯一约束 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_user_perms ON user_permissions(user_id)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_unique ON user_permissions(user_id, perm_key)');

    // ===== 媒体库：类型与时间 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_media_type ON media(file_type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at)');

    // ===== 活动日志：用户/时间/IP/动作多维查询 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_activity_ip_action ON activity_logs(ip, action, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_activity_user_action ON activity_logs(username, action, created_at)');

    // ===== 设置表：按 key 查询 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(setting_key)');

    // ===== 图片分享：分类/用户/状态/时间 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_images_cate ON images(cate_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_categories_status ON image_categories(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_logs_admin ON image_logs(admin_id)');

    // 上传保护中间件按 url 反查记录（图片直链鉴权必须）
    db.run('CREATE INDEX IF NOT EXISTS idx_images_url ON images(url)');
    db.run('CREATE INDEX IF NOT EXISTS idx_aiimg_records_path ON ai_image_records(image_path)');
    db.run('CREATE INDEX IF NOT EXISTS idx_novels_cover ON novels(cover_image)');

    // ===== 图片评论 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_image ON image_comments(image_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_status ON image_comments(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_user ON image_comments(user_id)');

    // ===== AI 聊天：会话按用户、消息按会话、角色/模型 =====
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, updated_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id, created_at ASC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_roles_category ON ai_roles(category, sort_order)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_roles_user ON ai_roles(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_models_user ON ai_models(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_models_default ON ai_models(is_default, is_enabled)');

    // AI 聊天：世界书 / 记忆 / 分支 / 消息分支索引
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_world_book_conv ON ai_world_book(conversation_id, enabled)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_memories_conv ON ai_memories(conversation_id, type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_branches_conv ON ai_branches(conversation_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_messages_branch ON ai_messages(conversation_id, branch_id, id)');

    // OAuth相关索引
    db.run('CREATE INDEX IF NOT EXISTS idx_oauth_providers_enabled ON oauth_providers(is_enabled)');
    db.run('CREATE INDEX IF NOT EXISTS idx_user_oauth_bindings_user ON user_oauth_bindings(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_user_oauth_bindings_provider ON user_oauth_bindings(provider, open_id)');

    // 用户表索引
    db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    db.run('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
    db.run('CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid)');

    // 通知表索引
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)');

    // 私信相关索引
    db.run('CREATE INDEX IF NOT EXISTS idx_conversations_users ON conversations(user1_id, user2_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_private_messages_read ON private_messages(conversation_id, is_read)');

  } catch (err) {
    console.error('创建索引失败:', err.message);   // 失败不阻断启动（仅影响查询性能）
  }
}

module.exports = { createIndexes };
