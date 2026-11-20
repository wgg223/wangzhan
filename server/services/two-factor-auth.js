/**
 * 双因素认证 (2FA/TOTP) 服务
 * 使用 Node.js 内置 crypto 模块实现 TOTP (RFC 6238)
 * 无需外部依赖
 */

const crypto = require('crypto');

/**
 * 生成 TOTP 密钥 (Base32 编码)
 * @returns {string} Base32 编码的密钥
 */
function generateSecret() {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

/**
 * 生成 TOTP URI (用于二维码)
 * @param {string} secret - Base32 密钥
 * @param {string} username - 用户名
 * @param {string} issuer - 发行者名称
 * @returns {string} otpauth URI
 */
function generateTOTPUri(secret, username, issuer) {
  issuer = issuer || 'MyWebsite';
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedUser = encodeURIComponent(username);
  return `otpauth://totp/${encodedIssuer}:${encodedUser}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * 验证 TOTP 验证码（含防重放：同一密钥的同一时间步验证码只能用一次）
 * @param {string} token - 用户输入的 6 位验证码
 * @param {string} secret - Base32 密钥
 * @param {number} window - 允许的时间窗口偏移 (默认前后各1个)
 * @returns {boolean} 是否验证通过
 */
// 已用时间步记录：key = 密钥指纹:counter，value = 过期时间戳
// TTL 覆盖 ±1 窗口（最长 90 秒）并留余量，防止窗口内重放
const usedSteps = new Map();
const USED_STEP_TTL = 120 * 1000;

function verifyTOTP(token, secret, window = 1) {
  if (!token || !secret) return false;
  if (!/^\d{6}$/.test(token)) return false;

  const decodedSecret = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000);
  const period = 30;
  const nowMs = Date.now();
  const keyFingerprint = crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);

  // 惰性清理过期条目，防止 Map 无界增长
  if (usedSteps.size > 1000) {
    for (const [k, exp] of usedSteps) {
      if (exp <= nowMs) usedSteps.delete(k);
    }
  }

  // 检查当前时间窗口及前后 window 个窗口
  for (let i = -window; i <= window; i++) {
    const counter = Math.floor(now / period) + i;
    const expectedToken = generateTOTP(decodedSecret, counter);
    if (expectedToken === token) {
      const usedKey = keyFingerprint + ':' + counter;
      const exp = usedSteps.get(usedKey);
      if (exp && exp > nowMs) return false; // 该时间步验证码已使用过，拒绝重放
      usedSteps.set(usedKey, nowMs + USED_STEP_TTL);
      return true;
    }
  }
  return false;
}

/**
 * 生成 TOTP 验证码 (内部使用)
 * @param {Buffer} secret - 解码后的密钥
 * @param {number} counter - 时间计数器
 * @returns {string} 6 位验证码
 */
function generateTOTP(secret, counter) {
  // 将计数器转为 8 字节大端序 Buffer
  const counterBuf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = counter & 0xff;
    counter = counter >>> 8;
  }

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(counterBuf);
  const hash = hmac.digest();

  // 动态截断
  const offset = hash[hash.length - 1] & 0xf;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  // 取模 10^6 得到 6 位数字
  const otp = binary % 1000000;
  return String(otp).padStart(6, '0');
}

/**
 * Base32 编码
 * @param {Buffer} buffer
 * @returns {string}
 */
function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 0x1f];
  }

  // 添加填充
  while (output.length % 8 !== 0) {
    output += '=';
  }

  return output;
}

/**
 * Base32 解码
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/=/g, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < str.length; i++) {
    const idx = alphabet.indexOf(str[i]);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

module.exports = {
  generateSecret,
  generateTOTPUri,
  verifyTOTP
};
