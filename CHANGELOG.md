# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

## v8.12.0 (2026-11-04)

**在线Office 入口、权限审批与分享链路收口**

- 分享页彻底只读化：文档分享不再加载 Univer Docs 编辑器，改用服务端 `renderDocFlow` 排版 + `DocLayout.mountReading` 阅读视图；表格分享不再加载约 14MB 的 Univer Sheets 引擎，改由新增的 `server/utils/sheet-html-renderer.js` 在服务端把快照渲染成静态表格
- 新增公开接口 `GET /share/:token/page-view`（文档）与 `GET /share/:token/sheet-view`（表格），只返回渲染结果，不再下发可编辑快照；`/share/:token/data` 同时移除内部文档 id
- 分享页控件按「仅读」收口：文档只剩字号 / 页宽 / 大纲跳转，表格只剩工作表切换，演示文稿只剩放映 / 翻页；三类分享页统一加上「🔒 只读」徽标与能力说明；保留防复制与访客 IP 水印，公开分享一律不可下载
- 表格渲染安全：单元格文本、合并、列宽行高、隐藏行列表、富文本、数字格式（百分比 / 千分位 / 小数位 / 货币前缀）全部服务端转义；颜色与字体经白名单校验，异常值直接丢弃，避免样式注入
- 权限审批闭环：新增 `GET /api/office/permission/pending`，管理员返回全站待审批申请、普通用户返回自己创建文档的申请；入口页顶部提供待审批面板，可直接通过 / 拒绝（复用 `POST /api/spreadsheet/:id/permission/approve`），提交期间按钮互锁防重复审批
- 无权限页按文档类型改写文案（在线表格 / 在线文档 / 演示文稿），申请权限从只能申请「只读」扩展为可选 查看 / 评论 / 编辑，并回显已提交申请的类型与理由
- 站内通知与审计文案不再统一称「表格」，改按实际类型描述；卡片对已提交申请的文档标注「⏳ 审批中」
- 入口页重构：导航项「表格」改为「在线Office」；页头改为能力条（协同 / 自动保存 / 版本历史 / AI 助手 / 导入导出 / 只读分享 / 权限申请）+ 三类快速新建 + 导入；列表筛选改为带计数的类型分页 + 权限筛选 + 排序（最近编辑 / 创建时间 / 名称）
- 卡片信息架构：按文档类型着色左侧色条与图标底色，权限改为右上角徽标，新增相对时间、类型标签、「（我）」创建者标记
- 修复：新建 / 导入入口此前仅对全局管理权限用户可见，导致拥有 `spreadsheet.access` 的普通登录用户看不到任何创建入口；现按「能进本页即可建自己的文档」展示，后台管理仍只对管理权限可见

## v8.11.1 (2026-11-04)

**线上修复：文档打开即抛「n.find is not a function」**

- 根因：Univer 的 `ResourceManagerService.loadResources` 会对 `snapshot.resources` 直接调 `.find`，而空文档模板 `createEmptyDocument` 与 .docx 导入器把它写成了字符串 `'[]'`；浏览器实测同一份快照：字符串必崩、数组或缺省正常
- 修复：模板与导入器改为输出数组；新增 `normalizeDocResources`，在 `loadDoc` / `insertDoc` / `PUT /api/spreadsheet/:id/doc` 三处统一收敛，旧值若能 JSON 解析则还原内容、否则置为空数组——已入库的旧快照无需数据迁移即可打开，下次保存自然纠正
- 范围：只处理走 Univer 的文档与表格快照；自研演示文稿格式的同名字段含义不同，不参与归一化
- 附带：CSP 增加 `upgrade-insecure-requests`，HTTPS 页面里 `http://` 的第三方头像（如 `thirdqq.qlogo.cn`）不再产生混合内容告警
