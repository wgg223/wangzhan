# Website with Admin

一个基于 Node.js + Express + EJS 的网站管理系统，包含前端展示和后台管理功能。针对 2 核 2G 服务器优化。

## 技术栈

- **后端**: Node.js, Express.js
- **模板引擎**: EJS + express-ejs-layouts
- **数据库**: SQLite（优先 better-sqlite3，回退 sql.js WASM）
- **客户端 API**: `/api/v1` JSON 接口层（Token 鉴权 + 细粒度权限，供原生客户端使用）
- **前端**: 原生 JavaScript, CSS, Quill 富文本编辑器
- **进程管理**: PM2
- **安全**: bcryptjs, AES-256-GCM 加密, SVG 验证码, TOTP 双因素认证, CSRF 双提交 Cookie 防护, 密码强度策略, 操作审计
- **AI 能力**: AI 生图（15 家服务商）、AI 聊天（OpenAI 兼容多模型 + RAG 知识库）、AI 提示词优化

## 主要功能

### 前端功能
- 文章展示与阅读（Markdown 支持）
- 文章附件下载（支持 zip/rar/7z/exe/apk 等 40+ 种格式，最大 200MB）
- 图片分享（上传/浏览/分类/评论/收藏）
- 小说阅读（章节管理）
- 诗词游戏（排行榜）
- 用户注册与登录（AJAX 无刷新登录、失败图形验证码、记住登录 30 天会话保持、登录后跳回来源页）
- 个人中心（第三方账号绑定/解绑：GitHub/微信/QQ/微博/Google）
- 站内信系统
- 实时聊天系统（私信功能）
- 社区动态（关注/粉丝/动态流/发布动态/内容聚合浏览）
- AI 提示词库（板块/分类/提示词三级结构、思维导图、搜索高亮、一键复制、评论）
- AI 生图（15 家服务商统一适配、图生图、风格预设、提示词优化、异步生成与任务取消、历史记录、分享到图片分享）
- AI 聊天（多模型切换、角色扮演、知识库 RAG、长对话记忆与自动摘要、流式输出、会话/消息编辑与重新生成、对话分支、世界书、个人配额）
- 内容分享链接（图片 / AI 生图 / AI 聊天会话一键生成，无需登录即可查看）
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
- AI 提示词管理（板块/分类/提示词三级 CRUD + CSV 批量导入导出）
- AI 生图管理（15 家服务商配置、密钥加密存储、每日限额、生成记录）
- AI 聊天管理（模型/角色/知识库/世界书/配额配置，服务商密钥加密存储）
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
│   │   ├── api-auth.js              # API Token 鉴权 + 细粒度权限 + 管理端审计
│   │   ├── auth.js                  # 认证授权
│   │   ├── maintenance.js           # 维护模式中间件
│   │   ├── rate-limiter.js          # 内存限流器
│   │   ├── security.js              # 安全中间件（CSRF 双提交 Cookie / Origin 校验 / Nonce）
│   │   └── upload-protect.js        # 上传目录访问保护
│   ├── routes/                      # 路由
│   │   ├── auth.js                  # 认证路由
│   │   ├── community.js             # 社区互动 API（关注/通知/点赞/动态 CRUD）
│   │   ├── content.js               # 内容增强 API
│   │   ├── frontend.js              # 前端页面路由
│   │   ├── image-share.js           # 图片分享路由
│   │   ├── poem-game.js             # 诗词游戏路由
│   │   ├── setup.js                 # 安装向导路由
│   │   ├── share.js                 # 内容分享链接路由（图片/AI生图/AI聊天）
│   │   └── admin/                   # 管理后台路由
│   │       ├── index.js             # 管理路由入口
│   │       ├── dashboard.js         # 仪表盘
│   │       ├── articles.js          # 文章管理
│   │       ├── attachments.js       # 文章附件（分片上传/断点续传）
│   │       ├── pages.js             # 页面管理
│   │       ├── users.js             # 用户管理
│   │       ├── permissions.js       # 权限管理
│   │       ├── comments.js          # 评论管理
│   │       ├── prompts.js           # AI 提示词管理（三级 CRUD + CSV 导入导出）
│   │       ├── ai-image.js          # AI 生图管理（服务商/限额/记录）
│   │       ├── ai-chat.js           # AI 聊天管理（模型/角色/知识库/配额）
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
│   │   └── api/                     # 客户端 API（/api/v1，Token 鉴权）
│   │       ├── auth.js              # 注册/登录/改密
│   │       ├── admin.js             # 管理接口（仪表盘/用户/文章/评论/图片/设置）
│   │       ├── admin-system.js      # 系统管理接口（日志/权限/媒体/备份/维护）
│   │       ├── articles.js          # 文章接口
│   │       ├── images.js            # 图片分享接口
│   │       ├── novels.js            # 小说接口
│   │       ├── community.js         # 社区接口
│   │       ├── messages.js          # 私信接口
│   │       └── poems.js             # 诗词游戏接口
│   ├── services/                    # 服务层
│   │   ├── content-security.js      # 内容安全扫描
│   │   ├── two-factor-auth.js       # TOTP 双因素认证
│   │   ├── prompt-enhance.js        # 提示词优化（LLM 增强 + 本地规则兜底）
│   │   ├── ai-chat/                 # AI 聊天服务（provider/记忆/知识库 RAG/配额/上下文）
│   │   └── image-gen/               # AI 生图（15 家服务商统一适配器）
│   └── utils/                       # 工具函数
│       ├── error-handler.js         # 统一错误处理（safeLogActivity）
│       ├── file-utils.js            # 文件读取
│       ├── file-validator.js        # 文件验证
│       ├── fs-safe.js               # 安全文件操作
│       ├── image-utils.js           # 图片分享工具
│       ├── logger.js                # 日志工具
│       ├── media-utils.js           # 媒体工具
│       ├── project-utils.js         # 项目工具
│       ├── csv.js                   # CSV 解析与导出工具
│       └── settings.js              # 统一设置查询
│
├── views/                           # EJS 模板
│   ├── admin/                       # 管理后台模板（含 prompts/prompt-editor/ai-image/ai-chat）
│   ├── frontend/                    # 前端页面模板（含社区动态详情页、ai-prompts、ai-image、ai-chat）
│   ├── auth/                        # 认证模板
│   ├── image-share/                 # 图片分享模板
│   ├── setup/                       # 安装向导模板
│   ├── share/                       # 分享链接模板
│   └── maintenance.ejs              # 维护模式页面
│
├── public/                          # 静态资源
│   ├── css/                         # 样式文件（含 CSS 变量系统、ai-prompts.css）
│   ├── js/                          # 前端脚本（含 ai-prompts.js、ai-image.js）
│   ├── rp-hub/                      # （已移除）
│   ├── uploads/                     # 用户上传文件（含 dynamics/ 动态图片）
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

> 注意：生产环境必须使用 `npm run pm2`（PM2 会自动设置 NODE_ENV=production 并持久化会话密钥），直接 `npm start` 仅用于开发。

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
- AI 提示词: `http://localhost:3000/ai-prompts`
- AI 生图: `http://localhost:3000/ai-image`
- AI 聊天: `http://localhost:3000/ai-chat`
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
npm run security:check    # 安全配置验证
```

## 安全设计

- **认证与会话**: bcrypt(cost 10) 密码哈希（兼容旧 SHA-256 自动升级）、HTTP-only + SameSite=Lax 会话 Cookie、SESSION_SECRET 持久化、登录失败图形验证码（同一 IP 失败 3 次触发）、登录限流、TOTP 双因素认证（可选）
- **权限体系**: 三级角色（user/admin/super_admin）+ `user_permissions` 细粒度权限（支持通配符 `articles.*` 与层级 `*.edit.all`）；后台路由按 `hasPermission` 逐接口校验；API 管理端与网页端共用同一套权限；`canOperateUser` 统一防越权（不能操作自己/同级/更高级，超管互操作除外）；禁用/删除/降级超管前自动防管理端锁死
- **CSRF 防护**: 后台全路由双提交 Cookie 校验（`X-CSRF-Token`/`_csrf`）+ 关键操作 Nonce，admin 所有写操作强制校验
- **上传安全**: 上传目录访问保护（未授权图片直链拦截、附件/分片禁止静态直链走鉴权下载）、文件类型/大小/路径白名单校验、分片上传防路径穿越
- **敏感数据加密**: SMTP 密码、AI 服务商密钥、OAuth client_secret 等 AES-256-GCM 加密存储（密钥来自 `DATA_ENCRYPTION_KEY`/`SESSION_SECRET`），页面回显掩码
- **高危操作二次确认**: 数据重置（选择性/全局/恢复出厂）、备份还原、上传还原均要求重新输入管理员密码
- **审计日志**: 全局操作日志中间件 + API 管理端独立审计中间件，记录用户/动作/对象/IP/路由；备份下载、配置导出等高危操作可追溯
- **接口防护**: `/api/v1` Token 鉴权（SHA-256 哈希存储、30 天 TTL、改密失效）、内容版本/标签接口归属校验、附件下载归属校验、`trust proxy` 显式配置防 X-Forwarded-For 伪造
- **系统更新**: 仅允许 GitHub 固定仓库来源，更新包完整性校验（版本匹配 + 关键文件存在），安装前自动备份可回滚

## 关键架构说明

- **数据库双驱动**: 优先 `better-sqlite3`（原生），回退 `sql.js`（WASM）
- **SESSION_SECRET 持久化**: 首次启动生成密钥存入 `.session_secret`
- **布局自动切换**: 根据路径自动选择 layout
- **后台安全中间件**: `/admin` 全路由 CSRF 双提交 Cookie 校验（写操作强制携带 `X-CSRF-Token`/`_csrf`），关键操作叠加 Nonce
- **活动日志**: 全局记录用户行为 + API 管理端独立审计
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

### v5.9.0 (2026-08-30)

**AI 聊天模块（全新）**
- 前台 AI 聊天页：多模型切换（OpenAI 兼容服务商）、角色扮演（系统提示词预设）、流式输出、会话管理（新建/重命名/删除）
- 对话增强：消息编辑与重新生成、对话分支（fork/切换/删除）、世界书（长上下文设定）、长对话自动摘要与记忆、RAG 知识库问答
- 个人配额：每日使用限额、用量统计；后台可配置模型、角色、知识库、世界书与限额
- 分享：AI 聊天会话可生成分享链接，他人无需登录即可查看

**内容分享链接**
- 图片、AI 生图、AI 聊天会话一键生成分享链接（token 制），链接有效性与源内容状态联动，支持停用/删除

**权限与安全专项加固（审计驱动）**
- **CSRF 防护落地**：后台全路由启用双提交 Cookie 校验（`security.js` 由死代码变为实际挂载），admin 所有写操作强制校验 `X-CSRF-Token`/`_csrf`，关键操作（数据重置等）叠加 Nonce
- **API 细粒度权限**：`/api/v1/admin/*` 从"角色粗粒度"改为逐接口 `apiRequirePermission` 校验（与网页端 user_permissions 对齐），日志删除/权限修改/维护模式切换收紧为仅超级管理员
- **API 管理端审计**：新增 `apiAdminAudit` 中间件，修复 API 管理操作零日志的审计盲区；管理员删除审计日志需超级管理员权限
- **内容版本接口鉴权**：文章/页面版本历史列表、详情、保存、回滚全部增加登录与归属校验（作者本人/管理员/对应权限），修复匿名可枚举历史全文漏洞
- **附件下载越权修复**：`/admin/attachments/download/:id` 增加归属校验（上传者/管理员/文章作者/`articles.manage` 权限）
- **OAuth 密钥加密**：client_secret 改为 AES-256-GCM 加密存储，页面掩码回显；Google 登录绑定增加 `verified_email` 校验，防止未验证邮箱账号接管
- **备份安全**：完整备份不再包含 `.env`（避免会话密钥/数据加密密钥外泄）；备份还原、上传还原增加管理员密码二次确认；配置备份导出剔除敏感字段
- **弱口令策略**：新增 `validatePassword`（长度≥10 + 至少 3 类字符 + Top20 弱口令黑名单），应用于创建账号、批量导入与 API 建号
- **登录限流收紧**：登录尝试阈值由 100 次/分钟下调至 20 次/分钟
- **设置子路由权限对齐**：基础设置/SMTP/协议/弹窗由角色级 `isAdmin` 改为 `hasPermission('settings.manage')`
- **其他**：用户主页 API 不再返回角色字段；图片分享批量操作去重；内容标签增删增加归属校验；上传目录访问保护中间件（未授权图片直链拦截、附件禁静态直链）

**依赖升级**
- adm-zip 0.5 → 0.6、nodemailer 8 → 9

### v5.8.0 (2026-08-29)

**登录功能全面优化**

- **修复无法绑定第三方账号的 bug**：OAuth 回调新增「绑定」意图识别——已登录用户在个人中心绑定微信/QQ/微博等账号（无邮箱提供商）不再被踢去注册页，直接绑定到当前登录用户；该第三方账号已被他人绑定时明确提示且不切换账号；未登录访问绑定回调自动跳转登录页
- **修复登录表单 AJAX 提交失效**：前端改用 `URLSearchParams` 以 urlencoded 提交（原 `FormData` 发送 multipart 服务端无法解析，导致勾选协议后仍提示"请阅读并同意用户协议和隐私政策"）
- **OAuth 细节修复**：回调地址优先使用后台配置的 `redirect_uri`（反代/CDN 场景不再因 host 不一致导致授权失败）；解绑接口增加 CSRF 校验（双提交 Cookie 模式）；删除无效的 `/oauth/unbind` 死路由
- **AJAX 无刷新登录**：登录改为 fetch 提交，字段级内联错误提示 + 按钮加载态，失败不再整页刷新；无 JS 环境自动回退传统表单提交
- **登录失败验证码**：同一 IP 一小时内登录失败 3 次后，登录表单动态出现图形验证码，防暴力破解
- **修复"记住登录"安全缺陷**：移除 localStorage 明文存密码，改为服务端会话保持（勾选 30 天 / 默认 24 小时），本地仅记忆用户名（旧版存储自动迁移并清除密码）
- **登录后跳回来源页**：支持 `?returnTo=` 参数安全跳转（仅限站内路径，非法值回退默认页）
- **认证页整体重新设计**：桌面端分屏布局（品牌面板 + 表单卡片），移动端单栏；品牌面板展示站点名/描述/ICP 备案；保留全部 6 种模式（登录/注册/忘记密码/改密/改用户名/强制改密）与协议弹窗；修复协议弹窗 `onModalScroll` 未定义报错（滚动到底部启用同意按钮）；主站绿色系 / 图片分享紫色系双主题，支持暗色模式，修复按钮白字对比度与键盘焦点环

### v5.7.3 (2026-08-29)

**项目管理更新**
- 项目管理新增两个模块：**AI 提示词库**（板块/分类/提示词/评论）与 **AI 生图**（生成记录/用户自填 Key），后台可见数据统计并支持按项目重置
- AI 生图重置会清理生成记录、用户自填 Key 与上传的生成图片；**服务商 API Key 配置不随重置清除**，避免误删
- 全局重置（重置全部/恢复出厂设置）同步覆盖新模块的表；删除顺序按外键依赖子表优先

### v5.7.2 (2026-08-29)

**AI 生图体验优化**
- 提示词库选择弹窗优化：移除 50 条显示上限，支持浏览全部提示词（每页 100 条，「加载更多」分页追加）
- 弹窗显示「共 X 条 · 已显示 Y 条」计数，搜索过滤后同样支持浏览全部匹配结果

### v5.7.1 (2026-08-29)

**Bug 修复**
- 修复发版后浏览器/Cloudflare 缓存旧版 JS，导致 AI 生图报「网络错误，请检查连接后重试」的问题
  - 根因：CDN 未启用时静态资源不带版本号，发版后浏览器仍执行旧版 `ai-image.js`，旧版同步逻辑与新版异步接口（返回 `taskId`）不兼容而报错
  - 修复：静态资源（JS/CSS）统一追加应用版本号做缓存破坏（如 `/js/ai-image.js?v=5.7.1`），CDN 未启用时同样生效，且不受后台 `cdn_version` 设置影响

### v5.7.0 (2026-08-29)

**AI 生图异步生成与任务取消**
- 生成改为异步任务：点击生成后立即返回任务 ID，前端轮询状态，不再长时间占用同步 HTTP 请求（解决 Cloudflare 100 秒响应上限导致 RunningHub 等长任务超时的问题）
- 生成最长等待 10 分钟，进度条实时显示已等待时间；**60 秒后弹窗询问「继续等待 / 取消任务」**
- 取消任务会尽力调用服务商取消接口，避免远程资源浪费：fal.ai（DELETE 请求）、Replicate（POST cancel）；RunningHub 平台未开放官方取消接口（仅停止轮询）
- 同步型服务商（OpenAI、硅基流动、智谱、腾讯混元、阶跃星辰、MiniMax、火山豆包、AIHubMix、Stability、文心一格、Pollinations）取消时立即中断在途请求（AbortSignal）
- RunningHub / fal / Replicate / 通义万相 轮询上限提升至 600 秒
- 新增接口：`/ai-image/api/status`（任务状态轮询）、`/ai-image/api/cancel`（取消任务）；`/ai-image/api/generate` 改为异步返回 `taskId`

### v5.6.2 (2026-08-29)

**Bug 修复**
- 修复 Linux 服务器上「系统更新」目录复制失效的问题（v4.3.0 起存在，Windows 不受影响）
  - 根因：`copyDirCrossPlatform` 使用 `cp -r "src" "dest"`，当 dest 已存在时新代码被嵌套复制成 `dest/src`（如 `server/server/`），实际只有 package.json 等单文件被更新，server/views/public 仍是旧代码，且复制失败仅静默告警
  - 修复：Linux 复制改用 `cp -r "src/." "dest/"` 内容复制语义（与 Windows robocopy 一致）
  - 复制失败改为中止安装并自动回滚，不再静默跳过
  - 安装后校验：检测本次更新是否产生 `server/server` 等嵌套目录，存在即判定安装失败并回滚
  - 安装前自动清理历史残留的嵌套目录

### v5.6.1 (2026-08-29)

**Bug 修复**
- 修复系统更新后服务器未自动重启、新版本代码未生效的问题
  - 根因：`doRestart` 依赖子进程 PATH 中的 `pm2` 命令，找不到时静默失败，进程继续运行旧代码
  - PM2 重启命令依次尝试 `pm2 restart website-admin` → `pm2 restart all` → `npx --no-install pm2 restart website-admin`，全部失败退回直接拉起新进程（PM2 autorestart 兜底）
  - 修复 Windows 下 `spawn('npm')` 找不到 npm.cmd 导致兜底重启失败的问题
  - 重启失败时输出明确错误日志，不再静默

### v5.6.0 (2026-08-29)

**AI 提示词模块**
- 前台新增独立深色玻璃拟态页面 `/ai-prompts`：板块→分类→提示词三级结构、思维导图总览、分类卡片、标题搜索高亮、一键复制、Markdown 弹窗查看
- 提示词支持评论（审核制，新增 `prompt_comments` 表）
- 后台新增 `/admin/prompts`：板块/分类/提示词图形化 CRUD、提示词编辑器、CSV 批量导入/导出
- 新增权限：`prompts.view`（前台查看）、`prompts.manage`（后台管理）

**AI 图片生成模块**
- 前台新增 AI 生图页面 `/ai-image`：15 家主流 API 统一适配器架构（OpenAI DALL·E 3、Stability AI、硅基流动、智谱 CogView、通义万相、文心一格、Pollinations 免 Key、RunningHub、腾讯混元、阶跃星辰、MiniMax、Replicate、火山引擎豆包、fal.ai、AIHubMix）
- 高级选项：seed 种子、图生图参考图（按服务商能力开关）、风格预设、提示词优化（LLM 增强，免费接口 + 本地规则兜底）
- 生成图片本地保存，历史记录分页查看、下载、一键分享到图片分享（复用审核流程）
- 失败自动换服务商重试（后台可开关）；每用户每日限额（默认 20 次，管理员不限）
- 个人中心新增「AI生图密钥」：用户自填 API Key 优先于后台全局 Key（加密存储，不显示明文）
- 后台新增 `/admin/ai-image`：服务商配置（Key 加密存储、保存后自动获取模型列表、能力开关）、每日限额与容灾设置、生成记录管理
- 新增权限：`imagegen.use`（前台使用）、`imagegen.manage`（后台管理）
- 新增表：`ai_image_providers` / `ai_image_records` / `ai_image_user_keys`

**Bug 修复**
- 修复后台拒绝权限申请时 SQL 参数顺序错误（reject_reason 误存申请 ID、更新条件误用原因文本）

**其他**
- csrfFetch 统一携带 `X-Requested-With` 标识，服务端据此区分 AJAX 与页面请求
- 豆包默认模型迁移至 seedream-4.0，AIHubMix 服务商升级支持图生图

### v5.5.0 (2026-08-13)

**社区板块优化**
- 社区主页重构：展示全部最新内容（文章、小说、图片、动态），支持 Tab 筛选切换
- 新增发布动态功能：登录用户可发布短文本动态，支持最多 9 张图片上传
- 新增动态详情页：查看动态内容、图片、评论，支持点赞互动
- 新增 `community_posts` / `community_post_comments` 数据库表
- 新增 6 个权限：社区访问、动态详情访问、文章/小说/图片详情访问、发布动态、社区通知管理
- 文章和小说详情页新增权限中间件控制（`articles.detail.access` / `novels.detail.access`）
- 管理员社区通知查询和删除 API（`community.notifications.manage` 权限）
- 所有活跃用户默认授予详情访问权限，发布动态需申请

**Bug 修复**
- 修复新建文章页面 JS 代码（媒体选择器、附件上传等 ~560 行）因 `</script>` 提前关闭而溢出为可见文字的 bug

### v5.4.3 (2026-08-11)

**第三方登录优化**
- 第三方登录新用户改为走注册流程，不再自动创建账号
- 注册页面显示OAuth来源提示，预填昵称和邮箱
- OAuth注册时密码为选填项，邮箱来自第三方时不可修改
- 注册完成后自动绑定OAuth账号

### v5.4.2 (2026-08-07)

**协议功能增强**
- 用户协议和隐私政策拆分为独立勾选框（登录和注册页面）
- 弹窗打开后5秒阅读倒计时，倒计时结束才能点击同意
- 协议版本管理：启动时自动检测并更新协议内容（agreement_version 设置项）

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
