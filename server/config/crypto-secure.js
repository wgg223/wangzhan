const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { projectRoot } = require('./app-root');

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

    // 开发模式：密钥持久化到项目根目录 .dev_encryption_key，避免重启后数据无法解密
    const keyFile = path.join(projectRoot, '.dev_encryption_key');
    let devKey;
    try {
      devKey = fs.readFileSync(keyFile, 'utf8').trim();
    } catch (readErr) {
      devKey = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(keyFile, devKey, { mode: 0o600 });
        console.warn(`[安全警告] 未检测到开发加密密钥，已生成并写入 ${keyFile}`);
      } catch (writeErr) {
        console.warn(`[安全警告] 无法写入开发加密密钥文件 ${keyFile}: ${writeErr.message}，本次使用临时密钥`);
      }
    }
    return crypto.createHash('sha256').update(devKey).digest();
  }

  if (keyStr.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[安全错误] 生产环境 SESSION_SECRET/DATA_ENCRYPTION_KEY 长度必须至少32个字符，当前长度: ' + keyStr.length);
    }
    console.warn('[安全警告] 加密密钥长度过短（' + keyStr.length + '位），建议至少32个字符');
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
