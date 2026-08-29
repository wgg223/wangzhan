/**
 * 系统常量定义
 * 从 admin.js 路由中抽离的硬编码常量
 */

// 项目管理硬编码定义（作为 projects 表不存在时的后备）
const PROJECT_DEFINITIONS = {
  blog: {
    id: 'blog',
    name: '博客系统',
    description: '文章、页面、评论',
    tables: ['articles', 'comments', 'pages'],
    file_dirs: ['uploads'],
    icon: '📄'
  },
  novel: {
    id: 'novel',
    name: '小说系统',
    description: '小说和章节管理',
    tables: ['novels', 'novel_chapters'],
    file_dirs: ['uploads/novels'],
    icon: '📚'
  },
  image: {
    id: 'image',
    name: '图片分享',
    description: '图片、分类、评论',
    tables: ['images', 'image_categories', 'image_comments', 'image_logs', 'image_configs'],
    file_dirs: ['uploads/images'],
    icon: '🖼️'
  },
  poem: {
    id: 'poem',
    name: '诗词游戏',
    description: '排行榜数据',
    tables: ['poem_leaderboard'],
    file_dirs: [],
    icon: '🎮'
  },
  ai_chat: {
    id: 'ai_chat',
    name: 'AI 聊天',
    description: 'AI 对话、角色预设、模型配置',
    tables: ['ai_conversations', 'ai_messages', 'ai_roles', 'ai_quota', 'ai_models', 'ai_settings',
      'ai_world_book', 'ai_memories', 'ai_branches', 'ai_chat_providers'],
    file_dirs: [],
    icon: '🤖'
  },
  'ai-prompts': {
    id: 'ai-prompts',
    name: 'AI提示词库',
    description: '板块、分类、提示词、评论',
    tables: ['prompt_sections', 'prompt_categories', 'prompts', 'prompt_comments'],
    file_dirs: [],
    icon: '🤖'
  },
  'ai-image': {
    id: 'ai-image',
    name: 'AI生图',
    description: '生成记录、用户自填 Key（服务商配置不随重置清除）',
    tables: ['ai_image_records', 'ai_image_user_keys'],
    file_dirs: ['uploads/ai-images'],
    icon: '🎨'
  }
};

// 需要按依赖顺序先删除的子表
const DEPENDENT_TABLES = ['image_comments', 'image_logs', 'novel_chapters', 'comments', 'media_comments',
  'prompt_categories', 'prompts', 'prompt_comments', 'ai_image_records', 'ai_image_user_keys'];

// 所有业务数据表（用于全局重置）
const ALL_TABLES = [
  // 博客系统
  'articles', 'article_drafts', 'pages',
  // 评论
  'comments', 'media_comments',
  // 小说
  'novels', 'novel_chapters',
  // 媒体
  'media',
  // 标签
  'tags', 'content_tags',
  // 内容版本
  'content_versions',
  // 图片分享
  'images', 'image_categories', 'image_comments', 'image_configs', 'image_favorites',
  'image_logs', 'image_tags', 'image_tag_relations',
  // 诗词游戏
  'poem_leaderboard',
  // 站内信
  'internal_messages',
  // 用户关注
  'user_follows',
  // 通知
  'notifications',
  // 点赞
  'content_likes',
  // AI 聊天
  'ai_conversations', 'ai_messages', 'ai_roles', 'ai_quota', 'ai_models', 'ai_settings',
  'ai_world_book', 'ai_memories', 'ai_branches', 'ai_chat_providers',
  // AI 知识库
  'ai_knowledge_docs', 'ai_knowledge_chunks',
  // AI 提示词库
  'prompt_sections', 'prompt_categories', 'prompts', 'prompt_comments',
  // AI 生图
  'ai_image_providers', 'ai_image_records', 'ai_image_user_keys',
  // 活动日志
  'activity_logs',
  // 用户权限
  'user_permissions'
];

module.exports = {
  PROJECT_DEFINITIONS,
  DEPENDENT_TABLES,
  ALL_TABLES
};
