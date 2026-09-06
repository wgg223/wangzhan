/**
 * API v1 路由聚合入口
 * 作用：挂载 /api/v1 下的全部子路由模块，并提供两个全局能力：
 *   1. /health 健康检查接口（App 启动时探测服务器可用性）；
 *   2. 数据库可用性检查中间件——数据库未就绪时所有 API 统一返回 503，
 *      避免子路由在 db 为 null 时抛出空指针异常。
 * 说明：本文件本身不包含业务逻辑，只做路由装配。
 */

const express = require('express');

// 引入各业务子路由模块
const authRoutes = require('./auth');           // 登录/注册/Token
const articleRoutes = require('./articles');    // 文章
const imageRoutes = require('./images');        // 图片分享
const novelRoutes = require('./novels');        // 小说
const communityRoutes = require('./community'); // 社区
const messageRoutes = require('./messages');    // 私信
const adminRoutes = require('./admin');         // 管理端（用户/文章/图片等）
const adminSystemRoutes = require('./admin-system'); // 管理端（系统设置/备份等）

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

// 挂载子路由（共享 /api/v1 前缀；多个模块挂到 '/' 上按顺序匹配）
router.use('/auth', authRoutes);
router.use('/', articleRoutes);
router.use('/', imageRoutes);
router.use('/', novelRoutes);
router.use('/', communityRoutes);
router.use('/', messageRoutes);
router.use('/admin', adminRoutes);
router.use('/admin', adminSystemRoutes);

module.exports = router;
