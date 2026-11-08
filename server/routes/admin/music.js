/**
 * 音乐播放管理（后台，super_admin）
 *   GET  /admin/music          —— 歌单管理页
 *   POST /admin/music/upload   —— 上传音频（存入 uploads/music）
 *   POST /admin/music/url      —— 添加外链歌曲
 *   POST /admin/music/delete   —— 删除上传/外链歌曲
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { publicDir } = require('../../config/app-root');
const { isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { audioUpload } = require('./upload');
const { buildPlaylist } = require('../music');

router.get('/music', isSuperAdmin, (req, res) => {
  const tracks = buildPlaylist(req.db);
  res.render('admin/music', {
    title: '音乐播放管理',
    tracks: tracks,
    musicDir: path.join(publicDir, 'music')
  });
});

router.post('/music/upload', isSuperAdmin, audioUpload.single('musicFile'), (req, res) => {
  const db = req.db;
  if (!req.file) {
    return res.status(400).json({ error: '请选择音频文件' });
  }
  const title = (req.body.title || '').trim() || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const src = '/uploads/music/' + encodeURIComponent(req.file.filename);
  db.run('INSERT INTO music_tracks (title, src, source_type) VALUES (?, ?, ?)', [title, src, 'upload']);
  saveDatabase();
  logActivity(req.session.user.id, 'music_upload', '上传音乐：' + title);
  res.json({ success: true });
});

router.post('/music/url', isSuperAdmin, (req, res) => {
  const db = req.db;
  const title = (req.body.title || '').trim();
  const url = (req.body.url || '').trim();
  if (!title) return res.status(400).json({ error: '请填写歌曲名称' });
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: '请输入 http(s) 开头的音频直链' });
  db.run('INSERT INTO music_tracks (title, src, source_type) VALUES (?, ?, ?)', [title.slice(0, 100), url, 'url']);
  saveDatabase();
  logActivity(req.session.user.id, 'music_add_url', '添加外链音乐：' + title);
  res.json({ success: true });
});

router.post('/music/delete', isSuperAdmin, (req, res) => {
  const db = req.db;
  const id = parseInt(req.body.id, 10);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const row = queryOne(db, 'SELECT * FROM music_tracks WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: '歌曲不存在' });
  db.run('DELETE FROM music_tracks WHERE id = ?', [id]);
  // 上传的文件顺带删除（限定在 uploads/music 内，防目录穿越）
  if (row.source_type === 'upload') {
    try {
      const rel = decodeURIComponent(String(row.src || '')).replace(/^\/uploads\/music\//, '');
      const file = path.normalize(path.join(publicDir, 'uploads', 'music', rel));
      if (file.startsWith(path.join(publicDir, 'uploads', 'music')) && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) { /* 文件已丢失不影响删除记录 */ }
  }
  saveDatabase();
  logActivity(req.session.user.id, 'music_delete', '删除音乐：' + row.title);
  res.json({ success: true });
});

module.exports = router;
