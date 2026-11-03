# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

## v8.10.0 (2026-11-03)

**演示文稿：全功能放映 + 对齐 Office 的编辑、导入与导出**

- 共享渲染层 `PPTScene`：编辑器画布、放映、分享页、嵌入页、打印与 .pptx/.html 导出统一按 960×540 逻辑坐标渲染，同一份文档在任何入口看到的版式、字体、颜色、形状一致
- 放映引擎 `PPTShow`：全屏放映（浏览器拒绝全屏时自动退化为页内铺满）、渐隐/推入/缩放/翻转切页动画、键盘（← → / 空格 / PgUp PgDn / Home End / Enter 跳页 / Esc）+ 单击 + 右键菜单三种翻页、幻灯片编号与进度条、跳页面板（O）、黑屏/白屏（B/W）
- 现场标注：画笔、荧光笔、激光笔、撤销（Ctrl+Z）、一键擦除（E/Ctrl+E），标注跨页保留，演讲结束即清理
- 计时体系：总计时（T）、排练计时（R）逐页记录并写回 `slide.timings`，自动放映可选「优先使用本页排练时长」，支持循环放映与放映范围（全部/当前页起）
- 演讲者视图（S）：独立窗口显示当前页 + 下一页 + 备注 + 计时 + 页列表，与主放映同步翻页与标注
- 隐藏页（放映跳过）与「原第 N 页」编号提示，超链接元素放映期可点击跳转
- 编辑器补齐编辑能力：文本/形状/图片/表格四类元素、6 种版式、旋转与透明度、层级与对齐分布、框选多选、复制粘贴、撤销重做、备注栏、右键菜单、F5 放映 / Shift+F5 演讲者视图
- .pptx 导入增强：图片元素（站内媒体落盘、外链直接引用、格式与总量限额）、表格、形状（带文字的形状按形状导入并保留文字，普通文本框仍按文本导入）、备注、超链接、切页动画、隐藏页、页面背景图
- 导出：`.pptx`（手写 OOXML，含媒体、备注页、超链接关系与切页动画，PowerPoint/WPS 可直接打开）、放映版 `.html`（单文件离线翻页 + 图片内联 data URI + 打印样式）、打印 / 存为 PDF（浏览器每页一图版式，附备注）
- 分享页放映与 `/share/:token/embed` 嵌入视图（无界面、按访问者 IP 水印），分享出去的演示文稿可直接全屏放映
- 修复：放映时跳页/设置面板因 CSS `display` 覆盖 `[hidden]` 长期遮挡画面
- 修复：排练计时丢失最后一页时长、按 R 结束排练时把时长记到上一页
- 修复：新建演示文稿默认模板与 `PPTScene.LAYOUTS` 版式对齐（标题页/标题内容页/章节页），编辑器保存状态不再卡在「加载中…」

## v8.9.3 (2026-11-02)

**修复文档/演示文稿分享不可用；导入支持全部 Office 格式**

- 修复分享：`/share/:token` 按 `spreadsheets.doc_type` 分流渲染，文档与演示文稿不再被当表格打开空白；新增 Univer Docs 只读分享页与演示文稿放映分享页；编辑器分享弹窗按 `{success,data}` 响应结构解析，链接可正常复制
- 导入入口打通：`/office` 与后台「📥 导入文件」弹窗支持 `.xlsx / .xls / .csv / .docx / .pptx / .doc / .ppt`，按扩展名分派创建表格 / 文档 / 演示文稿，导入后直接打开对应编辑器
- `.docx` → Univer Docs：中文样式名（标题 1–6 / Title / Heading N）映射为 `namedStyleType`，保留加粗/斜体/删除线/颜色/字号、项目符号列表与段落层级；表格降级为逐段文本并在提示中说明
- `.pptx` → 演示文稿：EMU 坐标按幻灯片实际尺寸等比换算到 960×540 画布，保留字号（磅）、粗体、对齐、文字颜色与页面背景；图片元素跳过并提示
- 旧版 `.doc / .ppt` 为 OLE 二进制，无纯 JS 解析器：服务器探测到 LibreOffice（`soffice`）时自动先转 `.docx/.pptx` 再导入，未安装时返回可操作的中文提示；`deploy.py` 新增 `DEPLOY_INSTALL_LIBREOFFICE=1` 可选安装
- 上传上限放开：导入体积由 `OFFICE_IMPORT_MAX_MB`（默认 50，范围 1–200）统一驱动 multer 限制与两个弹窗的前端校验/提示文案；>10MB 文档导入即走 `data/office-docs/` 文件存储（新增 `insertDoc` 统一落库）
- 2GB 内存保护：解析器需要整包 Buffer，导入改为同一时刻单任务（并发返回「服务器正在导入其他文件，请稍后重试」）
- 修复中文文件名乱码：busboy 按 latin1 解码 multipart 文件名，新增 `decodeFilename/decodeUploadName` 在落库前转回 UTF-8（同时修正批量导入的表名与描述）
- 导入弹窗错误提示由 `alert()` 改为弹窗内红色提示条，413 附带 Nginx `client_max_body_size` 排查指引

## v8.9.2 (2026-11-02)

**修复 vendor 资源被边缘缓存钉死（v8.9.1 的新包送不到用户手上）**

- 源站 `public/vendor/univer/univer.min.js` 已换成去重后的 13.3MB 新包，线上仍复现 `Identifier "..." already exists` / `Plugin version mismatch`：实测边缘返回的 `Content-Length: 44837997`、`Last-Modified` 与 `ETag` 都指向旧包，且 `Cache-Control: public, max-age=2678400, immutable`
- 根因两层：Nginx 静态 location 对 `.js/.css` 统一下发 `expires 30d + immutable`（Cloudflare 按源站头缓存 31 天），而 vendor 引用 URL 没有版本指纹；`immutable` 让浏览器连 revalidate 都跳过
- 修复：4 个模板的 Univer `index.css` / `univer.min.js` 引用改用既有 `cdn.getUrl()`，自动追加 `?v=<应用版本>`（发版即换缓存键，无需手动刷 CDN；启用 CDN 域名时同时切域名）
- 修复：Nginx 静态分档——`/vendor/*` 指纹资源 365d immutable，图片/字体维持长缓存，普通 `.js/.css` 改由 Node 以 `no-cache` + ETag 提供（304 协商），与 `server/app.js` 既有策略对齐

## v8.9.1 (2026-11-02)

**修复在线Office文档编辑器启动崩溃、头像混合内容**

- 修复文档编辑器打开即崩溃：Univer sheets 预设 `^1.0.0` 与 docs 预设 `1.3.1` 混装出两套核心版本，被同一 bundle 打包两次导致 DI 标识符重复注册（`Identifier "..." already exists`）与致命 `Cannot find "..." registered by any injector`；9 个 preset 全部锁定精确版本 `1.3.1`，构建产物 42.8MB → 13.3MB
- 浏览器实跑验证 docs / sheets 两种预设初始化，控制台无 error/warn，表格编辑器无回归
- 修复 OAuth 头像 Mixed Content：写入前统一 `http://` → `https://`（`server/routes/oauth.js`），存量记录启动时一次性升级（`server/config/db-seed.js`）

## v8.9.0 (2026-11-02)

**在线表格升级为在线Office（文档 + 表格 + 演示文稿）**

- 新增 Univer Docs 在线文档编辑器：多人协同、自动保存（3 秒防抖 + 乐观锁）、版本历史、批注、分享、权限、AI 助手（润色/续写/翻译/总结）
- 新增演示文稿编辑器：幻灯片缩略图导航、文本元素就地编辑、自动保存、协同轮询、版本历史
- 统一入口 `/office`：按类型 + 权限筛选，编辑器按 `doc_type` 自动分发；旧链接 `/spreadsheet` 自动重定向
- 大文件支持：>10MB 文档自动落文件系统（`data/office-docs/`，原子写入），SQLite 仅存路径，最大 500MB
- 数据库新增 `doc_type/doc_file/doc_template/slide_count/word_count` 列（启动幂等迁移）
- 文档结构校验按类型分流（spreadsheet/document/presentation）
- Univer 构建加入 Docs presets 与中文语言包；新增依赖 reveal.js、mammoth
- 后台管理同步：类型列展示、三种类型创建表单
- 部署链路（[部署指南.md](./部署指南.md) 第四节重写）：Nginx 大文件参数（`client_max_body_size` 512m + `client_body_timeout` / `proxy_send·read_timeout` / `proxy_request_buffering`）、`/uploads/` 改为反代到 Node 以启用附件鉴权（仅 `dynamics`、`novels` 保留直读）、`data/office-docs` 与上传子目录创建及权限说明、三层上传上限对照表

## v8.8.2 (2026-11-01)

**全面性能与安全优化（20 项）**

- 安全：CSRF Token 恒时比较（timingSafeEqual）、multipart 强制 CSRF 头校验
- 数据库：预编译语句缓存、设置批量 upsert 事务化、会话存储语句预编译、补充索引
- 内存：限流器独立 Map 与条目上限、LRU 缓存 O(1) 逐出、监控定时器周期重置
- 架构：ai-image.js / two-factor.js 路由拆分、活动日志队列批量落库
- 性能：crypto require 提升、静态请求跳过模板注入、路由匹配预排序

## v8.8.1 (2026-10-23)

**依赖安全加固（高危漏洞清零）**

- 全量依赖安全审计（npm audit，官方 registry）：12 个受影响依赖（1 危急 / 6 高危 / 4 中危 / 1 低危）全部修复，仅剩 quill 1 条低危（CVE-2025-15056，官方无修复版本，属已接受风险）
- 自动修复：express 4.22.2→4.22.3、body-parser 1.20.6→1.20.9、qs 6.15.3→6.16.1、proxy-addr 2.0.7→2.0.8（危急，IPv4-mapped IPv6 信任子网 IP 欺骗）、adm-zip 0.6.0→0.6.1、sanitize-html 2.17.7→2.18.1、follow-redirects 1.16.0→1.16.1、source-map-js 1.2.1→1.2.2 等
- 手动升级（major）：multer 1.4.5-lts.2→2.5.0（修复 CVE-2026-5079 嵌套字段名 DoS、CVE-2026-3304 畸形请求 DoS 等高危）、nodemailer 9.1.1→10.2.1（修复 addressparser 回溯 DoS 等 6 条，需 Node≥20）、xlsx 0.18.5→0.20.3（SheetJS 官方 CDN，修复原型污染 + ReDoS）
- 回归验证：npm audit 复检（12→1）、multer 真实上传 / xlsx 读写回环 / nodemailer 发信管线 / better-sqlite3 原生模块冒烟测试全通过，server 全部路由模块语法检查 0 错误
