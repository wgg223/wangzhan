const fs = require('fs');
const path = require('path');
const util = require('util');

const isProd = (process.env.NODE_ENV === 'production');
const LOG_DIR = path.join(__dirname, '../../logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 单文件 5MB，超出后轮转为 .1

// 模块加载时只检查/创建一次日志目录，避免每次写日志同步 stat
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { /* 忽略 */ }

function logFilePath() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `runtime-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`);
}

function appendToFile(file, line) {
  fs.appendFile(file, line, 'utf8', (err) => {
    if (err) console.error('[logger] 日志写入失败:', err.message);
  });
}

function writeToFile(level, msg) {
  const file = logFilePath();
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  // 异步检查大小，超出则轮转（全程无同步 IO）
  fs.stat(file, (statErr, stat) => {
    if (!statErr && stat.size > MAX_FILE_SIZE) {
      fs.rename(file, file + '.1', (renameErr) => {
        if (renameErr) console.error('[logger] 日志轮转失败:', renameErr.message);
        appendToFile(file, line);
      });
    } else {
      appendToFile(file, line);
    }
  });
}

function formatArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : util.inspect(a))).join(' ');
}

module.exports = {
  debug: (...args) => { const m = formatArgs(args); if (!isProd) console.debug('[debug]', m); writeToFile('debug', m); },
  info: (...args) => { const m = formatArgs(args); console.info('[info]', m); writeToFile('info', m); },
  warn: (...args) => { const m = formatArgs(args); console.warn('[warn]', m); writeToFile('warn', m); },
  error: (...args) => { const m = formatArgs(args); console.error('[error]', m); writeToFile('error', m); },
  isProd,
  logFilePath,
  LOG_DIR
};
