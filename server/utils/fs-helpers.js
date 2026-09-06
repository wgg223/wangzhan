/**
 * 文件系统辅助工具函数
 * 作用：提供目录大小统计、目录复制、目录删除等批量操作，
 *       其中大目录复制/删除使用系统原生命令（robocopy / rm -rf）以提升性能，
 *       并在 Windows / Linux 之间做跨平台适配。
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');   // 子进程模块，用于调用系统命令

const isWindows = process.platform === 'win32';  // 当前是否 Windows 平台

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
 * 递归删除目录（跨平台，调用系统命令实现）
 * @param {string} dirPath - 待删除目录
 * @returns {Promise<void>} 无论成败都 resolve（不抛出）
 * 注意：调用方需自行保证 dirPath 可信（来自服务端配置而非用户输入），
 *       避免命令注入风险。
 */
function removeDir(dirPath) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`rd /s /q "${dirPath}"`, () => resolve());   // Windows 静默递归删除
    } else {
      exec(`rm -rf "${dirPath}"`, () => resolve());     // Linux 强制递归删除
    }
  });
}

/**
 * 跨平台目录复制（使用系统命令，适用于大目录/备份场景）
 * @param {string} src - 源目录
 * @param {string} dest - 目标目录
 * @returns {Promise<boolean>} true=复制成功，false=失败
 * Windows 用 robocopy（返回码 0-7 均视为成功，>7 为错误）；
 * Linux 用 cp -r 且以 "src/." 形式复制内容，避免目标已存在时嵌套成 dest/src。
 */
function copyDirCrossPlatform(src, dest) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /nc /ns /np`, (error) => {
        resolve(error && error.code > 7 ? false : true); // robocopy 0-7 均为成功码
      });
    } else {
      // 注意：必须用 "src/." "dest/" 形式复制目录内容，否则 dest 已存在时会嵌套成 dest/src
      exec(`cp -r "${src}/." "${dest}/"`, (error) => {
        resolve(!error);
      });
    }
  });
}

module.exports = { getDirSize, copyDir, removeDir, copyDirCrossPlatform };
