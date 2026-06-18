const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { readTextFileContent } = require('../../utils/file-utils');
const fsSafe = require('../../utils/fs-safe');
const { novelUpload, imageUpload } = require('./upload');

// ============ 小说管理 ============

router.get('/novels', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  const db = req.db;
  const novels = queryAll(db, `
    SELECT n.*, u.username as uploader_name,
    (SELECT COUNT(*) FROM novel_chapters WHERE novel_id = n.id) as chapter_count
    FROM novels n
    LEFT JOIN users u ON n.uploaded_by = u.id
    ORDER BY n.created_at DESC
  `);

  res.render('admin/novels', {
    user: req.session.user,
    novels: novels,
    settings: res.locals.settings || {}
  });
});

router.get('/novels/new', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  res.render('admin/novel-editor', {
    user: req.session.user,
    novel: null,
    settings: res.locals.settings || {}
  });
});

router.get('/novels/edit/:id', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  const db = req.db;
  const novel = queryOne(db, 'SELECT * FROM novels WHERE id = ?', [req.params.id]);
  const chapters = queryAll(db, 'SELECT * FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number ASC', [req.params.id]);

  if (!novel) {
    return res.status(404).render('frontend/error', {
      message: '小说不存在',
      error: '',
      user: req.session.user,
      settings: res.locals.settings || {}
    });
  }

  res.render('admin/novel-editor', {
    user: req.session.user,
    novel: novel,
    chapters: chapters,
    settings: res.locals.settings || {}
  });
});

router.post('/novels/save', isAuthenticated, hasPermission('novels.view'), imageUpload.single('cover_image'), (req, res) => {
  try {
    const db = req.db;
    const { id, title, author, description, status } = req.body;

    if (!title) {
      return res.status(400).json({ error: '小说标题不能为空' });
    }

    let cover_image = req.body.cover_image || '';
    if (req.file) {
      cover_image = '/uploads/images/' + req.file.filename;
    }

    if (id) {
      db.run('UPDATE novels SET title=?, author=?, description=?, cover_image=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [title, author || '', description || '', cover_image, status || 'published', id]);
    } else {
      db.run('INSERT INTO novels (title, author, description, cover_image, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        [title, author || '', description || '', cover_image, status || 'published', req.session.user.id]);
    }

    saveDatabase();
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'novel', target_id: id || null, target_title: title, detail: (id ? '更新' : '创建') + '小说：' + title, ip: req.ip });
    res.redirect('/admin/novels');
  } catch (err) {
    console.error('❌ novels/save 错误:', err.message);
    res.status(500).json({ error: '保存小说失败: ' + err.message });
  }
});

router.post('/novels/upload-chapter', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  novelUpload.single('chapter_file')(req, res, function(err) {
    if (err) {
      return res.status(400).json({ error: '文件上传失败: ' + err.message });
    }

    const db = req.db;
    const { novel_id, chapter_title } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: '请上传TXT文件' });
    }

    if (!novel_id) {
      return res.status(400).json({ error: '小说ID不能为空' });
    }

    const filePath = path.join(__dirname, '../../public/uploads/novels', req.file.filename);
    let content = '';
    try {
      content = readTextFileContent(filePath);
    } catch (err) {
      return res.status(500).json({ error: '读取文件失败' });
    }

    const maxChapter = queryOne(db, 'SELECT MAX(chapter_number) as max_num FROM novel_chapters WHERE novel_id = ?', [novel_id]);
    const chapterNumber = (maxChapter?.max_num || 0) + 1;

    const chapterTitle = chapter_title || path.parse(req.file.originalname).name;
    const relativePath = '/uploads/novels/' + req.file.filename;

    db.run('INSERT INTO novel_chapters (novel_id, title, file_path, content, chapter_number, file_size) VALUES (?, ?, ?, ?, ?, ?)',
      [novel_id, chapterTitle, relativePath, content, chapterNumber, req.file.size]);

    saveDatabase();
    const novelInfo = queryOne(db, 'SELECT title FROM novels WHERE id = ?', [novel_id]);
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'novel_chapter', target_id: null, target_title: (novelInfo ? novelInfo.title : '') + ' - ' + chapterTitle, detail: '上传小说章节：' + (novelInfo ? novelInfo.title : '') + ' -> ' + chapterTitle, ip: req.ip });
    res.redirect('/admin/novels/edit/' + novel_id);
  });
});

router.post('/novels/batch-upload-chapters', isAuthenticated, hasPermission('novels.view'), function(req, res, next) {
  novelUpload.array('chapter_files', 100)(req, res, function(err) {
    if (err) {
      console.error('❌ Multer batch upload error:', err);
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '文件数量超过限制（最多100个）' });
      }
      return res.status(400).json({ error: '文件上传失败: ' + err.message });
    }
    next();
  });
}, (req, res) => {
  try {
    const db = req.db;
    const { novel_id } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择要上传的TXT文件' });
    }

    if (!novel_id) {
      return res.status(400).json({ error: '小说ID不能为空' });
    }

    const maxChapter = queryOne(db, 'SELECT MAX(chapter_number) as max_num FROM novel_chapters WHERE novel_id = ?', [novel_id]);
    let chapterNumber = (maxChapter?.max_num || 0) + 1;

    const results = { success: [], errors: [] };

    req.files.forEach((file) => {
      try {
        const filePath = path.join(__dirname, '../../public/uploads/novels', file.filename);
        let content = readTextFileContent(filePath);

        let chapterTitle = '';
        const titleMatch = content.match(/(第[\s]*(?:\d+|[一二三四五六七八九十百千万]+)[\s]*(?:章|节|卷|篇|部分)[\s]*[^\n]{0,50})/);
        if (titleMatch) {
          chapterTitle = titleMatch[1].trim();
        } else {
          const enMatch = content.match(/(?:Chapter|CHAPTER|chapter)\s*\d+[^\n]{0,50}/);
          if (enMatch) {
            chapterTitle = enMatch[0].trim();
          } else {
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            if (lines.length > 0 && lines[0].length < 100) {
              chapterTitle = lines[0].trim();
            } else {
              chapterTitle = path.parse(file.originalname).name;
            }
          }
        }

        const relativePath = '/uploads/novels/' + file.filename;

        db.run('INSERT INTO novel_chapters (novel_id, title, file_path, content, chapter_number, file_size) VALUES (?, ?, ?, ?, ?, ?)',
          [novel_id, chapterTitle, relativePath, content, chapterNumber, file.size]);

        results.success.push({ originalName: file.originalname, title: chapterTitle, chapterNumber: chapterNumber });
        chapterNumber++;
      } catch (err) {
        results.errors.push({ originalName: file.originalname, error: err.message });
      }
    });

    saveDatabase();

    const novelInfo = queryOne(db, 'SELECT title FROM novels WHERE id = ?', [novel_id]);
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'novel_chapter', target_id: null, target_title: (novelInfo ? novelInfo.title : '') + ' 批量上传', detail: '批量上传 ' + results.success.length + ' 个章节到小说：' + (novelInfo ? novelInfo.title : ''), ip: req.ip });

    if (results.errors.length === 0) {
      res.json({ success: true, message: '成功上传 ' + results.success.length + ' 个章节', results });
    } else {
      res.json({ success: true, message: '上传完成：' + results.success.length + ' 成功，' + results.errors.length + ' 失败', results });
    }
  } catch (err) {
    console.error('❌ Batch upload error:', err);
    return res.status(500).json({ error: '服务器处理上传时发生错误: ' + err.message });
  }
});

router.post('/novels/delete-chapter/:id', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  const db = req.db;
  const chapter = queryOne(db, 'SELECT * FROM novel_chapters WHERE id = ?', [req.params.id]);

  if (!chapter) {
    return res.status(404).json({ error: '章节不存在' });
  }

  const filePath = path.join(__dirname, '../../public', chapter.file_path);
  fsSafe.safeUnlinkSync(filePath);

  db.run('DELETE FROM novel_chapters WHERE id = ?', [req.params.id]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'novel_chapter', target_id: chapter.id, target_title: chapter.title, detail: '删除小说章节：' + chapter.title, ip: req.ip });
  res.redirect('/admin/novels/edit/' + chapter.novel_id);
});

router.post('/novels/batch-delete-chapters', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  const db = req.db;
  const { ids, novel_id } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的章节' });
  }

  let deletedCount = 0;
  let failCount = 0;

  ids.forEach(id => {
    const chapter = queryOne(db, 'SELECT * FROM novel_chapters WHERE id = ?', [id]);
    if (!chapter) {
      failCount++;
      return;
    }

    const filePath = path.join(__dirname, '../../public', chapter.file_path);
    fsSafe.safeUnlinkSync(filePath);

    db.run('DELETE FROM novel_chapters WHERE id = ?', [id]);
    deletedCount++;
  });

  saveDatabase();

  const novelInfo = queryOne(db, 'SELECT title FROM novels WHERE id = ?', [novel_id]);
  if (novelInfo) {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'delete',
      target_type: 'novel_chapter',
      target_id: null,
      target_title: novelInfo.title,
      detail: '批量删除 ' + deletedCount + ' 个章节（小说：' + novelInfo.title + '）',
      ip: req.ip
    });
  }

  res.json({ success: true, message: '成功删除 ' + deletedCount + ' 个章节' + (failCount > 0 ? '，' + failCount + ' 个失败' : '') });
});

router.post('/novels/reupload-chapter/:id', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  novelUpload.single('chapter_file')(req, res, function(err) {
    if (err) {
      return res.status(400).json({ error: '文件上传失败: ' + err.message });
    }

    const db = req.db;
    const chapterId = req.params.id;
    const chapter = queryOne(db, 'SELECT * FROM novel_chapters WHERE id = ?', [chapterId]);

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    if (!req.file) {
      return res.status(400).json({ error: '请上传TXT文件' });
    }

    const oldFilePath = path.join(__dirname, '../../public', chapter.file_path);
    fsSafe.safeUnlinkSync(oldFilePath);

    const newFilePath = path.join(__dirname, '../../public/uploads/novels', req.file.filename);
    let content = '';
    try {
      content = readTextFileContent(newFilePath);
    } catch (err) {
      return res.status(500).json({ error: '读取文件失败' });
    }

    const relativePath = '/uploads/novels/' + req.file.filename;
    db.run('UPDATE novel_chapters SET file_path=?, content=?, file_size=? WHERE id=?',
      [relativePath, content, req.file.size, chapterId]);

    saveDatabase();
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'novel_chapter', target_id: chapter.id, target_title: chapter.title, detail: '重新上传章节内容：' + chapter.title, ip: req.ip });
    res.redirect('/admin/novels/edit/' + chapter.novel_id);
  });
});

router.post('/novels/delete/:id', isAuthenticated, hasPermission('novels.view'), (req, res) => {
  const db = req.db;
  const novelInfo = queryOne(db, 'SELECT title FROM novels WHERE id = ?', [req.params.id]);

  const chapters = queryAll(db, 'SELECT file_path FROM novel_chapters WHERE novel_id = ?', [req.params.id]);
  chapters.forEach(ch => {
    const filePath = path.join(__dirname, '../../public', ch.file_path);
    fsSafe.safeUnlinkSync(filePath);
  });

  db.run('DELETE FROM novels WHERE id = ?', [req.params.id]);
  db.run('DELETE FROM novel_chapters WHERE novel_id = ?', [req.params.id]);
  saveDatabase();
  if (novelInfo) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'novel', target_id: parseInt(req.params.id), target_title: novelInfo.title, detail: '删除整本小说及其所有章节：' + novelInfo.title, ip: req.ip });
  }
  res.redirect('/admin/novels');
});

module.exports = router;
