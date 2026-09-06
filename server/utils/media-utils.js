/**
 * 媒体文件工具函数
 * 作用：媒体管理模块的工具集，当前提供"确保文章配图默认分类存在"的能力，
 *       在文章编辑上传配图时调用，保证图片分类表里始终有兜底分类。
 */
const { queryOne, queryAll, saveDatabase } = require('../config/database');

/**
 * 确保媒体默认分类存在于 image_categories 表中
 * @param {Object} db - 数据库实例
 * @returns {number} 分类ID
 * 逻辑：
 *   1. 查询名为"文章配图"的分类，存在则直接返回其 id；
 *   2. 不存在则取当前最大 sort 值 +1 作为新分类排序（无数据时从 99 开始），
 *      插入一条启用状态、非游客可见的分类；
 *   3. 保存数据库并重新查询返回新分类 id（兜底返回 1）。
 */
function ensureMediaDefaultCategory(db) {
  // 先查是否已存在默认分类
  const cat = queryOne(db, 'SELECT id FROM image_categories WHERE name = ?', ['文章配图']);
  if (cat) return cat.id;

  // 计算新分类的排序号：当前最大 sort + 1，空表则用 99
  const maxSort = queryOne(db, 'SELECT MAX(sort) as m FROM image_categories');
  const nextSort = (maxSort && maxSort.m) ? maxSort.m + 1 : 99;

  // 插入默认分类（status=1 启用，is_guest=0 游客不可见）
  db.run('INSERT INTO image_categories (name, sort, status, is_guest) VALUES (?, ?, ?, ?)',
    ['文章配图', nextSort, 1, 0]);
  saveDatabase();   // 持久化数据库（sql.js 内存模式需要手动保存）

  // 重新查询拿回自增 id
  const newCat = queryOne(db, 'SELECT id FROM image_categories WHERE name = ?', ['文章配图']);
  return newCat ? newCat.id : 1;
}

module.exports = {
  ensureMediaDefaultCategory
};
