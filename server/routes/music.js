/**
 * 音乐播放前台接口
 * GET /api/music/list —— 合并三个音源的歌曲清单：
 *   1. public/music/ 目录扫描（手动放入的音频文件）
 *   2. 后台上传（uploads/music，music_tracks 表 source_type='upload'）
 *   3. 后台配置的外链（music_tracks 表 source_type='url'）
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { publicDir } = require('../config/app-root');
const { queryAll } = require('../config/database');

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac'];
const DEFAULT_TITLE = '明天会更好';

function scanMusicDir() {
  const dir = path.join(publicDir, 'music');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return files
    .filter(function (f) {
      return AUDIO_EXTS.includes(path.extname(f).toLowerCase()) && !f.startsWith('.');
    })
    .map(function (f) {
      return {
        id: 'file:' + f,
        title: path.basename(f, path.extname(f)),
        src: '/music/' + encodeURIComponent(f),
        source: 'file'
      };
    })
    .sort(function (a, b) { return a.title.localeCompare(b.title, 'zh'); });
}

function dbTracks(db) {
  let rows = [];
  try {
    rows = queryAll(db, 'SELECT id, title, src, source_type FROM music_tracks ORDER BY id');
  } catch (e) {
    rows = [];
  }
  return rows.map(function (r) {
    return { id: 'db:' + r.id, title: r.title, src: r.src, source: r.source_type };
  });
}

function buildPlaylist(db) {
  return scanMusicDir().concat(dbTracks(db));
}

router.get('/list', (req, res) => {
  const tracks = buildPlaylist(req.db);
  res.json({ success: true, data: { tracks: tracks, defaultTitle: DEFAULT_TITLE } });
});

module.exports = router;
module.exports.buildPlaylist = buildPlaylist;
