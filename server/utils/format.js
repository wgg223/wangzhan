/**
 * 通用格式化工具函数
 * 作用：提供字节数、运行时长等数值的人类可读格式化，
 *       用于后台监控页面、系统信息展示等场景。
 */

/**
 * 格式化字节数为人类可读字符串（B/KB/MB/GB）
 * @param {number} bytes - 字节数
 * @returns {string} 如 "1.5 MB"
 * 原理：以 1024 为底取对数，得到数量级索引，再除以对应 1024^i。
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';           // 特判 0，避免 Math.log(0) 出错
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];   // 数量级单位表
  const i = Math.floor(Math.log(bytes) / Math.log(k));  // 计算处于哪个数量级
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 格式化运行时间（秒 → "X天X小时X分X秒"）
 * @param {number} seconds - 运行总秒数（如 process.uptime()）
 * @returns {string} 中文可读时长
 * 说明：不足一天/一小时/一分钟的单位会被省略，秒永远展示。
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);              // 整天数（1天=86400秒）
  const hours = Math.floor((seconds % 86400) / 3600);    // 剩余小时数
  const minutes = Math.floor((seconds % 3600) / 60);     // 剩余分钟数
  const secs = Math.floor(seconds % 60);                 // 剩余秒数

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${secs}秒`);

  return parts.join('');
}

module.exports = { formatBytes, formatUptime };
