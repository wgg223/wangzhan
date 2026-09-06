/**
 * 用户级联删除工具
 * 作用：删除用户前清理所有关联数据，避免触发外键约束错误。
 * 背景：数据库开启 foreign_keys=ON 后，指向 users 表且未定义 ON DELETE 行为的外键，
 *       会在执行 DELETE FROM users 时抛出 FOREIGN KEY constraint failed。
 *
 * 覆盖两类依赖：
 *   1. 有外键约束但无 ON DELETE 行为的表（不清理会直接阻塞删除）：
 *      - articles.author_id / media.uploaded_by / novels.uploaded_by → 置 NULL（保留站点内容）
 *      - user_permissions.granted_by / permission_applications.reviewed_by → 置 NULL
 *      - images.user_id（NOT NULL）→ 删除该用户图片
 *        （image_comments / image_favorites / image_tag_relations 通过 image_id 级联清理）
 *      - image_logs.admin_id（NOT NULL）→ 删除
 *   2. 无外键约束但引用 user_id 的孤儿数据（删除后避免残留脏引用）：
 *      - internal_messages / poem_leaderboard / api_access_logs / activity_logs / image_shares
 *
 * 说明：定义 ON DELETE CASCADE / SET NULL 的表（user_permissions.user_id、notifications、
 *       community_*、conversations、private_messages、ai_*、api_tokens 等）由 SQLite 自动处理，
 *       无需在此干预。
 * 注意：本函数须在事务内调用（调用方负责 BEGIN/COMMIT/ROLLBACK）；
 *       返回的 filesToDelete 是用户图片对应的磁盘文件，应在事务提交成功后删除
 *       （文件删除不可回滚，不能放在事务中）。
 */

const path = require('path');
const { queryAll } = require('../config/db-helpers');

const PUBLIC_DIR = require('../config/app-root').publicDir;

/**
 * 将数据库中的相对路径（如 /uploads/xxx）解析为 public 目录内的绝对路径。
 * 防止 file_path 含 ../ 或绝对路径时删除 public 目录之外的文件。
 * @returns {string|null} 越界或非法时返回 null
 */
function safeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const rel = filePath.replace(/^[/\\]+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

/**
 * 清理用户关联数据（事务内调用）
 * @param {Object} db 数据库实例
 * @param {number} userId 用户ID
 * @returns {string[]} 需在事务提交后删除的图片文件绝对路径列表
 */
function cleanupUserDependencies(db, userId) {
  const filesToDelete = [];

  // 1) 可置空的归属字段 → SET NULL（保留站点内容，仅解除归属）
  db.run('UPDATE articles SET author_id = NULL WHERE author_id = ?', [userId]);
  db.run('UPDATE media SET uploaded_by = NULL WHERE uploaded_by = ?', [userId]);
  db.run('UPDATE novels SET uploaded_by = NULL WHERE uploaded_by = ?', [userId]);
  db.run('UPDATE user_permissions SET granted_by = NULL WHERE granted_by = ?', [userId]);
  db.run('UPDATE permission_applications SET reviewed_by = NULL WHERE reviewed_by = ?', [userId]);

  // 2) NOT NULL 外键列 → 删除关联行
  // 图片（user_id NOT NULL）：先收集文件与分享链接，再删记录
  const userImages = queryAll(db, 'SELECT id, url FROM images WHERE user_id = ?', [userId]);
  if (userImages.length) {
    db.run("DELETE FROM image_shares WHERE source_type = 'image' AND source_id IN (SELECT id FROM images WHERE user_id = ?)", [userId]);
    for (const img of userImages) {
      const filePath = safeFilePath(img.url);
      if (filePath) filesToDelete.push(filePath);
    }
    db.run('DELETE FROM images WHERE user_id = ?', [userId]);
  }
  // AI 生图记录级联删除时，顺带清理指向这些记录的分享链接
  db.run("DELETE FROM image_shares WHERE source_type = 'ai_image' AND source_id IN (SELECT id FROM ai_image_records WHERE user_id = ?)", [userId]);
  // 图片操作日志（admin_id NOT NULL）
  db.run('DELETE FROM image_logs WHERE admin_id = ?', [userId]);

  // 3) 无外键约束的孤儿数据（引用已删除用户的残留记录）
  db.run('DELETE FROM internal_messages WHERE from_user_id = ? OR to_user_id = ?', [userId, userId]);
  db.run('DELETE FROM poem_leaderboard WHERE user_id = ?', [userId]);
  db.run('DELETE FROM api_access_logs WHERE user_id = ?', [userId]);
  db.run('DELETE FROM activity_logs WHERE user_id = ?', [userId]);
  db.run('DELETE FROM image_shares WHERE created_by = ?', [userId]);

  return filesToDelete;
}

module.exports = { cleanupUserDependencies, safeFilePath };
