/**
 * 数据库索引创建
 */

function createIndexes(db) {
  if (!db) return;

  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_articles_location ON articles(location)');

    db.run('CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pages_sort ON pages(sort_order)');

    db.run('CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at)');

    db.run('CREATE INDEX IF NOT EXISTS idx_novels_status ON novels(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chapters_novel ON novel_chapters(novel_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chapters_number ON novel_chapters(novel_id, chapter_number)');

    db.run('CREATE INDEX IF NOT EXISTS idx_user_perms ON user_permissions(user_id)');

    db.run('CREATE INDEX IF NOT EXISTS idx_media_type ON media(file_type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at)');

    db.run('CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC)');

    db.run('CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(setting_key)');

    db.run('CREATE INDEX IF NOT EXISTS idx_images_cate ON images(cate_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_categories_status ON image_categories(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_logs_admin ON image_logs(admin_id)');

    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_image ON image_comments(image_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_status ON image_comments(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_image_comments_user ON image_comments(user_id)');

    db.run('CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, updated_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id, created_at ASC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_roles_category ON ai_roles(category, sort_order)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_roles_user ON ai_roles(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_models_user ON ai_models(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_ai_models_default ON ai_models(is_default, is_enabled)');

  } catch (err) {
    console.error('创建索引失败:', err.message);
  }
}

module.exports = { createIndexes };
