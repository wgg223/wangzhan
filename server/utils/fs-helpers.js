/**
 * 文件系统辅助工具函数
 * 作用：提供目录大小统计、目录复制、目录删除等批量操作，
 *       使用 Node.js 原生 fs API 实现跨平台操作。
 */
const fs = require('fs');
const path = require('path');

/**
 * 递归计算目录大小
 * @param {string} dirPath - 目录路径
 * @returns {number} 目录总字节数
 * 逻辑：遍历目录内所有条目，目录递归累加、文件直接累加文件大小；
 *       读取失败（权限/不存在）时静默忽略该部分，返回已累计的大小。
 */
function getDirSize(dirPath) {
  let size = 0;
  try {
    const items = fs.readdirSync(dirPath);   // 列出目录内所有条目
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stat = fs.statSync(itemPath);    // 获取条目属性（区分文件/目录）
      if (stat.isDirectory()) {
        size += getDirSize(itemPath);        // 子目录：递归统计
      } else {
        size += stat.size;                   // 文件：累加大小
      }
    }
  } catch (e) { /* ignore */ }              // 忽略无法访问的条目
  return size;
}

/**
 * 递归复制目录（纯 Node 实现，适合中小目录）
 * @param {string} src - 源目录
 * @param {string} dest - 目标目录（不存在会自动创建）
 */
async function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true }); // 目标目录不存在则递归创建
  }
  const items = fs.readdirSync(src);
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      await copyDir(srcPath, destPath);      // 目录：递归复制
    } else {
      fs.copyFileSync(srcPath, destPath);    // 文件：直接拷贝
    }
  }
}

/**
 * 递归删除目录
 * @param {string} dirPath - 待删除目录
 * @returns {Promise<void>} 无论成败都 resolve（不抛出）
 */
function removeDir(dirPath) {
  return new Promise((resolve) => {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
    resolve();
  });
}

/**
 * 跨平台目录复制
 * @param {string} src - 源目录
 * @param {string} dest - 目标目录
 * @returns {Promise<boolean>} true=复制成功，false=失败
 */
function copyDirCrossPlatform(src, dest) {
  return new Promise((resolve) => {
    try {
      fs.cpSync(src, dest, { recursive: true });
      resolve(true);
    } catch (e) {
      resolve(false);
    }
  });
}

module.exports = { getDirSize, copyDir, removeDir, copyDirCrossPlatform };
