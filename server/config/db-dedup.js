/**
 * 数据库去重与维护
 * 在每次启动时自动运行，确保数据一致性
 */

const { queryAll, queryOne } = require('./db-helpers');

/**
 * 执行所有去重操作
 */
function deduplicateDatabase(db) {
  if (!db) return;

  const results = {
    user_permissions: 0,
    settings: 0,
    image_configs: 0,
    image_categories: 0,
    permissions: 0,
    projects: 0,
    oauth_providers: 0
  };

  try {
    // 1. 用户权限去重 - 保留最早的记录
    results.user_permissions = deduplicateTable(db, {
      table: 'user_permissions',
      groupBy: ['user_id', 'perm_key'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 2. 设置表去重
    results.settings = deduplicateTable(db, {
      table: 'settings',
      groupBy: ['setting_key'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 3. 图片配置去重
    results.image_configs = deduplicateTable(db, {
      table: 'image_configs',
      groupBy: ['config_key'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 4. 图片分类去重
    results.image_categories = deduplicateTable(db, {
      table: 'image_categories',
      groupBy: ['name'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 5. 权限表去重
    results.permissions = deduplicateTable(db, {
      table: 'permissions',
      groupBy: ['perm_key'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 6. 项目表去重
    results.projects = deduplicateTable(db, {
      table: 'projects',
      groupBy: ['id'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 7. OAuth提供商去重
    results.oauth_providers = deduplicateTable(db, {
      table: 'oauth_providers',
      groupBy: ['provider'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 8. OAuth绑定去重
    deduplicateTable(db, {
      table: 'user_oauth_bindings',
      groupBy: ['provider', 'open_id'],
      keepColumn: 'id',
      keepStrategy: 'min'
    });

    // 9. 清理孤立数据
    cleanOrphanedData(db);

    // 统计总数
    const totalRemoved = Object.values(results).reduce((sum, count) => sum + count, 0);

    if (totalRemoved > 0) {
      console.log(`[去重] 已清理 ${totalRemoved} 条重复数据:`, results);
    }

    return results;
  } catch (err) {
    console.error('[去重] 执行出错:', err.message);
    return results;
  }
}

/**
 * 通用表去重函数
 * @param {Object} db - 数据库实例
 * @param {Object} config - 配置
 * @param {string} config.table - 表名
 * @param {string[]} config.groupBy - 分组字段
 * @param {string} config.keepColumn - 保留记录的依据字段
 * @param {string} config.keepStrategy - 保留策略: 'min'(保留最小) 或 'max'(保留最大)
 * @returns {number} 删除的记录数
 */
function deduplicateTable(db, { table, groupBy, keepColumn, keepStrategy }) {
  try {
    // 检查表是否存在
    const tableExists = queryOne(db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [table]
    );
    if (!tableExists) return 0;

    const groupByStr = groupBy.join(', ');
    const keepFunc = keepStrategy === 'max' ? 'MAX' : 'MIN';

    // 查找重复记录的ID（保留最早的/最新的，删除其他）
    const duplicates = queryAll(db, `
      SELECT ${keepColumn} as keep_id
      FROM ${table}
      WHERE ${keepColumn} NOT IN (
        SELECT ${keepFunc}(${keepColumn})
        FROM ${table}
        GROUP BY ${groupByStr}
      )
    `);

    if (duplicates.length === 0) return 0;

    // 删除重复记录
    const idsToDelete = duplicates.map(d => d.keep_id);

    // 分批删除，避免SQL过长
    const batchSize = 100;
    for (let i = 0; i < idsToDelete.length; i += batchSize) {
      const batch = idsToDelete.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      db.run(`DELETE FROM ${table} WHERE ${keepColumn} IN (${placeholders})`, batch);
    }

    return duplicates.length;
  } catch (err) {
    // 忽略错误，继续处理其他表
    return 0;
  }
}

/**
 * 清理孤立数据
 */
function cleanOrphanedData(db) {
  try {
    // 清理不存在的用户的权限
    db.run(`
      DELETE FROM user_permissions
      WHERE user_id NOT IN (SELECT id FROM users)
    `);

    // 清理不存在的文章的评论
    db.run(`
      DELETE FROM comments
      WHERE article_id NOT IN (SELECT id FROM articles)
    `);

    // 清理不存在的用户的通知
    db.run(`
      DELETE FROM notifications
      WHERE user_id NOT IN (SELECT id FROM users)
    `);

    // 清理不存在的用户的OAuth绑定
    db.run(`
      DELETE FROM user_oauth_bindings
      WHERE user_id NOT IN (SELECT id FROM users)
    `);

    // 清理过期的验证码和令牌（超过7天）
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE reset_token_expires < ?', [sevenDaysAgo]);
    db.run('UPDATE users SET delete_token = NULL, delete_token_expires = NULL WHERE delete_token_expires < ?', [sevenDaysAgo]);

  } catch (err) {
    // 忽略错误
  }
}

/**
 * 确保关键表有唯一约束
 * 在创建索引时调用
 */
function ensureUniqueConstraints(db) {
  if (!db) return;

  try {
    // user_permissions 表的唯一约束
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_unique ON user_permissions(user_id, perm_key)');
  } catch (e) {
    // 如果存在重复数据，先去重再创建约束
    try {
      deduplicateTable(db, {
        table: 'user_permissions',
        groupBy: ['user_id', 'perm_key'],
        keepColumn: 'id',
        keepStrategy: 'min'
      });
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_unique ON user_permissions(user_id, perm_key)');
    } catch (e2) {
      // 忽略
    }
  }

  try {
    // settings 表的唯一约束（已有 UNIQUE 约束，确保索引存在）
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_unique_key ON settings(setting_key)');
  } catch (e) { /* 忽略 */ }

  try {
    // image_configs 表的唯一约束
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_image_configs_unique_key ON image_configs(config_key)');
  } catch (e) { /* 忽略 */ }

  try {
    // oauth_providers 表的唯一约束
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_providers_unique ON oauth_providers(provider)');
  } catch (e) { /* 忽略 */ }

  try {
    // user_oauth_bindings 表的唯一约束
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_oauth_bindings_unique ON user_oauth_bindings(provider, open_id)');
  } catch (e) {
    try {
      deduplicateTable(db, {
        table: 'user_oauth_bindings',
        groupBy: ['provider', 'open_id'],
        keepColumn: 'id',
        keepStrategy: 'min'
      });
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_oauth_bindings_unique ON user_oauth_bindings(provider, open_id)');
    } catch (e2) {
      // 忽略
    }
  }
}

module.exports = {
  deduplicateDatabase,
  ensureUniqueConstraints,
  deduplicateTable,
  cleanOrphanedData
};
