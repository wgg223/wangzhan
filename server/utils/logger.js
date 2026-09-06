/**
 * 日志模块
 * 作用：统一所有日志输出，同时写入控制台和按日期分文件的日志文件。
 * 特性：
 *   - 日志文件按天命名（runtime-YYYYMMDD.log），位于项目 logs/ 目录
 *   - 单文件超过 5MB 自动轮转（原文件改名为 .1，新日志写新文件）
 *   - 全程异步 IO（stat/appendFile/rename 均为异步），不阻塞请求
 *   - debug 级别在生产环境不打印到控制台，但照常写入文件
 */

const fs = require('fs');       // 文件系统模块
const path = require('path');   // 路径处理模块
const util = require('util');   // 工具模块（用于对象序列化）

const isProd = (process.env.NODE_ENV === 'production');            // 是否生产环境
const LOG_DIR = path.join(__dirname, '../../logs');                // 日志目录：项目根/logs
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 单文件 5MB，超出后轮转为 .1

// 模块加载时只检查/创建一次日志目录，避免每次写日志同步 stat
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { /* 忽略 */ }

/**
 * 计算今天的日志文件名
 * @returns {string} logs/runtime-YYYYMMDD.log 的完整路径
 */
function logFilePath() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `runtime-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`);
}

/**
 * 追加一行到日志文件（异步，失败仅控制台报错不抛出）
 * @param {string} file - 目标文件路径
 * @param {string} line - 完整日志行（含时间戳与级别前缀）
 */
function appendToFile(file, line) {
  fs.appendFile(file, line, 'utf8', (err) => {
    if (err) console.error('[logger] 日志写入失败:', err.message);
  });
}

/**
 * 写入一条日志：先异步检查文件大小，超限则先轮转再追加
 * @param {string} level - 日志级别（debug/info/warn/error）
 * @param {string} msg - 日志正文
 */
function writeToFile(level, msg) {
  const file = logFilePath();
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  // 异步检查大小，超出则轮转（全程无同步 IO）
  fs.stat(file, (statErr, stat) => {
    if (!statErr && stat.size > MAX_FILE_SIZE) {
      // 当前文件超过 5MB：改名为 .1 再写新文件
      fs.rename(file, file + '.1', (renameErr) => {
        if (renameErr) console.error('[logger] 日志轮转失败:', renameErr.message);
        appendToFile(file, line);
      });
    } else {
      appendToFile(file, line);
    }
  });
}

/**
 * 格式化任意参数为字符串（对象用 util.inspect 展开）
 * @param {Array} args - 日志参数列表
 * @returns {string} 拼接后的日志文本
 */
function formatArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : util.inspect(a))).join(' ');
}

// 导出各级别日志函数（同时打印控制台 + 写文件）
module.exports = {
  // debug：生产环境不打印控制台，但写入文件
  debug: (...args) => { const m = formatArgs(args); if (!isProd) console.debug('[debug]', m); writeToFile('debug', m); },
  info: (...args) => { const m = formatArgs(args); console.info('[info]', m); writeToFile('info', m); },
  warn: (...args) => { const m = formatArgs(args); console.warn('[warn]', m); writeToFile('warn', m); },
  error: (...args) => { const m = formatArgs(args); console.error('[error]', m); writeToFile('error', m); },
  isProd,          // 暴露环境判断标志
  logFilePath,     // 暴露日志文件路径计算函数
  LOG_DIR          // 暴露日志目录常量
};
