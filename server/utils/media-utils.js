/**
 * 媒体文件工具函数
 */
const { queryOne, queryAll, saveDatabase } = require('../config/database');

/**
 * 确保媒体默认分类存在于 image_categories 表中
 * @param {Object} db - 数据库实例
 * @returns {number} 分类ID
 */
function ensureMediaDefaultCategory(db) {
  const cat = queryOne(db, 'SELECT id FROM image_categories WHERE name = ?', ['文章配图']);
  if (cat) return cat.id;

  const maxSort = queryOne(db, 'SELECT MAX(sort) as m FROM image_categories');
  const nextSort = (maxSort && maxSort.m) ? maxSort.m + 1 : 99;

  db.run('INSERT INTO image_categories (name, sort, status, is_guest) VALUES (?, ?, ?, ?)',
    ['文章配图', nextSort, 1, 0]);
  saveDatabase();

  const newCat = queryOne(db, 'SELECT id FROM image_categories WHERE name = ?', ['文章配图']);
  return newCat ? newCat.id : 1;
}

module.exports = {
  ensureMediaDefaultCategory
};
