/**
 * 文件类型魔数（Magic Bytes）校验工具
 * 作用：防止"伪装成图片的可执行文件/网页木马"上传。
 *       不信任浏览器上报的 Content-Type，改为读取文件头部字节
 *       与真实图片格式的魔数签名比对，类型不符直接拒绝。
 * 注意：AVIF/HEIC/SVG 等格式头不固定或为文本格式，无法可靠校验，
 *       这里选择"接受但不校验"（配合扩展名/其他策略兜底）。
 */

/**
 * 各图片 MIME 类型对应的文件头魔数签名（十六进制字节序列）
 * - JPEG：FF D8 FF（SOI 标记）
 * - PNG ：89 50 4E 47（\x89PNG）
 * - GIF ：47 49 46 38（GIF8）
 * - WebP：RIFF 开头（52 49 46 46）
 * - BMP ：BM（42 4D）
 * - TIFF：II*\0（小端）或 MM\0*（大端），两种都要匹配
 */
const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/jpg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF header
  'image/bmp': [[0x42, 0x4D]], // BM header
  'image/avif': [[0x00, 0x00, 0x00]], // ftyp box (varies) —— 占位，未启用严格校验
  'image/heic': [[0x00, 0x00, 0x00]], // ftyp box (varies) —— 占位，未启用严格校验
  'image/tiff': [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]], // II or MM
};

// 可通过魔数可靠校验的格式（实际参与校验的白名单）
const VALIDATABLE_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

// 接受但跳过魔数校验的格式（头部结构不固定或为文本型，如 SVG 本质是 XML 文本）
const ACCEPTED_UNVALIDATED = ['image/avif', 'image/heic', 'image/heif', 'image/svg+xml', 'image/x-ms-bmp'];

/**
 * 校验缓冲区内容是否与声明的 MIME 类型相符
 * @param {Buffer} buffer - 文件内容缓冲区（至少前几个字节）
 * @param {string} mimeType - 声明的 MIME 类型
 * @returns {boolean} true=通过校验（或属于免校验格式），false=类型不符
 * 逻辑：
 *   1. 免校验格式直接放行；
 *   2. 未知格式返回 false（拒绝）；
 *   3. 缓冲区不足 4 字节视为可疑，拒绝；
 *   4. 遍历该类型所有可能签名，任一匹配即通过。
 */
function validateMagicBytes(buffer, mimeType) {
  // 如果格式不在可校验列表（属于免校验格式），跳过校验
  if (ACCEPTED_UNVALIDATED.includes(mimeType)) return true;

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;        // 未知 MIME，直接拒绝

  if (buffer.length < 4) return false;  // 文件太短，无法确认是合法图片

  // 逐个签名比对：完全匹配任一签名即认为文件类型正确
  for (const sig of signatures) {
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// 导出校验函数与魔数表（魔数表供调试/扩展使用）
module.exports = { validateMagicBytes, MAGIC_BYTES };
