# Website with Admin

一个基于 Node.js + Express + EJS 的网站管理系统，包含前端展示和后台管理功能。针对 2 核 2G 服务器优化。

## 技术栈

- **后端**: Node.js, Express.js
- **模板引擎**: EJS + express-ejs-layouts
- **数据库**: SQLite（优先 better-sqlite3，回退 sql.js WASM）
- **前端**: 原生 JavaScript, CSS, Quill 富文本编辑器
- **进程管理**: PM2
- **安全**: bcryptjs, AES-256-GCM 加密, SVG 验证码, TOTP 双因素认证

## 主要功能

### 前端功能
- 文章展示与阅读（Markdown 支持）
- 图片分享（上传/浏览/分类/评论/收藏）
- 小说阅读（章节管理）
- 诗词游戏（排行榜）
- 用户注册与登录
- 个人中心
- 站内信系统
- 实时聊天系统（私信功能）
- 社区动态（关注/粉丝/动态流）
- 用户个人主页
- 权限申请系统
- 搜索功能（文章搜索）
- 账号注销功能

### 管理后台
- 仪表盘数据统计
- 用户管理（角色/权限/禁用）
- 文章管理（Quill 富文本编辑）
- 评论管理（审核/删除）
- 图片分享管理（批量审核/删除/分类管理）
- 小说管理（章节 CRUD）
- 系统设置（基础/SMTP/协议/弹窗）
- 操作日志（多维度筛选）
- 权限管理（细粒度权限控制）
- 站内信管理
- 项目管理
- 排行榜管理
- 媒体管理
- 页面管理

### 服务器管理
- **备份管理**：完整备份/数据库备份/配置备份，支持恢复和下载
- **服务器维护**：维护模式管理 + 系统工具集
  - 维护模式：一键开启/关闭，自定义维护页面标题和消息
  - 清除缓存：清除所有内存缓存（设置/查询/页面缓存）
  - 清理临时文件：清理临时目录和过期日志文件
  - 优化数据库：运行 VACUUM 命令压缩数据库文件
  - 清理活动日志：支持按时间范围清理（7/30/90/180天）
  - 系统信息：显示服务器状态、数据库大小、存储使用、缓存命中率
- **系统更新**：从 GitHub 检查更新，自动下载部署，跨平台支持

## 项目结构

```
mi/
├── server/                          # 后端服务
│   ├── app.js                       # Express 应用入口
│   ├── config/                      # 配置模块
│   │   ├── activity.js              # 操作活动日志
│   │   ├── cache.js                 # 内存 LRU 缓存
│   │   ├── captcha.js               # SVG 图形验证码
│   │   ├── constants.js             # 项目常量定义
│   │   ├── crypto-secure.js         # AES-256-GCM 加解密
│   │   ├── database.js              # SQLite 数据库核心（连接管理与编排）
│   │   ├── db-helpers.js            # 数据库查询辅助函数
│   │   ├── db-schema.js             # 数据库表结构定义与迁移
│   │   ├── db-seed.js               # 数据库默认数据播种
│   │   ├── db-indexes.js            # 数据库索引创建
│   │   ├── mailer.js                # SMTP 邮件发送
│   │   └── monitor.js               # 系统资源监控
│   ├── middlewares/                  # 中间件
│   │   ├── activity-logger.js       # 全局操作日志
│   │   ├── auth.js                  # 认证授权
│   │   ├── maintenance.js           # 维护模式中间件
│   │   ├── rate-limiter.js          # 内存限流器
│   │   └── security.js              # 安全中间件
│   ├── routes/                      # 路由
│   │   ├── auth.js                  # 认证路由
│   │   ├── community.js             # 社区互动 API
│   │   ├── content.js               # 内容增强 API
│   │   ├── frontend.js              # 前端页面路由
│   │   ├── image-share.js           # 图片分享路由
│   │   ├── poem-game.js             # 诗词游戏路由
│   │   ├── setup.js                 # 安装向导路由
│   │   └── admin/                   # 管理后台路由
│   │       ├── index.js             # 管理路由入口
│   │       ├── dashboard.js         # 仪表盘
│   │       ├── articles.js          # 文章管理
│   │       ├── pages.js             # 页面管理
│   │       ├── users.js             # 用户管理
│   │       ├── permissions.js       # 权限管理
│   │       ├── comments.js          # 评论管理
│   │       ├── media.js             # 媒体管理
│   │       ├── novels.js            # 小说管理
│   │       ├── projects.js          # 项目管理
│   │       ├── messages.js          # 站内信管理
│   │       ├── profile.js           # 个人资料
│   │       ├── activity-logs.js     # 操作日志
│   │       ├── leaderboard.js       # 排行榜管理
│   │       ├── image-share.js       # 图片分享管理（含批量操作）
│   │       ├── settings.js          # 网站设置总览
│   │       ├── settings-basic.js    # 基础设置
│   │       ├── settings-smtp.js     # SMTP 设置
│   │       ├── settings-popup.js    # 弹窗设置
│   │       ├── settings-agreement.js# 协议设置
│   │       ├── backup.js            # 备份管理
│   │       ├── maintenance.js       # 维护模式管理
│   │       ├── reset.js             # 重置功能
│   │       ├── system-update.js     # 系统更新（跨平台）
│   │       └── upload.js            # 文件上传配置
│   ├── services/                    # 服务层
│   │   ├── content-security.js      # 内容安全扫描
│   │   └── two-factor-auth.js       # TOTP 双因素认证
│   └── utils/                       # 工具函数
│       ├── error-handler.js         # 统一错误处理（safeLogActivity）
│       ├── file-utils.js            # 文件读取
│       ├── file-validator.js        # 文件验证
│       ├── fs-safe.js               # 安全文件操作
│       ├── image-utils.js           # 图片分享工具
│       ├── logger.js                # 日志工具
│       ├── media-utils.js           # 媒体工具
│       ├── project-utils.js         # 项目工具
│       └── settings.js              # 统一设置查询
│
├── views/                           # EJS 模板
│   ├── admin/                       # 管理后台模板
│   ├── frontend/                    # 前端页面模板
│   ├── auth/                        # 认证模板
│   ├── image-share/                 # 图片分享模板
│   ├── setup/                       # 安装向导模板
│   └── maintenance.ejs              # 维护模式页面
│
├── public/                          # 静态资源
│   ├── css/                         # 样式文件（含 CSS 变量系统）
│   ├── js/                          # 前端脚本
│   ├── rp-hub/                      # （已移除）
│   ├── uploads/                     # 用户上传文件
│   └── assets/                      # 图片资源
│
├── scripts/                         # 部署/运维脚本（Python）
├── package.json                     # 项目配置
├── ecosystem.config.js              # PM2 配置
├── deploy.py                        # 部署脚本（跨平台）
├── AGENTS.md                        # AI 助手指令
└── README.md                        # 本文件
```

## 快速开始

### 环境要求

- Node.js >= 14.0.0
- npm

### 安装

```bash
npm install
```

### 首次运行

```bash
npm run dev
# 访问 http://localhost:3000/setup 完成安装向导
```

### 启动命令

```bash
npm run dev              # 开发模式
npm start                # 同 dev
npm run pm2              # 生产模式（PM2）
npm run pm2:restart      # PM2 重启
npm run pm2:stop         # PM2 停止
npm run pm2:logs         # PM2 日志
npm run health           # 健康检查
```

### 访问地址

- 前端: `http://localhost:3000`
- 管理后台: `http://localhost:3000/admin`
- 图片分享: `http://localhost:3000/image-share`
- 诗词游戏: `http://localhost:3000/poem-game`
- 安装向导: `http://localhost:3000/setup`

## 后台管理功能

### 备份管理 (`/admin/backup`)
- 完整备份：数据库 + 上传文件 + 配置 + 代码
- 仅数据库备份
- 仅上传文件备份
- 仅配置备份
- 恢复备份
- 下载备份（ZIP）
- 删除备份

### 服务器维护 (`/admin/maintenance`)
**维护模式**
- 一键开启/关闭维护模式
- 自定义维护页面标题
- 自定义维护消息
- 开启后前端显示维护页面，后台仍可访问

**系统工具**
- 清除缓存：一键清除所有内存缓存
- 清理临时文件：清理 temp 目录和过期日志
- 优化数据库：VACUUM 压缩数据库，释放空间
- 清理活动日志：按时间范围批量删除旧日志

**系统信息**
- 服务器状态（平台/Node版本/运行时间/CPU/内存）
- 数据库信息（大小/数据表数量）
- 存储空间（上传/备份/临时文件）
- 缓存状态（命中率/大小）

### 系统更新 (`/admin/system-update`)
- 检查 GitHub 最新版本
- 下载并安装更新
- 跨平台支持（Windows/Linux）
- 自动备份当前版本

### 图片分享管理
- 批量审核图片（通过/驳回）
- 批量删除图片
- 批量删除分类（含分类下图片）
- 分类管理（添加/编辑/删除/排序）
- 可信用户管理（免审核）
- 评论管理

## 开发工具

```bash
npm run lint              # ESLint 全量检查
npm run lint:fix          # ESLint 自动修复
npm run lint:server       # 仅检查 server/
npm run lint:frontend     # 仅检查 public/js/
npm run security:audit    # npm 依赖安全审计
npm run security:scan     # 安全扫描
npm run security:full     # 安全审计 + 扫描
```

## 关键架构说明

- **数据库双驱动**: 优先 `better-sqlite3`（原生），回退 `sql.js`（WASM）
- **SESSION_SECRET 持久化**: 首次启动生成密钥存入 `.session_secret`
- **布局自动切换**: 根据路径自动选择 layout
- **全局安全中间件**: 除特定路径外所有请求经过安全校验
- **活动日志**: 全局记录用户行为
- **维护模式**: 中间件层面实现，前端显示维护页面
- **跨平台部署**: deploy.py 支持 Windows 和 Linux

## 部署

```bash
# 完整部署
python deploy.py

# 仅上传文件
python deploy.py --upload-only

# 仅上传变更文件
python deploy.py --upload-changed

# 健康检查
python deploy.py --check
```

## 许可证

本项目采用 [LICENSE](./LICENSE) 文件。

## 版本历史

### v3.0.0 (2026-06-19)

**CSS 架构重构**
- 全面统一 CSS 变量系统，所有页面支持暗色模式
- 修复登录页 auth.css 主题颜色硬编码问题
- 26 个后台页面内联 CSS 统一使用 var() 变量
- 修复首页 CSS 语法错误、style.css 死选择器、novels.ejs 变量名错误
- 将 layout.ejs 约 600 行内联 CSS 移入独立 CSS 文件

**RP-Hub 移除**
- 移除 RP-Hub 角色扮演第三方项目

**服务器维护页面优化**
- 提取公共函数，减少重复代码
- 添加危险操作确认对话框
- 页面加载时自动获取系统信息

### v2.5.0 (2026-06-19)

**系统更新功能增强**
- 分离主项目和 RP-Hub 的 GitHub 更新链接
- 在系统更新页面添加 RP-Hub 更新检查功能
- 修复登录页面 CSS 异常，添加全局重置样式

### v2.4.0 (2026-06-19)

**重置服务器功能增强**
- 新增选择性重置功能，支持按类型重置数据
  - 用户数据：普通用户、权限、关注
  - 内容数据：文章、页面、评论、草稿
  - 媒体文件：上传的图片、文件
  - 社交数据：站内信、通知、点赞、评论
  - 日志数据：活动日志、操作记录
  - 标签数据：标签、标签关联
- 修复 CSS 变量引用错误
- 优化重置页面 UI 和交互体验

**其他改进**
- 优化全局 CSS，删除 utilities.css 中重复的样式定义
- 添加 GNU GPL v3 许可证

### v2.3.0 (2026-06-19)

**自动更新功能**
- 服务器启动时自动检查 GitHub 更新
- 发现新版本后在后台管理页面弹窗提示
- 支持一键自动更新（下载并安装）
- 更新提示只显示一次，用户可选择"稍后提醒"

### v2.2.0 (2026-06-19)

**服务器维护功能增强**
- 新增定时备份功能，支持 Cron 表达式配置
- 备份成功后自动发送邮件通知管理员
- 备份类型可选：数据库/上传文件/配置文件/完整备份
- 集成服务器更新功能（检查更新/下载安装/重启服务器）
- 更新活动日志类型标签

### v2.1.0 (2026-06-19)

**服务器维护功能增强**
- 新增系统工具：清除缓存、清理临时文件、优化数据库、清理活动日志
- 新增系统信息显示：服务器状态、数据库大小、存储空间、缓存状态
- 优化维护页面 UI，使用卡片式工具布局

### v2.0.0 (2026-06-19)

**安全修复**
- 修复 CSRF Double-Submit Cookie 验证漏洞（token 从未被验证）
- 修复 `app.set('layout')` 全局竞态条件，改用 `res.locals.layout`
- 修复 Session cookie 在生产环境未设置 `secure: true`
- 修复 poem-game.ejs 飞花令用户输入 XSS 漏洞
- 修复 poem-game.ejs 排行榜用户名 XSS 漏洞
- 为 chat.js 的 Markdown 渲染添加 HTML 消毒
- 添加 `uncaughtException` / `unhandledRejection` 进程错误处理
- 添加 SIGTERM / SIGINT 优雅关闭逻辑（含数据库关闭）

**代码质量改进**
- 统一设置查询：消除 4 处重复的 `getSettings()` / `getImageConfigs()` 函数，统一到 `server/utils/settings.js`
- 创建 `server/utils/error-handler.js` 提供 `safeLogActivity()` 工具函数
- 数据库模块拆分：`database.js` (1549行) 拆分为 5 个文件
  - `database.js` - 连接管理与编排层
  - `db-helpers.js` - 查询辅助函数 (queryOne, queryAll, generateUid)
  - `db-schema.js` - 表结构定义与迁移
  - `db-seed.js` - 默认数据播种
  - `db-indexes.js` - 索引创建

### v1.0.0

初始版本发布。
