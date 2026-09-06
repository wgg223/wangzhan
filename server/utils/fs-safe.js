/**
 * 文件系统安全操作工具
 * 作用：封装文件删除操作，捕获所有异常并返回布尔结果，
 *       避免"删除不存在的文件/无权限删除"等异常向上抛出导致请求 500。
 * 提供同步（safeUnlinkSync）与异步（safeUnlink）两个版本。
 */

const fs = require('fs');        // Node.js 文件系统模块
const logger = require('./logger'); // 项目自定义日志模块

/**
 * 同步安全删除文件
 * @param {string} filePath - 要删除的文件绝对路径
 * @returns {boolean} true=删除成功（或文件本就不存在），false=删除出错
 * 说明：先判断文件是否存在，存在才删除；任何异常都被捕获并记录日志。
 */
function safeUnlinkSync(filePath) {
  try {
    if (fs.existsSync(filePath)) {   // 文件存在才执行删除
      fs.unlinkSync(filePath);       // 同步删除文件
      return true;
    }
    return false;                    // 文件不存在，视为"无需删除"，返回 false
  } catch (err) {
    logger.error('safeUnlinkSync failed:', filePath, err && err.message ? err.message : err);
    return false;                    // 删除失败不抛异常，返回 false
  }
}

/**
 * 异步安全删除文件（Promise 风格）
 * @param {string} filePath - 要删除的文件绝对路径
 * @returns {Promise<boolean>} 始终 resolve，不会 reject；true=成功，false=失败
 * 说明：适合在异步流程中 await 使用，错误通过返回值而非异常传递。
 */
async function safeUnlink(filePath) {
  return new Promise((resolve) => {
    fs.unlink(filePath, (err) => {   // 异步删除，回调接收错误
      if (err) {
        logger.error('safeUnlink failed:', filePath, err && err.message ? err.message : err);
        return resolve(false);       // 失败：记录日志并返回 false
      }
      resolve(true);                 // 成功：返回 true
    });
  });
}

// 导出两个安全删除函数供全局使用
module.exports = { safeUnlinkSync, safeUnlink };
