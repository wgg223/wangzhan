# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

## v8.8.1 (2026-10-23)

**依赖安全加固（高危漏洞清零）**

- 全量依赖安全审计（npm audit，官方 registry）：12 个受影响依赖（1 危急 / 6 高危 / 4 中危 / 1 低危）全部修复，仅剩 quill 1 条低危（CVE-2025-15056，官方无修复版本，属已接受风险）
- 自动修复：express 4.22.2→4.22.3、body-parser 1.20.6→1.20.9、qs 6.15.3→6.16.1、proxy-addr 2.0.7→2.0.8（危急，IPv4-mapped IPv6 信任子网 IP 欺骗）、adm-zip 0.6.0→0.6.1、sanitize-html 2.17.7→2.18.1、follow-redirects 1.16.0→1.16.1、source-map-js 1.2.1→1.2.2 等
- 手动升级（major）：multer 1.4.5-lts.2→2.5.0（修复 CVE-2026-5079 嵌套字段名 DoS、CVE-2026-3304 畸形请求 DoS 等高危）、nodemailer 9.1.1→10.2.1（修复 addressparser 回溯 DoS 等 6 条，需 Node≥20）、xlsx 0.18.5→0.20.3（SheetJS 官方 CDN，修复原型污染 + ReDoS）
- 回归验证：npm audit 复检（12→1）、multer 真实上传 / xlsx 读写回环 / nodemailer 发信管线 / better-sqlite3 原生模块冒烟测试全通过，server 全部路由模块语法检查 0 错误
