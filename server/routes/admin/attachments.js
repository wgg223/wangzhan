/**
 * 文章附件管理路由（后台，需 articles.manage 权限；下载需权限校验）
 * 能力：
 *   POST /upload/init           —— 初始化断点续传会话（文件名/大小/分片数校验；每用户并发≤5；200MB上限）
 *   POST /upload/chunk          —— 上传单个分片（会话归属校验；分片索引越界校验；3MB 内存上限）
 *   GET  /upload/status/:id     —— 查询上传进度
 *   POST /upload/merge          —— 合并分片为最终文件（文件名净化后落盘，删分片目录）
 *   POST /upload/cancel         —— 取消上传（uploadId 正则白名单 + 路径越界校验）
 *   POST /save / batch-save     —— 写入/批量写入附件记录（file_path 白名单校验）
 *   GET  /list/:articleId       —— 文章附件列表
 *   POST /delete/:id            —— 删除附件（safeResolveAttachment 防穿越）
 *   GET  /download/:id          —— 下载（IDOR 防护：上传者/文章作者/articles.manage 权限；下载计数+1）
 *   POST /update-article        —— 为孤儿附件回填文章 ID（限本人上传）
 *   POST /cleanup               —— 清理不在保留列表中的附件（参数化 IN 查询）
 * 安全要点：扩展名双白名单（ALLOWED/BLOCKED）；路径统一走 isValidAttachmentPath+safeResolveAttachment；
 *           分片内存上限 3MB；会话 24 小时自动过期清理。
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { formatBytes } = require('../../utils/format');

const { publicDir } = require('../../config/app-root');

const UPLOAD_DIR = path.join(publicDir, 'uploads', 'attachments');
const CHUNKS_DIR = path.join(publicDir, 'uploads', '.chunks');
const MAX_FILE_SIZE = 200 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.json', '.yaml', '.yml',
  '.mp3', '.wav', '.flac', '.aac', '.ogg',
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv',
  '.psd', '.ai', '.sketch',
  '.ttf', '.otf', '.woff', '.woff2'
];

// 附件文件路径校验：必须以 /uploads/attachments/ 开头且不含 ..
function isValidAttachmentPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('..')) return false;
  return filePath.startsWith('/uploads/attachments/');
}

function safeResolveAttachment(filePath) {
  if (!isValidAttachmentPath(filePath)) return null;
  const resolved = path.resolve(publicDir, '.' + filePath);
  const attachmentsDir = path.resolve(UPLOAD_DIR);
  if (!resolved.startsWith(attachmentsDir)) return null;
  return resolved;
}

const BLOCKED_EXTENSIONS = [
  '.bat', '.cmd', '.com', '.vbs', '.js', '.jse',
  '.wsf', '.wsh', '.ps1', '.psm1', '.psd1', '.ps1xml',
  '.scr', '.pif', '.hta', '.cpl', '.msc', '.reg'
];

function ensureDirs() {
  [UPLOAD_DIR, CHUNKS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

ensureDirs();

const uploadSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of uploadSessions) {
    if (now - session.createdAt > 24 * 60 * 60 * 1000) {
      const sessionChunkDir = path.join(CHUNKS_DIR, id);
      if (fs.existsSync(sessionChunkDir)) {
        fs.rmSync(sessionChunkDir, { recursive: true, force: true });
      }
      uploadSessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

function validateExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext)) return false;
  if (ALLOWED_EXTENSIONS.includes(ext)) return true;
  return false;
}

function formatSize(bytes) {
  return formatBytes(bytes);
}

// 文件名净化：防止换行/控制字符注入 Content-Disposition 响应头
function safeDownloadName(name) {
  return String(name || 'attachment').replace(/[\r\n\0]/g, '').slice(0, 255);
}

// POST /admin/attachments/upload/init - Initialize resumable upload
router.post('/upload/init', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const { fileName, fileSize, totalChunks } = req.body;

  if (!fileName || !fileSize || !totalChunks) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const size = parseInt(fileSize, 10);
  const chunkCount = parseInt(totalChunks, 10);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
    return res.status(400).json({ error: '文件大小非法（最大 200MB）' });
  }
  if (!Number.isFinite(chunkCount) || chunkCount <= 0 || chunkCount > 500) {
    return res.status(400).json({ error: '分片数量非法（1-500）' });
  }

  // 每用户并发上传会话上限，防内存/磁盘耗尽
  let userSessions = 0;
  for (const s of uploadSessions.values()) {
    if (s.userId === req.session.user.id) userSessions++;
  }
  if (userSessions >= 5) {
    return res.status(429).json({ error: '并发上传会话过多，请稍后再试' });
  }

  if (!validateExtension(fileName)) {
    return res.status(400).json({ error: '不支持的文件类型' });
  }

  const uploadId = crypto.randomBytes(16).toString('hex');
  const sessionChunkDir = path.join(CHUNKS_DIR, uploadId);
  fs.mkdirSync(sessionChunkDir, { recursive: true });

  uploadSessions.set(uploadId, {
    fileName,
    fileSize: size,
    totalChunks: chunkCount,
    receivedChunks: new Set(),
    createdAt: Date.now(),
    userId: req.session.user.id
  });

  res.json({ uploadId, totalChunks: chunkCount });
});

// POST /admin/attachments/upload/chunk - Upload a single chunk
router.post('/upload/chunk', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const uploadId = req.headers['x-upload-id'];
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);

  if (!uploadId || isNaN(chunkIndex)) {
    return res.status(400).json({ error: '缺少上传ID或分片索引' });
  }

  const session = uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: '上传会话不存在或已过期' });
  }

  if (session.userId !== req.session.user.id) {
    return res.status(403).json({ error: '无权操作此上传会话' });
  }

  // 分片索引越界校验
  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    return res.status(400).json({ error: '分片索引非法' });
  }

  // 分片大小上限（名义 2MB + 余量），超出立即终止防止内存耗尽
  const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
  const chunks = [];
  let receivedBytes = 0;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_CHUNK_BYTES) {
      if (!res.headersSent) {
        res.status(413).json({ error: '分片大小超出限制' });
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const chunkPath = path.join(CHUNKS_DIR, uploadId, `chunk_${chunkIndex}`);

    fs.writeFileSync(chunkPath, buffer);
    session.receivedChunks.add(chunkIndex);

    res.json({
      success: true,
      chunkIndex,
      received: session.receivedChunks.size,
      total: session.totalChunks
    });
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: '分片上传失败' });
    }
  });
});

// GET /admin/attachments/upload/status/:uploadId - Check upload progress
router.get('/upload/status/:uploadId', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const session = uploadSessions.get(req.params.uploadId);
  if (!session) {
    return res.json({ exists: false });
  }

  res.json({
    exists: true,
    fileName: session.fileName,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    receivedChunks: Array.from(session.receivedChunks)
  });
});

// POST /admin/attachments/upload/merge - Merge chunks into final file
router.post('/upload/merge', isAuthenticated, hasPermission('articles.manage'), async (req, res) => {
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: '缺少上传ID' });
  }

  const session = uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: '上传会话不存在或已过期' });
  }

  if (session.userId !== req.session.user.id) {
    return res.status(403).json({ error: '无权操作此上传会话' });
  }

  if (session.receivedChunks.size !== session.totalChunks) {
    return res.status(400).json({
      error: '分片未全部上传完成',
      received: session.receivedChunks.size,
      total: session.totalChunks
    });
  }

  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1E9);
  const ext = path.extname(session.fileName);
  const baseName = path.basename(session.fileName, ext)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_')
    .substring(0, 100);
  const finalFileName = `${timestamp}-${random}-${baseName}${ext}`;
  const finalPath = path.join(UPLOAD_DIR, finalFileName);
  const sessionChunkDir = path.join(CHUNKS_DIR, uploadId);

  try {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(sessionChunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.close();
        fs.unlinkSync(finalPath);
        return res.status(500).json({ error: `分片 ${i} 缺失` });
      }
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }
    writeStream.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    fs.rmSync(sessionChunkDir, { recursive: true, force: true });
    uploadSessions.delete(uploadId);

    const relativePath = '/uploads/attachments/' + finalFileName;

    res.json({
      success: true,
      file: {
        file_name: finalFileName,
        original_name: session.fileName,
        file_path: relativePath,
        file_size: session.fileSize
      }
    });
  } catch (err) {
    console.error('[attachments] 合并文件失败:', err);
    res.status(500).json({ error: '文件合并失败' });
  }
});

// POST /admin/attachments/upload/cancel - Cancel upload
router.post('/upload/cancel', isAuthenticated, (req, res) => {
  const { uploadId } = req.body;
  if (!uploadId || !/^[a-f0-9]{32}$/.test(uploadId)) {
    return res.status(400).json({ error: '无效的上传ID' });
  }
  const sessionChunkDir = path.join(CHUNKS_DIR, uploadId);
  const resolved = path.resolve(sessionChunkDir);
  if (!resolved.startsWith(path.resolve(CHUNKS_DIR))) {
    return res.status(403).json({ error: '路径越界' });
  }
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  uploadSessions.delete(uploadId);
  res.json({ success: true });
});

// POST /admin/attachments/save - Save attachment record
router.post('/save', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const { article_id, original_name, file_name, file_path, file_size } = req.body;

  if (!original_name || !file_name || !file_path) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  if (!isValidAttachmentPath(file_path)) {
    return res.status(400).json({ error: '非法的文件路径' });
  }

  try {
    db.run(
      'INSERT INTO article_attachments (article_id, original_name, file_name, file_path, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
      [article_id || null, original_name, file_name, file_path, file_size || 0, req.session.user.id]
    );
    saveDatabase();

    const att = queryOne(db, 'SELECT * FROM article_attachments WHERE file_name = ?', [file_name]);

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'upload',
      target_type: 'attachment',
      target_id: att ? att.id : null,
      target_title: original_name,
      detail: '上传附件：' + original_name + ' (' + formatSize(file_size) + ')',
      ip: req.ip
    });

    res.json({ success: true, attachment: att });
  } catch (err) {
    console.error('[attachments] 保存附件记录失败:', err);
    res.status(500).json({ error: '保存失败' });
  }
});

// POST /admin/attachments/batch-save - Save multiple attachment records
router.post('/batch-save', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const { article_id, attachments } = req.body;

  if (!Array.isArray(attachments)) {
    return res.status(400).json({ error: '参数格式错误' });
  }

  const results = [];
  try {
    for (const att of attachments) {
      if (!att.original_name || !att.file_name || !att.file_path) continue;
      if (!isValidAttachmentPath(att.file_path)) continue;
      db.run(
        'INSERT INTO article_attachments (article_id, original_name, file_name, file_path, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        [article_id || null, att.original_name, att.file_name, att.file_path, att.file_size || 0, req.session.user.id]
      );
      const record = queryOne(db, 'SELECT * FROM article_attachments WHERE file_name = ?', [att.file_name]);
      if (record) results.push(record);
    }
    saveDatabase();
    res.json({ success: true, attachments: results });
  } catch (err) {
    console.error('[attachments] 批量保存失败:', err);
    res.status(500).json({ error: '保存失败' });
  }
});

// GET /admin/attachments/list/:articleId - List attachments for an article
router.get('/list/:articleId', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const attachments = queryAll(db,
    'SELECT * FROM article_attachments WHERE article_id = ? ORDER BY created_at ASC',
    [req.params.articleId]
  );
  res.json(attachments);
});

// POST /admin/attachments/delete/:id - Delete attachment
router.post('/delete/:id', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const att = queryOne(db, 'SELECT * FROM article_attachments WHERE id = ?', [req.params.id]);

  if (!att) {
    return res.status(404).json({ error: '附件不存在' });
  }

  const filePath = safeResolveAttachment(att.file_path);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  db.run('DELETE FROM article_attachments WHERE id = ?', [req.params.id]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'attachment',
    target_id: parseInt(req.params.id, 10),
    target_title: att.original_name,
    detail: '删除附件：' + att.original_name,
    ip: req.ip
  });

  res.json({ success: true });
});

// GET /admin/attachments/download/:id - Download attachment
router.get('/download/:id', isAuthenticated, (req, res) => {
  const db = req.db;
  const att = queryOne(db, 'SELECT * FROM article_attachments WHERE id = ?', [req.params.id]);

  if (!att) {
    return res.status(404).json({ error: '附件不存在' });
  }

  // IDOR 防护：仅上传者本人、关联文章作者、或有 articles.manage 权限的用户可下载
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  let canDownload = att.uploaded_by === userId || userRole === 'admin' || userRole === 'super_admin';
  if (!canDownload && att.article_id) {
    const article = queryOne(db, 'SELECT author_id FROM articles WHERE id = ?', [att.article_id]);
    if (article && article.author_id === userId) canDownload = true;
  }
  if (!canDownload) {
    const perm = queryOne(db, 'SELECT 1 FROM user_permissions WHERE user_id = ? AND perm_key = ?', [userId, 'articles.manage']);
    if (perm) canDownload = true;
  }
  if (!canDownload) {
    return res.status(403).json({ error: '无权下载此附件' });
  }

  const filePath = safeResolveAttachment(att.file_path);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    db.run('UPDATE article_attachments SET download_count = download_count + 1 WHERE id = ?', [parseInt(att.id, 10)]);
    saveDatabase();
  } catch (e) { /* ignore */ }

  res.download(filePath, safeDownloadName(att.original_name));
});

// POST /admin/attachments/update-article - Update article_id for orphan attachments
router.post('/update-article', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const { attachment_ids, article_id } = req.body;

  if (!Array.isArray(attachment_ids) || !article_id) {
    return res.status(400).json({ error: '参数格式错误' });
  }

  try {
    for (const attId of attachment_ids) {
      db.run('UPDATE article_attachments SET article_id = ? WHERE id = ? AND uploaded_by = ?',
        [article_id, attId, req.session.user.id]);
    }
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    console.error('[attachments] 更新关联失败:', err);
    res.status(500).json({ error: '更新失败' });
  }
});

// POST /admin/attachments/cleanup - Remove attachments not in provided list for an article
router.post('/cleanup', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const { article_id, keep_ids } = req.body;

  if (!article_id || !Array.isArray(keep_ids)) {
    return res.status(400).json({ error: '参数格式错误' });
  }

  try {
    const toRemove = queryAll(db,
      'SELECT * FROM article_attachments WHERE article_id = ? AND id NOT IN (' + keep_ids.map(() => '?').join(',') + ')',
      [article_id, ...keep_ids]
    );

    for (const att of toRemove) {
      const filePath = safeResolveAttachment(att.file_path);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      db.run('DELETE FROM article_attachments WHERE id = ?', [att.id]);
    }
    saveDatabase();
    res.json({ success: true, removed: toRemove.length });
  } catch (err) {
    console.error('[attachments] 清理失败:', err);
    res.status(500).json({ error: '清理失败' });
  }
});

module.exports = router;
