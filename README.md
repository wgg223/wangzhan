# Website with Admin

一个基于 Node.js + Express + EJS 的网站管理系统，包含前端展示和后台管理功能。针对 2 核 2G 服务器优化。

## 技术栈

- **后端**: Node.js, Express.js
- **模板引擎**: EJS + express-ejs-layouts
- **数据库**: SQLite（优先 better-sqlite3，回退 sql.js WASM）
- **客户端 API**: `/api/v1` JSON 接口层（Token 鉴权，供原生客户端使用）
- **前端**: 原生 JavaScript, CSS, Quill 富文本编辑器
- **进程管理**: PM2
- **安全**: bcryptjs, AES-256-GCM 加密, SVG 验证码, TOTP 双因素认证

## 主要功能

### 前端功能
- 文章展示与阅读（Markdown 支持）
- 文章附件下载（支持 zip/rar/7z/exe/apk 等 40+ 种格式，最大 200MB）
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
- 文章管理（Quill 富文本编辑 + 附件上传）
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
│   │       ├── attachments.js       # 文章附件（分片上传/断点续传）
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
├── .env.example                     # 环境变量配置示例
├── scripts/                         # 部署/运维脚本（Python）
├── package.json                     # 项目配置
├── ecosystem.config.js              # PM2 配置
├── cdn-config.js                    # CDN 加速配置
├── deploy.py                        # 部署脚本（跨平台）
├── AGENTS.md                        # AI 助手指令
└── README.md                        # 本文件
```

## 快速开始

### 环境要求

- Node.js >= 16.0.0
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
- 客户端 API: `http://localhost:3000/api/v1`

## 客户端 API 接口层

服务器新增 `/api/v1` JSON 接口层（`server/routes/api/`），供原生客户端使用，不影响原有网页功能：

- **鉴权**: Token 机制。`POST /api/v1/auth/login` 返回 30 天有效的 Token，后续请求携带 `Authorization: Bearer <token>`。Token 哈希存于 `api_tokens` 表（服务器启动时自动建表）。
- **用户端**: 注册/登录/资料/改密、文章（列表/详情/评论/点赞）、图片分享（分类/浏览/上传/收藏/评论）、诗词游戏（随机题库/排行榜）、小说（列表/目录/章节）、社区（动态流/关注/点赞/通知）、私信（会话/消息/未读数）、搜索。
- **管理端**（需管理员权限）: 仪表盘、用户、文章、评论、图片审核、分类、小说、设置、日志、权限、媒体、备份、维护模式。
- 所有写操作与网页端走同一套数据库表，数据实时互通。

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
- **客户端 Token 鉴权**: `/api/v1` 接口使用 Token（SHA-256 哈希存 `api_tokens` 表），登录后注入 `req.session.user`，与网页端共用同一套权限体系
- **跨平台部署**: deploy.py 支持 Windows 和 Linux

## 部署

> 含 `/api/v1` 接口层的完整部署步骤、验证清单与回滚说明，见 [部署指南.md](./部署指南.md)。

```bash
# 完整部署
python deploy.py

# 仅上传文件（推荐用于日常增量更新；上传后需手动重启 PM2，见部署指南）
python deploy.py --upload-only

# 仅上传变更文件（需本机安装 git）
python deploy.py --upload-changed

# 健康检查
python deploy.py --check
```

## 许可证

本项目采用 [LICENSE](./LICENSE) 文件。

## 版本历史

### v5.4.1 (2026-08-07)

**登录协议功能**
- 登录页面添加用户协议和隐私政策勾选（仅主站点，需同意后才能登录）
- 更新用户协议内容（9条，增加未成年人条款、知识产权条款等）
- 更新隐私政策内容（10条，增加Cookie、未成年人保护、数据权利等）

### v5.4.0 (2026-08-07)

**安全漏洞修复（高危）**
- 附件模块路径穿越修复：移除 .exe/.msi/.apk/.db/.sql 等可执行文件扩展名白名单，新增文件路径校验函数（`isValidAttachmentPath` / `safeResolveAttachment`），修复 `/upload/cancel` 路径穿越（任意目录递归删除）、`/save` `/batch-save` 客户端 file_path 注入、`/delete` `/cleanup` 任意文件删除、`/download` 无鉴权公开下载
- 头像上传存储型 XSS 修复：扩展名白名单限制为 .jpg/.jpeg/.png/.gif/.webp，非法扩展名降级为 .jpg
- API 用户资料接口任意文件删除修复：avatar 字段校验路径格式，旧头像删除前校验路径边界
- EJS onclick 注入 XSS 修复（4 处）：image-share/index.ejs、search.ejs、article-detail.ejs、admin/users.ejs 改用 data 属性 + JS 安全读取
- OAuth GitHub 邮箱未验证自动绑定修复：改用 `/user/emails` API 获取已验证邮箱，未验证邮箱不用于自动绑定

**安全漏洞修复（中危）**
- API 登录接口添加图形验证码校验，统一错误消息防用户枚举
- 密码策略升级至 8 位（auth / api / admin / account 全路径）
- HTML sanitizer 配置加固：移除 iframe/svg/use/style 等高风险标签和 data: scheme
- 私信内容写入时净化（`sanitize(content, {allowedTags:[]})`），防御存储型 XSS
- 评论内容长度限制 2000 字，邮箱验证码发送限流 3 次/5 分钟

**可用性修复**
- ecosystem.config.js Windows 兼容：`mkdir -p` 改为 `node -e "require('fs').mkdirSync(...)"`
- app.js：端口冲突检测（EADDRINUSE 友好提示）、请求超时 30 秒保护、数据库未初始化改 HTML/JSON 响应
- cdn-config.js：移除硬编码域名 `dalaowang233.top`，默认值改为空
- package.json：Node.js 引擎版本从 >=14.0.0 升级至 >=16.0.0，health 脚本跨平台
- monitor.js：check() 添加异常保护，防止定时器静默失效
- database.js：performSave 从同步 IO 改为异步（fs.writeFile + fs.rename），db.run 错误日志移除敏感参数
- .env.example：补全所有可配置环境变量（SESSION_SECRET、DATA_ENCRYPTION_KEY、SITE_URL、PORT 等）
- error.ejs：美化错误页面（图标 + 区分 404/500 + 返回上一页按钮）
- utils.js：Toast 持续时间改为动态计算（根据文本长度 3~8 秒）
- layout.ejs：通知"全部已读"添加错误处理
- 部署指南.md：移除硬编码服务器 IP/域名

### v5.3.0 (2026-08-04)

**App 访问数据库日志**
- 新增 `api_access_logs` 表与 `/api/v1` 访问日志中间件：记录客户端访问数据库的操作（用户/方法/完整路径/状态码/IP/时间）
- 写操作全量记录，GET 按用户+路径 60 秒节流，表超 2 万条自动清理最旧记录

**服务器运行日志展示**
- `logger.js` 增强：日志落盘 `logs/runtime-YYYYMMDD.log`（按天轮转，5MB 自动滚动）
- 新增后台页面 `/admin/server-logs`：运行日志（级别/关键字筛选、多文件切换、清空）、App 访问日志（分页/筛选/清空）、系统信息（内存/CPU/数据库大小）

**第三方登录优化**
- 修复微信登录 openid 获取错误（原误用 client_id）
- 同邮箱自动绑定仅限 GitHub/Google（邮箱已验证），防止账号接管
- 登录后重建 session 防止会话固定攻击；绑定/登录自动同步头像昵称

**其他**
- better-sqlite3 升级至 13.x（支持 Node 24，恢复原生驱动），package.json 增加 allowScripts 批准
- App 端：注册图形验证码接口与用户协议接口，新增主题设置页

### v5.2.0 (2026-08-04)

**全站安全审计修复**
- 存储型 XSS 修复：文章正文与站内信接入 HTML 净化（sanitize-html）并加固输出端转义
- 越权修复：API 用户角色修改仅限超级管理员（防止 admin 自我提权）、内容版本回滚仅限作者/管理员、图片分享设置接口补充权限校验
- 路径遍历修复：备份删除/下载名称白名单校验、重置文件删除增加 public 目录包含防护
- 上传漏洞修复：图片上传扩展名白名单 + 按 mimetype 生成安全后缀（防止 html 等可执行文件落盘被静态托管）
- 必崩 Bug 修复：数据库 PRAGMA 设置参数缺失、维护模式 SQL 语法错误、数据库恢复流程顺序错误、邮件发送缺 return、安装向导步骤跳转未定义
- 逻辑修复：限流器状态码判定时机、权限层级匹配过度放权、活动日志"今日"统计窗口、仪表盘媒体统计查错表、查询缓存失效键格式

**重置服务器功能优化**
- 全局重置补全遗漏业务表（私信/会话/OAuth 绑定/权限申请/文章附件/API Token）
- 恢复出厂设置补全媒体/附件/项目目录文件清理，避免删库后残留孤儿文件
- 选择性重置计数修正、项目下拉防重复、页面结构修正、弹窗回车提交

**其他**
- 登录页"记住密码"改为"记住用户名"（移除明文密码 localStorage 存储）
- 删除 62KB 无引用死代码 chat.js
- 新增 sanitize-html 依赖

### v5.0.0 (2026-08-03)

**安卓 / Windows 客户端 + API 接口层**
- 新增 Flutter 原生客户端（`app/`），同一套代码构建 Android APK 和 Windows 桌面程序
- 新增 `/api/v1` JSON 接口层（`server/routes/api/`）：Token 鉴权（`api_tokens` 表）、
  用户端（认证/文章/图片/诗词/小说/社区/私信/搜索）和管理端（仪表盘/用户/文章/评论/图片/
  分类/小说/设置/日志/权限/媒体/备份/维护）全部接口
- 客户端与网页端共用同一 SQLite 数据库，数据实时互通；原有网页功能不受影响
- 新增接口验证脚本：`node scripts/api-test.js`（37 项端到端测试）与 `node scripts/web-smoke-test.js`

### v4.1.0 (2026-06-21)

**文章附件上传功能**
- 新增文章附件上传系统，支持 exe/zip/rar/7z/apk/pdf/doc/xls/mp3/mp4 等 40+ 种文件格式
- 文件大小上限 200MB，采用 2MB 分片上传，支持断点续传（网络中断后自动重试当前分片）
- 编辑器内拖拽或点击上传，实时显示上传进度和分片状态
- 文章详情页展示附件列表，含文件类型图标、大小、下载次数
- 读者可直接下载附件，自动记录下载次数
- 删除文章时自动清理关联附件文件
- 安全策略：屏蔽 .bat/.cmd/.vbs/.ps1 等危险脚本格式，白名单校验文件扩展名

### v4.0.1 (2026-06-19)

**图片分享上传修复**
- 修复图片上传接口返回 500 错误的问题（multer 错误未被捕获）
- 单文件上传和批量上传均增加 multer 错误处理，返回友好提示
- 文件过大返回 413 + 明确提示，类型不匹配返回 400 + 错误信息
- 参照 admin/media.js 统一错误处理模式

### v4.0.0 (2026-06-19)

**安全策略优化**
- CSP 白名单新增 Cloudflare Insights（`static.cloudflareinsights.com`）
- 放宽频率限制：验证码发送、注册、密码重置等接口限制从 `15分钟/3-5次` 调整为 `1分钟/100次`
- 登录限制从 `15分钟/10次` 调整为 `1分钟/100次`
- API 请求限制从 `1分钟/30次` 调整为 `1分钟/1000次`

**SMTP 配置优化**
- SMTP 密码字段不再预填加密值，改用 placeholder 提示
- 保存配置时若密码为空则保留原值，避免误覆盖
- 前端测试连接时需手动输入授权码

**部署工具修复**
- deploy.py 核心文件列表新增 `cdn-config.js`
- full_check.py 文件对比检查扩展到根目录关键配置文件

### v3.7.0 (2026-06-19)

**站点统计功能**
- 新增站点统计页面，所有登录用户可访问
- 展示用户数量、站点运行时间、内存使用等基本信息
- 显示服务器信息（Node.js版本、平台、CPU架构）
- 新增 `site_stats.view` 权限，默认授予所有活跃用户

**权限系统优化**
- 普通用户访问后台时自动重定向到站点统计页面
- 修复侧边栏重复显示备份管理的问题

### v3.3.1 (2026-06-19)

**系统更新安全增强**
- 添加版本号比对，禁止降级安装（目标版本低于当前版本时拒绝）
- 更新后自动执行 npm install 并重启服务器
- GitHub 仓库地址改为固定常量，移除环境变量覆盖

### v3.3.0 (2026-06-19)

**系统更新功能增强**
- 系统更新页面展示 GitHub 更新日志（最近 10 个版本）
- 添加强制更新功能，支持覆盖安装最新版本
- 更新日志支持 Markdown 渲染，显示版本发布时间
- 当前版本和最新版本在更新日志中高亮显示

**代码清理**
- 移除 RP-Hub 相关代码和 nitron-app 目录
- 清理系统更新路由中的 RP-Hub 相关逻辑

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
