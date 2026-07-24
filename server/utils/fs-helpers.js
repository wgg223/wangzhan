/**
 * 文件系统辅助工具函数
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const isWindows = process.platform === 'win32';

/**
 * 递归计算目录大小
 * @param {string} dirPath
 * @returns {number} 字节数
 */
function getDirSize(dirPath) {
  let size = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        size += getDirSize(itemPath);
      } else {
        size += stat.size;
      }
    }
  } catch (e) { /* ignore */ }
  return size;
}

/**
 * 递归复制目录
 * @param {string} src
 * @param {string} dest
 */
async function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const items = fs.readdirSync(src);
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 递归删除目录（跨平台）
 * @param {string} dirPath
 */
function removeDir(dirPath) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`rd /s /q "${dirPath}"`, () => resolve());
    } else {
      exec(`rm -rf "${dirPath}"`, () => resolve());
    }
  });
}

/**
 * 跨平台目录复制（使用系统命令，适用于大目录）
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<boolean>}
 */
function copyDirCrossPlatform(src, dest) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /nc /ns /np`, (error) => {
        resolve(error && error.code > 7 ? false : true);
      });
    } else {
      exec(`cp -r "${src}" "${dest}"`, (error) => {
        resolve(!error);
      });
    }
  });
}

module.exports = { getDirSize, copyDir, removeDir, copyDirCrossPlatform };
