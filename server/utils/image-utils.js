/**
 * 图片分享工具函数
 */
const { queryAll, saveDatabase } = require('../config/database');
const { getImageConfigs } = require('./settings');

/**
 * 记录图片分享操作日志
 * @param {Object} db - 数据库实例
 * @param {number} adminId - 管理员ID
 * @param {string} content - 日志内容
 */
function addImageLog(db, adminId, content) {
  db.run('INSERT INTO image_logs (admin_id, content) VALUES (?, ?)', [adminId, content]);
}

module.exports = {
  getImageConfigs,
  addImageLog
};
