/**
 * 文件读取工具函数
 */
const fs = require('fs');
const iconv = require('iconv-lite');

/**
 * 智能读取文本文件内容，自动检测 UTF-8 和 GBK 编码
 * @param {string} filePath - 文件路径
 * @returns {string} 解码后的文本内容
 */
function readTextFileContent(filePath) {
  const rawBuffer = fs.readFileSync(filePath);
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
