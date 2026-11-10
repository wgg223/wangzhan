/**
 * 角色卡文件导入共享服务
 *
 * 从 server/routes/admin/ai-chat.js 抽出，供后台批量导入与角色卡广场上传共用：
 *   - PNG 角色卡（SillyTavern 标准）：tEXt chunk 里的 chara 字段（base64 JSON）提取与回写
 *   - 头像落盘（校验 magic，防任意文件写入）与 data URL / 本地路径解析
 *   - 无头像时的占位 PNG（导出 PNG 卡用）
 *   - parseCardFiles()：把一批 .json / .png 文件解析成归一后的角色卡（V1/V2/V3）
 *
 * 安全约定：不 fetch 远程 URL（防 SSRF）；只接受 .json / .png；单文件 ≤10MB。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const characterCards = require('./characters');

const ROLE_AVATAR_DIR = path.join(require('../../config/app-root').projectRoot, 'public', 'uploads', 'avatars');
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ============ PNG chunk 基础 ============

// CRC32（PNG chunk 校验）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 从 PNG tEXt chunk 提取 chara 字段（base64 JSON，SillyTavern 角色卡标准）
function extractPngChara(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + len > buf.length) break;
    if (type === 'tEXt') {
      const data = buf.subarray(start, start + len);
      const idx = data.indexOf(0);
      if (idx > 0 && data.toString('latin1', 0, idx) === 'chara') {
        try { return Buffer.from(data.toString('latin1', idx + 1), 'base64').toString('utf8'); } catch (e) { return null; }
      }
    }
    offset = start + len + 4;
    if (type === 'IEND') break;
  }
  return null;
}

// 重建 PNG：移除旧 chara tEXt，在 IEND 前嵌入新 chara
function rebuildPngWithChara(buf, jsonStr) {
  const payload = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(Buffer.from(jsonStr, 'utf8').toString('base64'), 'latin1')
  ]);
  const chunk = pngChunk('tEXt', payload);
  const parts = [buf.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + len + 4;
    if (end > buf.length) break;
    const isChara = type === 'tEXt' && buf.toString('latin1', offset + 8, offset + 8 + Math.min(len, 6)) === 'chara\0';
    if (!isChara) {
      if (type === 'IEND' && !inserted) { parts.push(chunk); inserted = true; }
      parts.push(buf.subarray(offset, end));
    }
    offset = end;
  }
  if (!inserted) parts.push(chunk);
  return Buffer.concat(parts);
}

// 无头像时的占位 PNG（128x128 粉色纯色图）
let placeholderPngCache = null;
function placeholderPng() {
  if (placeholderPngCache) return placeholderPngCache;
  const w = 128, h = 128;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = 236; row[2 + x * 3] = 72; row[3 + x * 3] = 153; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  placeholderPngCache = Buffer.concat([
    PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))
  ]);
  return placeholderPngCache;
}

// ============ 头像 ============

// 头像二进制落盘（校验 magic，防任意文件写入），返回 URL
function saveRoleAvatarBuffer(buf) {
  if (!buf || buf.length < 12 || buf.length > 5 * 1024 * 1024) return '';
  let ext = '';
  if (buf.subarray(0, 8).equals(PNG_SIG)) ext = '.png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = '.webp';
  else return '';
  if (!fs.existsSync(ROLE_AVATAR_DIR)) fs.mkdirSync(ROLE_AVATAR_DIR, { recursive: true });
  const fname = 'role-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
  fs.writeFileSync(path.join(ROLE_AVATAR_DIR, fname), buf);
  return '/uploads/avatars/' + fname;
}

// 导入头像解析：data URL 落盘；本地/远程 URL 直接保留；其余回退 fallback
function resolveImportAvatar(raw, fallback) {
  const v = String(raw || '').trim();
  if (v.indexOf('data:image/') === 0) {
    const m = v.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (m) {
      const url = saveRoleAvatarBuffer(Buffer.from(m[2], 'base64'));
      if (url) return url;
    }
    return fallback || '';
  }
  if (v && v.length <= 2000 && (v.indexOf('/') === 0 || v.indexOf('https://') === 0 || v.indexOf('http://') === 0)) return v;
  return fallback || '';
}

// ============ 文件解析 ============

/**
 * 把一批上传文件解析成归一后的角色卡
 * @param {Array<{originalname:string, buffer:Buffer}>} files - multer 内存存储文件
 * @returns {{items: Array<{norm: Object, fileName: string}>, errors: string[]}}
 *   items[].norm 为 characterCards.normalizeCard 结果（含 avatar 已解析），失败原因进 errors
 */
function parseCardFiles(files) {
  const items = [];
  const errors = [];
  (files || []).forEach(file => {
    const fname = file.originalname || 'file';
    const ext = path.extname(fname).toLowerCase();
    let cards = [];
    let pngAvatarUrl = '';
    try {
      if (ext === '.png') {
        const json = extractPngChara(file.buffer);
        if (!json) { errors.push(fname + '：PNG 不含 chara 字段，不是角色卡'); return; }
        cards = [JSON.parse(json)];
        pngAvatarUrl = saveRoleAvatarBuffer(file.buffer);
      } else if (ext === '.json') {
        const parsed = JSON.parse(file.buffer.toString('utf8'));
        if (Array.isArray(parsed)) cards = parsed;
        else if (parsed && Array.isArray(parsed.roles)) cards = parsed.roles;
        else if (parsed && Array.isArray(parsed.characters)) cards = parsed.characters;
        else cards = [parsed];
      } else {
        errors.push(fname + '：仅支持 .json / .png 角色卡');
        return;
      }
    } catch (e) {
      errors.push(fname + '：解析失败（' + e.message + '）');
      return;
    }
    cards.forEach(card => {
      const norm = characterCards.normalizeCard(card, fname);
      if (!norm) { errors.push(fname + '：缺少名称或设定/开场白，跳过'); return; }
      norm.avatar = resolveImportAvatar(norm.avatar, pngAvatarUrl);
      items.push({ norm, fileName: fname });
    });
  });
  return { items, errors };
}

module.exports = {
  PNG_SIG,
  ROLE_AVATAR_DIR,
  crc32,
  pngChunk,
  extractPngChara,
  rebuildPngWithChara,
  placeholderPng,
  saveRoleAvatarBuffer,
  resolveImportAvatar,
  parseCardFiles
};
