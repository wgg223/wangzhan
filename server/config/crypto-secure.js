const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'ENC:';

function getKey() {
  const keyStr = process.env.DATA_ENCRYPTION_KEY || process.env.SESSION_SECRET;

  if (!keyStr) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[安全错误] 生产环境必须设置 DATA_ENCRYPTION_KEY 或 SESSION_SECRET 环境变量');
    }
    console.warn('[安全警告] 未设置加密密钥，使用临时随机密钥（重启后数据无法解密）');
    const tempKey = crypto.randomBytes(32).toString('hex');
    console.warn(`[安全警告] 生成的临时密钥: ${tempKey.substring(0, 8)}...（仅用于开发环境）`);
    return crypto.createHash('sha256').update(tempKey).digest();
  }

  if (keyStr.length < 16) {
    console.warn('[安全警告] 加密密钥长度过短，建议至少32个字符');
  }

  return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function encrypt(text) {
  if (!text) return text;
  if (text.startsWith(PREFIX)) return text;

  try {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return PREFIX + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  } catch (err) {
    console.error('[crypto-secure] 加密失败:', err.message);
    throw err;
  }
}

function decrypt(text) {
  if (!text) return text;
  if (!text.startsWith(PREFIX)) return text;

  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    console.error('[crypto-secure] 加密数据格式无效');
    return text;
  }

  try {
    const key = getKey();
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    if (iv.length !== IV_LENGTH) {
      console.error('[crypto-secure] IV长度无效');
      return text;
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      console.error('[crypto-secure] Auth Tag长度无效');
      return text;
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[crypto-secure] 解密失败:', err.message);
    return text;
  }
}

function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

module.exports = { encrypt, decrypt, generateSecureToken };
