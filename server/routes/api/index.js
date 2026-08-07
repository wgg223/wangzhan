const express = require('express');

const authRoutes = require('./auth');
const articleRoutes = require('./articles');
const imageRoutes = require('./images');
const poemRoutes = require('./poems');
const novelRoutes = require('./novels');
const communityRoutes = require('./community');
const messageRoutes = require('./messages');
const adminRoutes = require('./admin');
const adminSystemRoutes = require('./admin-system');

const router = express.Router();

// 健康检查（App 启动时探测服务器可用性）
router.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// 数据库可用性检查中间件 — 确保所有 API 路由在 db 不可用时统一返回 503
router.use((req, res, next) => {
  const { getDb } = require('../../config/database');
  if (!getDb()) {
    return res.status(503).json({ error: '数据库暂时不可用，请稍后重试' });
  }
  next();
});

router.use('/auth', authRoutes);
router.use('/', articleRoutes);
router.use('/', imageRoutes);
router.use('/', poemRoutes);
router.use('/', novelRoutes);
router.use('/', communityRoutes);
router.use('/', messageRoutes);
router.use('/admin', adminRoutes);
router.use('/admin', adminSystemRoutes);

module.exports = router;
