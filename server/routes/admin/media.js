const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { isAuthenticated, isAdminRole, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { ensureMediaDefaultCategory } = require('../../utils/media-utils');
const { imageUpload } = require('./upload');

// ============ 媒体文件管理 ============

// 获取媒体文件列表（数据来源：images 表 — 图片分享网后台）
router.get('/media/list', isAuthenticated, hasPermission('media.view'), (req, res) => {
  const db = req.db;
  const isAdmin = isAdminRole(req.session.user);

  let media;
  if (isAdmin) {
    media = queryAll(db, `
      SELECT i.id, i.title AS original_name, i.url AS file_path,
        CASE
          WHEN i.url LIKE '%.png' THEN 'image/png'
          WHEN i.url LIKE '%.jpg' OR i.url LIKE '%.jpeg' THEN 'image/jpeg'
          WHEN i.url LIKE '%.gif' THEN 'image/gif'
          ELSE 'image/png'
        END AS file_type,
        u.nickname AS uploader_name
      FROM images i
      LEFT JOIN users u ON i.user_id = u.id
      ORDER BY i.created_at DESC
    `);
  } else {
    media = queryAll(db, `
      SELECT i.id, i.title AS original_name, i.url AS file_path,
        CASE
          WHEN i.url LIKE '%.png' THEN 'image/png'
          WHEN i.url LIKE '%.jpg' OR i.url LIKE '%.jpeg' THEN 'image/jpeg'
          WHEN i.url LIKE '%.gif' THEN 'image/gif'
          ELSE 'image/png'
        END AS file_type,
        u.nickname AS uploader_name
      FROM images i
      LEFT JOIN users u ON i.user_id = u.id
      WHERE i.user_id = ?
      ORDER BY i.created_at DESC
    `, [req.session.user.id]);
  }

  res.json(media);
});

// 通用媒体上传（存入 images 表 — 图片分享网后台）
router.post('/media/upload', isAuthenticated, hasPermission('media.upload'), (req, res) => {
  // 手动调用 multer 以捕获文件上传错误（如文件过大、类型错误等）
  imageUpload.single('file')(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: '文件大小超出限制（最大10MB）' });
      }
      return res.status(400).json({ success: false, message: '文件上传失败: ' + err.message });
    }

    try {
      const db = req.db;

      if (!req.file) {
        return res.status(400).json({ success: false, message: '没有上传文件' });
      }

      const originalName = req.file.originalname;
      const filePath = '/uploads/images/' + req.file.filename;
      const fileType = req.file.mimetype;
      const fileSize = req.file.size;
      const uploadedBy = req.session.user.id;

      // 验证上传文件完整性：检查实际文件大小是否与multer报告的一致
      const actualFilePath = path.join(__dirname, '../../../public/uploads/images', req.file.filename);
      if (fs.existsSync(actualFilePath)) {
        const stat = fs.statSync(actualFilePath);
        if (stat.size !== fileSize) {
          console.error(`❌ 文件完整性校验失败: multer报告=${fileSize}B, 实际=${stat.size}B, 文件=${req.file.filename}`);
          // 删除不完整的文件
          try { fs.unlinkSync(actualFilePath); } catch (e) { /* ignore */ }
          return res.status(500).json({ success: false, message: '文件上传不完整，请重新上传' });
        }
      } else {
        return res.status(500).json({ success: false, message: '文件上传失败，文件未保存成功' });
      }

      const cateId = ensureMediaDefaultCategory(db);

      const result = db.run(
        'INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (, ?, ?, ?, ?, ?)',
        [originalName, '', filePath, cateId, uploadedBy, 1]
      );

      const insertedId = result?.lastInsertRowid || 0;

      saveDatabase();

      res.json({
        success: true,
        file: {
          id: insertedId,
          file_path: filePath,
          original_name: originalName,
          file_type: fileType,
          file_size: fileSize
        }
      });
    } catch (err) {
      console.error('❌ 媒体上传错误:', err.message);
      res.status(500).json({ success: false, message: '文件上传失败: ' + err.message });
    }
  });
});

module.exports = router;
