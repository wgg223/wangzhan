# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

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
