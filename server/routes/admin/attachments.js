const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

const UPLOAD_DIR = path.join(__dirname, '../../../public/uploads/attachments');
const CHUNKS_DIR = path.join(__dirname, '../../../public/uploads/.chunks');
const MAX_FILE_SIZE = 200 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  '.exe', '.msi', '.dmg', '.apk', '.ipa',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.mp3', '.wav', '.flac', '.aac', '.ogg',
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv',
  '.iso', '.img',
  '.psd', '.ai', '.sketch',
  '.ttf', '.otf', '.woff', '.woff2',
  '.db', '.sqlite', '.sql'
];

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
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// POST /admin/attachments/upload/init - Initialize resumable upload
router.post('/upload/init', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const { fileName, fileSize, totalChunks } = req.body;

  if (!fileName || !fileSize || !totalChunks) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  if (fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: '文件大小不能超过 200MB' });
  }

  if (!validateExtension(fileName)) {
    return res.status(400).json({ error: '不支持的文件类型' });
  }

  const uploadId = crypto.randomBytes(16).toString('hex');
  const sessionChunkDir = path.join(CHUNKS_DIR, uploadId);
  fs.mkdirSync(sessionChunkDir, { recursive: true });

  uploadSessions.set(uploadId, {
    fileName,
    fileSize,
    totalChunks: parseInt(totalChunks, 10),
    receivedChunks: new Set(),
    createdAt: Date.now(),
    userId: req.session.user.id
  });

  res.json({ uploadId, totalChunks: parseInt(totalChunks, 10) });
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

  const chunks = [];

  req.on('data', (chunk) => {
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
    res.status(500).json({ error: '分片上传失败' });
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
  if (uploadId) {
    const sessionChunkDir = path.join(CHUNKS_DIR, uploadId);
    if (fs.existsSync(sessionChunkDir)) {
      fs.rmSync(sessionChunkDir, { recursive: true, force: true });
    }
    uploadSessions.delete(uploadId);
  }
  res.json({ success: true });
});

// POST /admin/attachments/save - Save attachment record
router.post('/save', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const { article_id, original_name, file_name, file_path, file_size } = req.body;

  if (!original_name || !file_name || !file_path) {
    return res.status(400).json({ error: '缺少必要参数' });
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

  const filePath = path.join(__dirname, '../../../public', att.file_path);
  if (fs.existsSync(filePath)) {
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

// GET /admin/attachments/download/:id - Download attachment (public)
router.get('/download/:id', (req, res) => {
  const db = req.db;
  const att = queryOne(db, 'SELECT * FROM article_attachments WHERE id = ?', [req.params.id]);

  if (!att) {
    return res.status(404).json({ error: '附件不存在' });
  }

  const filePath = path.join(__dirname, '../../../public', att.file_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    db.run('UPDATE article_attachments SET download_count = download_count + 1 WHERE id = ?', [parseInt(att.id, 10)]);
    saveDatabase();
  } catch (e) { /* ignore */ }

  res.download(filePath, att.original_name);
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
      const filePath = path.join(__dirname, '../../../public', att.file_path);
      if (fs.existsSync(filePath)) {
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
