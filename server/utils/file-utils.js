/**
 * 文件读取工具函数
 * 作用：智能读取文本文件，自动兼容 UTF-8 与 GBK 两种常见中文编码，
 *       解决"用记事本保存的 GBK 文件被 Node 按 UTF-8 读出乱码"的问题。
 */
const fs = require('fs');            // Node 文件系统模块
const iconv = require('iconv-lite'); // 字符编码转换库（支持 GBK 等中文编码）

/**
 * 智能读取文本文件内容，自动检测 UTF-8 和 GBK 编码
 * @param {string} filePath - 文件路径
 * @returns {string} 解码后的文本内容
 * 逻辑：
 *   1. 先按 UTF-8 解码整个文件；
 *   2. 若结果中出现替换符 \ufffd（即 UTF-8 解码失败产生的乱码字符），
 *      说明文件其实是 GBK 编码，改用 GBK 重新解码。
 */
function readTextFileContent(filePath) {
  const rawBuffer = fs.readFileSync(filePath);       // 以二进制方式读取原始字节
  // 先尝试 UTF-8 解码
  let content = iconv.decode(rawBuffer, 'utf-8');
  // 如果包含乱码字符（\ufffd），尝试 GBK 解码
  if (content.includes('\ufffd')) {
    content = iconv.decode(rawBuffer, 'gbk');
  }
  return content;
}

module.exports = {
  readTextFileContent
};
