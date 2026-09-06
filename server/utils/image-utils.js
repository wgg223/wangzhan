/**
 * 图片分享工具函数
 * 作用：图片分享模块的公共小工具，目前提供操作日志记录能力，
 *       供图片分享相关路由复用，避免重复写 SQL。
 */

/**
 * 记录图片分享操作日志
 * @param {Object} db - 数据库实例
 * @param {number} adminId - 管理员ID（操作人）
 * @param {string} content - 日志内容（描述做了什么操作）
 * 说明：向 image_logs 表插入一条记录；不捕获异常，失败会抛给调用方处理。
 */
function addImageLog(db, adminId, content) {
  db.run('INSERT INTO image_logs (admin_id, content) VALUES (?, ?)', [adminId, content]);
}

module.exports = {
  addImageLog
};
