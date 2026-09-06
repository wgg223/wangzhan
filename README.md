# Website with Admin（网站管理系统）

一个基于 Node.js + Express + EJS 的网站管理系统，集成前台展示、管理后台、AI 能力（生图/聊天/提示词）与客户端 API 接口层，SQLite 单文件数据库，部署简单、开箱即用。

> 当前版本：v6.0.0 ｜ 许可证：[GPL v3](./LICENSE)

## 功能特性

### 前台功能

- 文章展示与阅读（Markdown 支持），文章附件下载（zip/rar/7z/exe/apk 等 40+ 格式，单文件最大 200MB，分片断点续传）
- 图片分享（上传/浏览/分类/评论/收藏，审核制）
- 小说阅读（章节管理）、诗词游戏（排行榜）
- 用户注册与登录（AJAX 无刷新、失败图形验证码、30 天会话保持、登录后跳回来源页）
- 个人中心（第三方账号绑定：GitHub/微信/QQ/微博/Google）、站内信、实时私信
- 社区动态（关注/粉丝/动态流/内容聚合浏览）
- AI 提示词库（板块/分类/提示词三级结构、思维导图、搜索高亮、一键复制、评论）
- AI 生图（15 家服务商统一适配、图生图、风格预设、提示词优化、异步生成与任务取消、历史记录、一键分享）
- AI 聊天（多模型切换、**填写 API Key 自动获取模型列表**、角色扮演、**角色卡（开场白/性格/场景/示例对话）**、知识库 RAG、长对话记忆与自动摘要、流式输出、会话编辑与重新生成、对话分支、**世界书（常驻注入/多关键词触发/近条扫描）**、个人配额）
- 内容分享链接（图片 / AI 生图 / AI 聊天会话一键生成，无需登录即可查看）
- 用户个人主页、权限申请系统、全文搜索、账号注销

### 管理后台

- 仪表盘数据统计、用户管理（角色/权限/禁用）
- 文章管理（Quill 富文本 + 附件上传）、评论管理（审核/删除）
- 图片分享管理（批量审核/删除/分类/可信用户/评论）
- AI 提示词管理（三级 CRUD + CSV 批量导入导出）
- AI 生图管理（服务商配置、密钥加密存储、每日限额、生成记录）
- AI 聊天管理（模型/角色/知识库/世界书/配额配置）
- 小说管理、项目管理、媒体管理、页面管理、排行榜管理、站内信管理
- 权限管理（细粒度权限控制）、操作日志（多维度筛选）
- 系统设置（基础/SMTP/协议/弹窗）

### 服务器管理

- **备份管理**：完整备份 / 数据库备份 / 配置备份，支持恢复与下载（ZIP）
- **服务器维护**：维护模式一键开关、清除缓存、清理临时文件、优化数据库（VACUUM）、按时间范围清理活动日志、系统信息面板（服务器状态/数据库大小/存储/缓存命中率）
- **系统更新**：从 GitHub 检查更新、自动下载部署、安装前自动备份可回滚、跨平台支持（Windows/Linux）

## 技术栈

- **后端**：Node.js + Express
- **模板引擎**：EJS + express-ejs-layouts（按路径自动切换布局）
- **数据库**：SQLite（优先 better-sqlite3 原生驱动，回退 sql.js WASM）
- **前端**：原生 JavaScript、CSS（变量系统 + 暗色模式）、Quill 富文本编辑器、PWA
- **进程管理**：PM2（生产模式）
- **安全**：bcryptjs、AES-256-GCM 加密、SVG 验证码、TOTP 双因素认证、CSRF 双提交 Cookie、密码强度策略、操作审计
- **AI 能力**：AI 生图（15 家服务商）、AI 聊天（OpenAI 兼容多模型 + RAG 知识库）、AI 提示词优化
- **客户端 API**：`/api/v1` JSON 接口层（Token 鉴权 + 细粒度权限，与网页端共用数据库）

## 项目结构

```
wangzhan-注释版/
├── server/                          # Express 后端
│   ├── app.js                       # 应用入口（中间件栈 + 路由挂载）
│   ├── config/                      # 配置模块
│   │   ├── activity.js              # 操作活动日志
│   │   ├── app-root.js              # 应用路径解析
│   │   ├── cache.js                 # 内存 LRU 缓存
│   │   ├── captcha.js               # SVG 图形验证码
│   │   ├── constants.js             # 项目常量
│   │   ├── crypto-secure.js         # AES-256-GCM 加解密
│   │   ├── database.js              # SQLite 连接管理与编排
│   │   ├── db-dedup.js              # 数据去重
│   │   ├── db-helpers.js            # 查询辅助函数
│   │   ├── db-indexes.js            # 索引创建
│   │   ├── db-schema.js             # 表结构定义与迁移
│   │   ├── db-seed.js               # 默认数据播种
│   │   ├── mailer.js                # SMTP 邮件发送
│   │   ├── monitor.js               # 系统资源监控
│   │   └── tokens.js                # API Token 管理
│   ├── middlewares/                 # 中间件
│   │   ├── activity-logger.js       # 全局操作日志
│   │   ├── api-access-logger.js     # /api/v1 访问日志
│   │   ├── api-auth.js              # API Token 鉴权 + 细粒度权限
│   │   ├── auth.js                  # 认证授权
│   │   ├── maintenance.js           # 维护模式
│   │   ├── rate-limiter.js          # 内存限流器
│   │   ├── security.js              # 安全中间件（CSRF/Origin/Nonce）
│   │   └── upload-protect.js        # 上传目录访问保护
│   ├── routes/                      # 路由
│   │   ├── account.js               # 账号管理
│   │   ├── auth.js                  # 认证（含 OAuth）
│   │   ├── community.js             # 社区互动（关注/通知/动态）
│   │   ├── content.js               # 内容增强
│   │   ├── frontend.js              # 前台页面路由
│   │   ├── image-share.js           # 图片分享
│   │   ├── oauth.js                 # 第三方登录
│   │   ├── permission-applications.js # 权限申请
│   │   ├── poem-game.js             # 诗词游戏
│   │   ├── private-message.js       # 私信
│   │   ├── setup.js                 # 安装向导
│   │   ├── share.js                 # 内容分享链接
│   │   ├── admin/                   # 管理后台路由（30+ 模块）
│   │   └── api/                     # 客户端 API（/api/v1）
│   ├── services/                    # 服务层
│   │   ├── content-security.js      # 内容安全扫描
│   │   ├── prompt-enhance.js        # 提示词优化（LLM + 本地规则兜底）
│   │   ├── two-factor-auth.js       # TOTP 双因素认证
│   │   ├── ai-chat/                 # AI 聊天（provider/记忆/RAG/配额/上下文）
│   │   └── image-gen/               # AI 生图（15 家服务商适配器）
│   └── utils/                       # 工具函数（CSV/文件/日志/设置等）
├── views/                           # EJS 模板
│   ├── admin/                       # 管理后台模板
│   ├── frontend/                    # 前台页面模板
│   ├── auth/                        # 认证模板
│   ├── image-share/                 # 图片分享模板
│   ├── setup/                       # 安装向导模板
│   ├── share/                       # 分享链接模板
│   └── maintenance.ejs              # 维护模式页面
├── public/                          # 静态资源
│   ├── css/                         # 样式（CSS 变量系统，支持暗色模式）
│   ├── js/                          # 前端脚本（含 poems_data.js 诗词题库）
│   ├── assets/                      # 图片资源
│   ├── pwa/                         # PWA（manifest / Service Worker / 图标）
│   ├── uploads/                     # 用户上传文件（含 ai-images / attachments / dynamics）
│   └── vendor/                      # 第三方前端库（Quill）
├── cdn-config.js                    # CDN 静态资源分流配置（运行时被引用）
├── ecosystem.config.js              # PM2 进程配置
├── package.json                     # 项目配置与依赖
├── .env.example                     # 环境变量配置示例
├── .eslintrc.json                   # ESLint 配置
├── AGENTS.md                        # AI 助手指令
├── 部署指南.md                       # 部署指南
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
# 浏览器访问 http://localhost:3000/setup 完成安装向导
```

> 生产环境请使用 `npm run pm2`（PM2 自动设置 NODE_ENV=production 并持久化会话密钥）；`npm start` 仅用于开发。

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

| 页面 | 地址 |
| --- | --- |
| 前端首页 | `http://localhost:3000` |
| 管理后台 | `http://localhost:3000/admin` |
| 图片分享 | `http://localhost:3000/image-share` |
| 诗词游戏 | `http://localhost:3000/poem-game` |
| AI 提示词 | `http://localhost:3000/ai-prompts` |
| AI 生图 | `http://localhost:3000/ai-image` |
| AI 聊天 | `http://localhost:3000/ai-chat` |
| 安装向导 | `http://localhost:3000/setup` |
| 客户端 API | `http://localhost:3000/api/v1` |

## 环境变量

复制 `.env.example` 为 `.env` 并填写实际值（生产环境必填项以 ★ 标注）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | 是 | `development` / `production` |
| `PORT` | 否 | 服务端口，默认 3000 |
| `SESSION_SECRET` ★ | 生产必填 | 会话密钥，至少 32 位随机字符串；`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成 |
| `DATA_ENCRYPTION_KEY` | 否 | 敏感数据加密密钥（SMTP 密码、AI 密钥等），不设置则使用 SESSION_SECRET |
| `SITE_URL` | 否 | 站点 URL（OAuth 回调、邮件链接用） |
| `CDN_ENABLED` / `CDN_BASE_URL` / `ORIGIN_URL` / `CDN_VERSION` | 否 | CDN 静态资源分流（可选） |
| `TRUST_PROXY` | 否 | Nginx 反向代理设为 1，直接暴露设为 0 |

OAuth 第三方登录（GitHub/Google）的 `CLIENT_ID` / `CLIENT_SECRET` 也可在后台「系统设置」中配置。

## 客户端 API（/api/v1）

`server/routes/api/` 提供 JSON 接口层，供客户端应用 / 第三方集成使用，与网页端共用同一数据库、数据实时互通：

- **鉴权**：Token 机制。`POST /api/v1/auth/login` 返回 30 天有效的 Token，后续请求携带 `Authorization: Bearer <token>`；Token 哈希存于 `api_tokens` 表（启动时自动建表），改密后旧 Token 失效。
- **用户端**：注册/登录/资料/改密、文章（列表/详情/评论/点赞）、图片分享（分类/浏览/上传/收藏/评论）、诗词游戏（随机题库/排行榜）、小说（列表/目录/章节）、社区（动态流/关注/点赞/通知）、私信（会话/消息/未读数）、搜索。
- **管理端**（需管理员权限）：仪表盘、用户、文章、评论、图片审核、分类、小说、设置、日志、权限、媒体、备份、维护模式。

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

- **认证与会话**：bcrypt(cost 10) 密码哈希（兼容旧 SHA-256 自动升级）、HTTP-only + SameSite=Lax 会话 Cookie、SESSION_SECRET 持久化、登录失败图形验证码（同 IP 失败 3 次触发）、登录限流、TOTP 双因素认证（可选）
- **权限体系**：三级角色（user/admin/super_admin）+ `user_permissions` 细粒度权限（支持通配符 `articles.*` 与层级 `*.edit.all`）；后台路由逐接口校验；API 管理端与网页端共用同一套权限；统一防越权（不能操作自己/同级/更高级）
- **CSRF 防护**：后台全路由双提交 Cookie 校验（`X-CSRF-Token`/`_csrf`）+ 关键操作 Nonce
- **上传安全**：上传目录访问保护（未授权直链拦截、附件禁静态直链走鉴权下载）、文件类型/大小/路径白名单、分片上传防路径穿越
- **敏感数据加密**：SMTP 密码、AI 服务商密钥、OAuth client_secret 等 AES-256-GCM 加密存储，页面回显掩码
- **高危操作二次确认**：数据重置、备份还原、上传还原均要求重新输入管理员密码
- **审计日志**：全局操作日志中间件 + API 管理端独立审计中间件；备份下载、配置导出等高危操作可追溯
- **接口防护**：`/api/v1` Token 鉴权（SHA-256 哈希存储、30 天 TTL、改密失效）、内容归属校验、`trust proxy` 显式配置防 X-Forwarded-For 伪造
- **系统更新**：仅允许 GitHub 固定仓库来源，更新包完整性校验，安装前自动备份可回滚

## 关键架构说明

- **数据库双驱动**：优先 `better-sqlite3`（原生），回退 `sql.js`（WASM）；启动时自动建表迁移 + 播种默认数据
- **SESSION_SECRET 持久化**：首次启动生成密钥存入 `.session_secret`
- **布局自动切换**：根据路径自动选择前台 / 后台 layout
- **维护模式**：中间件层面实现，开启后前台显示维护页面，后台仍可访问
- **CDN 分流**：`cdn-config.js` 统一处理静态资源域名与版本号，CDN 未启用时自动追加应用版本号做缓存破坏
- **客户端 Token 鉴权**：`/api/v1` 接口使用 Token（SHA-256 哈希存 `api_tokens` 表），与网页端共用同一套权限体系

## 部署

> 完整部署步骤、验证清单与回滚说明见 [部署指南.md](./部署指南.md)。

以 PM2 生产部署为例：

```bash
# 1. 将项目代码上传到服务器（git 拉取 / rsync / scp / 面板上传均可）

# 2. 安装依赖并配置环境
npm install
cp .env.example .env        # 填写 SESSION_SECRET 等必要变量（生产必填）

# 3. 启动（PM2 自动设置 NODE_ENV=production 并持久化会话密钥）
npm run pm2

# 4. 常用运维
npm run pm2:restart         # 重启
npm run pm2:logs            # 查看日志
npm run health              # 健康检查（默认 localhost:3000/health）
```

建议在 Nginx 等反向代理后运行（`TRUST_PROXY=1`），并配置 HTTPS。

## 已清理组件（2026-09）

以下组件已从项目中移除，运行时无需依赖：

| 组件 | 说明 |
| --- | --- |
| `app/`（Flutter 客户端源码） | 服务端零引用，客户端本地构建、不上服务器，已移除 |
| `scripts/`（开发期测试/模拟脚本） | smoke / mock / check 等一次性脚本，已移除 |
| `deploy.py` / `full_check.py` | Python 部署/检查工具，已移除；部署改用上方 PM2 流程 |
| CDN 部署配套（deploy-cdn.*、monitor-cdn.js、nginx-cdn.conf.example） | 部署期工具，已移除；运行时 CDN 能力保留（`cdn-config.js`） |

## 许可证

本项目采用 [GPL v3](./LICENSE)。

## 版本历史

### v6.0.0 (2026-09-07)

**账号注销 + 分享管理 + AI 聊天增强 + Node 24 兼容**
- **注销账号（前台）**：个人中心「安全设置」新增危险操作区，提供注销入口；注销需输入密码、勾选注销协议并输入确认文字，双重确认后账号被永久禁用、无法登录；已绑定邮箱且 SMTP 可用时增加邮箱验证码第二步校验
- **注销安全**：注销流程接入双提交 Cookie CSRF 防护（表单 `_csrf` 令牌 + 服务端会话校验）；超级管理员在注销页以红字明确禁止自行注销
- **后台用户管理**：已自行注销的账号标记「已注销」，管理员无法再启用或禁用，仅可删除（含清理全部关联数据）；注销后登录被拦截
- **Node 24 兼容修复**：SQLite 会话存储 `SqliteSessionStore` 继承 `express-session.Store`（EventEmitter），修复 Node 24 下 `store.on is not a function` 导致的服务无法启动问题
- **分享管理**：前台新增「我的分享」列表（图片/AI 生图/AI 对话分享链接分页管理），支持停用/启用/取消分享；后台新增分享管理（`shares.manage` 权限），可查询、停用、启用、取消全部用户分享链接；取消分享后链接立即失效
- **AI 聊天增强**：世界书支持从默认模板一键导入当前条目（按 key 去重）、会话级知识库（RAG）开关、角色卡创建同名去重（官方/本人角色）

### v5.11.0 (2026-09-07)

**AI 聊天全面优化 + 图片灯箱 + Node 24 兼容修复**
- **模型选择**：新增「填写 API 端点 + Key 后自动获取模型列表」（OpenAI 兼容 `/models`），用户侧与后台均支持一键拉取并选用，编辑已有模型可复用已加密存储的 Key
- **角色卡**：`ai_roles` 新增开场白/性格/场景/示例对话字段；选择角色开新会话（或空会话切换角色）自动注入开场白为第一条 AI 消息；角色上下文组装升级（system_prompt + 性格 + 场景 + 示例对话）
- **世界书**：新增「常驻」开关（忽略触发词始终注入）；触发词支持多关键词（逗号/顿号/分号/空格分隔）与大小写不敏感匹配；扫描范围扩展为最近 6 条消息；列表支持快速启用/停用
- **聊天体验**：助手消息显示模型名标签（SSE 实时回传）、代码块一键复制、流式生成光标、输入框自适应高度、消息入场/弹窗动效、自定义滚动条与焦点可达性优化
- **图片分享**：生成结果支持点击灯箱预览（大图 + 提示词 + 元信息 + 操作按钮）
- **环境修复**：better-sqlite3 升级至 13.0.3，修复 Node 24 下访问登录/注册页面触发原生模块断言崩溃的问题
- 后台角色删除接口修复（补充缺失的 id 参数）

### v5.10.0 (2026-09-06)

**仓库瘦身与工程化整理（2026-09 清理）**
- 移除服务端零引用的 Flutter 客户端源码（`app/`）、开发期脚本（`scripts/`）与 Python 部署工具（`deploy.py` / `full_check.py`）
- 移除 CDN 部署配套（`deploy-cdn.*`、`monitor-cdn.js`、`nginx-cdn.conf.example`），运行时 CDN 静态资源分流能力保留（`cdn-config.js`）
- `.gitignore` 改为白名单模式：默认忽略一切新增文件（运行产物/密钥/临时文件不再可能误上传），`server/` `views/` `public/` 三个源码目录整体放行
- 服务端源码与 EJS 模板全面注释规范化（模块职责总览、路由/中间件说明），README 与部署指南同步重写

### v5.9.3 (2026-08-30)

**AI 聊天：会话级模型切换（端到端）**
- 前台顶栏新增 ⚙️ 模型选择器：每个会话可独立指定模型，弹窗列出「自动选择 / 我的模型 / 站长全局模型」，未配置 Key 的自建模型置灰不可选
- 服务端 `resolveModel` 尊重会话 `model` 字段：按 `model_key` 优先命中用户自建、其次全局模型，未命中或空值回退原有优先级（默认/免费兜底）
- 会话切换模型接口 `/ai-chat/api/conversations/model` 增加模型存在性与启用校验，防止写入无效值
- 发送与重新生成均按会话当前模型执行，切换后立即生效

### v5.9.1 (2026-08-30)

**AI 聊天 Bug 修复**
- 修复流式回复与用户消息内容融合：AI 增量误写入用户消息气泡，改为独立 AI 占位气泡接收流式增量
- 修复连点发送/快速 Enter 导致同一内容重复发送（`state.streaming` 同步置位）
- 修复流式结束后占位气泡残留导致的重复渲染
- ai-chat 页面 JS/CSS 接入 `cdn.getUrl()` 版本号缓存破坏

### v5.9.0 (2026-08-30)

**AI 聊天模块（全新）**
- 前台 AI 聊天页：多模型切换（OpenAI 兼容服务商）、角色扮演（系统提示词预设）、流式输出、会话管理（新建/重命名/删除）
- 对话增强：消息编辑与重新生成、对话分支、世界书（长上下文设定）、长对话自动摘要与记忆、RAG 知识库问答
- 个人配额：每日使用限额、用量统计；后台可配置模型、角色、知识库、世界书与限额
- 分享：AI 聊天会话可生成分享链接，他人无需登录即可查看

**内容分享链接**
- 图片、AI 生图、AI 聊天会话一键生成分享链接（token 制），链接有效性与源内容状态联动，支持停用/删除

**权限与安全专项加固（审计驱动）**
- **CSRF 防护落地**：后台全路由启用双提交 Cookie 校验，admin 所有写操作强制校验 `X-CSRF-Token`/`_csrf`，关键操作（数据重置等）叠加 Nonce
- **API 细粒度权限**：`/api/v1/admin/*` 从角色粗粒度改为逐接口 `apiRequirePermission` 校验，日志删除/权限修改/维护模式切换收紧为仅超级管理员
- **API 管理端审计**：新增 `apiAdminAudit` 中间件，修复 API 管理操作零日志的审计盲区
- **内容版本接口鉴权**：文章/页面版本历史全部增加登录与归属校验，修复匿名可枚举历史全文漏洞
- **附件下载越权修复**：`/admin/attachments/download/:id` 增加归属校验
- **OAuth 密钥加密**：client_secret 改为 AES-256-GCM 加密存储；Google 登录绑定增加 `verified_email` 校验
- **备份安全**：完整备份不再包含 `.env`；备份还原、上传还原增加管理员密码二次确认；配置备份导出剔除敏感字段
- **弱口令策略**：新增 `validatePassword`（长度≥10 + 至少 3 类字符 + Top20 弱口令黑名单）
- **登录限流收紧**：登录尝试阈值由 100 次/分钟下调至 20 次/分钟
- **设置子路由权限对齐**：基础设置/SMTP/协议/弹窗改为 `hasPermission('settings.manage')`
- **其他**：用户主页 API 不再返回角色字段；图片分享批量操作去重；上传目录访问保护中间件

**依赖升级**
- adm-zip 0.5 → 0.6、nodemailer 8 → 9

### v5.8.0 (2026-08-29)

**登录功能全面优化**
- **修复无法绑定第三方账号的 bug**：OAuth 回调新增「绑定」意图识别——已登录用户绑定微信/QQ/微博等账号不再被踢去注册页；已绑他账号时明确提示且不切换账号
- **修复登录表单 AJAX 提交失效**：改用 `URLSearchParams` urlencoded 提交（原 `FormData` multipart 服务端无法解析）
- **OAuth 细节修复**：回调地址优先使用后台配置的 `redirect_uri`（反代/CDN 场景不再因 host 不一致失败）；解绑接口增加 CSRF 校验；删除死路由
- **AJAX 无刷新登录**：字段级内联错误提示 + 按钮加载态；无 JS 环境自动回退传统表单提交
- **登录失败验证码**：同 IP 一小时失败 3 次后动态出现图形验证码
- **修复「记住登录」安全缺陷**：移除 localStorage 明文存密码，改为服务端会话保持（勾选 30 天 / 默认 24 小时）
- **登录后跳回来源页**：`?returnTo=` 参数安全跳转（仅限站内路径）
- **认证页重新设计**：桌面端分屏布局，移动端单栏；主站绿色系 / 图片分享紫色系双主题，支持暗色模式

### v5.7.3 (2026-08-29)

**项目管理更新**
- 新增 **AI 提示词库**（板块/分类/提示词/评论）与 **AI 生图**（生成记录/用户自填 Key）两个模块，后台可见数据统计并支持按项目重置
- AI 生图重置会清理生成记录、用户自填 Key 与生成图片；服务商 API Key 配置不随重置清除
- 全局重置/恢复出厂设置同步覆盖新模块的表；删除顺序按外键依赖子表优先

### v5.7.2 (2026-08-29)

**AI 生图体验优化**
- 提示词库选择弹窗移除 50 条显示上限，支持浏览全部提示词（每页 100 条，「加载更多」分页）
- 弹窗显示「共 X 条 · 已显示 Y 条」计数

### v5.7.1 (2026-08-29)

**Bug 修复**
- 修复发版后浏览器/Cloudflare 缓存旧版 JS 导致 AI 生图报错：静态资源统一追加应用版本号做缓存破坏（`/js/ai-image.js?v=5.7.1`），CDN 未启用时同样生效

### v5.7.0 (2026-08-29)

**AI 生图异步生成与任务取消**
- 生成改为异步任务：立即返回任务 ID，前端轮询状态（解决 Cloudflare 100 秒响应上限问题）
- 生成最长等待 10 分钟，进度条实时显示；60 秒后弹窗询问「继续等待 / 取消任务」
- 取消任务尽力调用服务商取消接口（fal.ai DELETE、Replicate POST cancel）；同步型服务商中断在途请求（AbortSignal）
- 新增接口：`/ai-image/api/status`（状态轮询）、`/ai-image/api/cancel`（取消）；`/ai-image/api/generate` 改为异步返回 `taskId`

### v5.6.2 (2026-08-29)

**Bug 修复**
- 修复 Linux 服务器「系统更新」目录复制失效：`copyDirCrossPlatform` 改用 `cp -r "src/." "dest/"` 内容复制语义；复制失败中止安装并自动回滚；安装后检测嵌套目录（`server/server`）判定失败并回滚

### v5.6.1 (2026-08-29)

**Bug 修复**
- 修复系统更新后服务器未自动重启：PM2 重启命令依次尝试 `pm2 restart website-admin` → `pm2 restart all` → `npx --no-install pm2 restart website-admin`，全部失败退回直接拉起新进程；修复 Windows 下 `spawn('npm')` 找不到 npm.cmd 的问题

### v5.6.0 (2026-08-29)

**AI 提示词模块**
- 前台新增独立深色玻璃拟态页面 `/ai-prompts`：板块→分类→提示词三级结构、思维导图总览、分类卡片、标题搜索高亮、一键复制、Markdown 弹窗查看
- 提示词支持评论（审核制）；后台新增 `/admin/prompts` 图形化 CRUD + CSV 批量导入/导出
- 新增权限：`prompts.view`（前台查看）、`prompts.manage`（后台管理）

**AI 图片生成模块**
- 前台新增 AI 生图页面 `/ai-image`：15 家主流 API 统一适配器（OpenAI DALL·E 3、Stability AI、硅基流动、智谱 CogView、通义万相、文心一格、Pollinations 免 Key、RunningHub、腾讯混元、阶跃星辰、MiniMax、Replicate、火山引擎豆包、fal.ai、AIHubMix）
- 高级选项：seed 种子、图生图参考图、风格预设、提示词优化（LLM 增强 + 本地规则兜底）
- 生成图片本地保存，历史记录分页、下载、一键分享到图片分享（复用审核流程）
- 失败自动换服务商重试；每用户每日限额（默认 20 次，管理员不限）
- 个人中心「AI生图密钥」：用户自填 Key 优先于后台全局 Key（加密存储）
- 后台 `/admin/ai-image`：服务商配置（Key 加密存储、自动获取模型列表）、每日限额与容灾、生成记录管理
- 新增权限：`imagegen.use`（前台使用）、`imagegen.manage`（后台管理）

**其他**
- csrfFetch 统一携带 `X-Requested-With` 标识；豆包默认模型迁移至 seedream-4.0

### v5.5.0 (2026-08-13)

**社区板块优化**
- 社区主页重构：展示全部最新内容（文章、小说、图片、动态），Tab 筛选切换
- 发布动态：登录用户短文本动态，最多 9 张图片上传；动态详情页支持评论、点赞
- 新增 6 个权限（社区访问、动态详情访问、详情访问、发布动态、社区通知管理）；所有活跃用户默认授予详情访问权限
- 修复新建文章页面 JS（~560 行）因 `</script>` 提前关闭而溢出为可见文字的 bug

### v5.4.3 (2026-08-11)

**第三方登录优化**
- 第三方登录新用户改为走注册流程，不再自动创建账号；注册页显示 OAuth 来源提示，预填昵称和邮箱
- OAuth 注册时密码为选填项；注册完成后自动绑定 OAuth 账号

### v5.4.2 (2026-08-07)

**协议功能增强**
- 用户协议和隐私政策拆分为独立勾选框；弹窗 5 秒阅读倒计时；协议版本管理（启动时自动检测更新）

### v5.4.1 (2026-08-07)

**登录协议功能**
- 登录页添加用户协议和隐私政策勾选（仅主站点）；更新协议/隐私政策内容

### v5.4.0 (2026-08-07)

**安全漏洞修复（高危）**
- 附件模块路径穿越修复：移除可执行扩展名白名单，新增路径校验函数，修复 `/upload/cancel` 任意目录递归删除、客户端 file_path 注入、任意文件删除、无鉴权公开下载
- 头像上传存储型 XSS 修复：扩展名白名单限制图片格式，非法扩展名降级 .jpg
- API 用户资料接口任意文件删除修复；EJS onclick 注入 XSS 修复（4 处）
- OAuth GitHub 邮箱未验证自动绑定修复：改用 `/user/emails` API 获取已验证邮箱

**安全漏洞修复（中危）**
- API 登录接口添加图形验证码校验，统一错误消息防用户枚举；密码策略升级至 8 位
- HTML sanitizer 配置加固；私信内容写入净化；评论长度限制 2000 字；邮箱验证码发送限流

**可用性修复**
- ecosystem.config.js Windows 兼容；端口冲突检测与友好提示；请求超时 30 秒保护
- cdn-config.js 移除硬编码域名，默认值改为空；Node.js 引擎要求升级至 >=16.0.0
- 数据库 performSave 改为异步写入；.env.example 补全所有可配置变量；错误页面美化

### v5.3.0 (2026-08-04)

**App 访问数据库日志**
- 新增 `api_access_logs` 表与 `/api/v1` 访问日志中间件；写操作全量记录，GET 按用户+路径 60 秒节流，表超 2 万条自动清理

**服务器运行日志展示**
- `logger.js` 日志落盘 `logs/runtime-YYYYMMDD.log`（按天轮转，5MB 滚动）
- 新增后台页面 `/admin/server-logs`：运行日志筛选/清空、App 访问日志分页、系统信息

**第三方登录优化**
- 修复微信登录 openid 获取错误；同邮箱自动绑定仅限 GitHub/Google（邮箱已验证）；登录后重建 session 防会话固定攻击

**其他**
- better-sqlite3 升级至 13.x（支持 Node 24，恢复原生驱动）；客户端新增主题设置页（注：原 Flutter 客户端已随 2026-09 清理移除）

### v5.2.0 (2026-08-04)

**全站安全审计修复**
- 存储型 XSS（文章正文/站内信接入 HTML 净化）、越权（API 角色修改仅限超管、内容版本回滚仅限作者/管理员）、路径遍历（备份删除/下载白名单）、上传漏洞（扩展名白名单 + mimetype 安全后缀）
- 必崩 Bug 修复 5 处：数据库 PRAGMA 参数缺失、维护模式 SQL 语法错误、数据库恢复顺序错误、邮件发送缺 return、安装向导步骤跳转未定义
- 逻辑修复：限流器状态码判定时机、权限层级匹配过度放权、活动日志「今日」统计窗口、仪表盘媒体统计查错表、查询缓存失效键格式

**重置服务器功能优化**
- 全局重置补全遗漏业务表；恢复出厂设置补全媒体/附件/项目目录文件清理；选择性重置计数修正

**其他**
- 登录页「记住密码」改为「记住用户名」（移除明文密码 localStorage 存储）；删除 62KB 无引用死代码 chat.js；新增 sanitize-html 依赖

### v5.0.0 (2026-08-03)

**客户端 API 接口层**
- 新增 `/api/v1` JSON 接口层（`server/routes/api/`）：Token 鉴权（`api_tokens` 表）、用户端（认证/文章/图片/诗词/小说/社区/私信/搜索）和管理端（仪表盘/用户/文章/评论/图片/分类/小说/设置/日志/权限/媒体/备份/维护）全部接口
- 与网页端共用同一 SQLite 数据库，数据实时互通；原有网页功能不受影响
- 注：同期新增的 Flutter 客户端（`app/`）与接口验证脚本（`scripts/api-test.js`、`scripts/web-smoke-test.js`）已随 2026-09 清理移除，API 接口层保留

### 更早版本（v4.1.0 及以前）

- **v4.1.0** (2026-06-21)：文章附件上传（40+ 格式、200MB、2MB 分片断点续传，屏蔽危险脚本格式）
- **v4.0.1** (2026-06-19)：图片上传 multer 错误处理、友好提示
- **v4.0.0** (2026-06-19)：安全策略放宽、SMTP 配置优化（注：同期 deploy.py/full_check.py 部署工具已随 2026-09 清理移除）
- **v3.7.0** (2026-06-19)：站点统计页面、权限系统优化
- **v3.3.1** (2026-06-19)：系统更新禁止降级安装、更新后自动 npm install 并重启
- **v3.3.0** (2026-06-19)：系统更新日志展示、强制更新、移除 RP-Hub
- **v3.0.0** (2026-06-19)：CSS 变量系统全面重构（暗色模式）、移除 RP-Hub
- **v2.5.0** (2026-06-19)：系统更新分离主项目与 RP-Hub 更新链接
- **v2.4.0** (2026-06-19)：选择性重置（按类型重置数据）、添加 GPL v3 许可证
- **v2.3.0** (2026-06-19)：启动时自动检查 GitHub 更新、后台弹窗提示一键更新
- **v2.2.0** (2026-06-19)：定时备份（Cron）、备份成功邮件通知、集成服务器更新
- **v2.1.0** (2026-06-19)：系统工具集（清缓存/清临时文件/优化数据库/清理日志）、系统信息面板
- **v2.0.0** (2026-06-19)：CSRF Double-Submit 验证漏洞修复、会话/错误处理加固、数据库模块拆分（database.js 拆为 5 文件）
- **v1.0.0**：初始版本发布
