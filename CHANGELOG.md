# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

## v8.17.0 (2026-11-09)

**新增：对话压缩 + 聊天中生图 + 后台提供商下拉 + TTS 设置**

- 对话压缩功能：工具栏 📦 按钮一键压缩历史消息为摘要，节省 token；右侧面板支持自动压缩开关和保留条数设置（4-50条）
- 聊天中生成图片：工具栏 🎨 按钮根据对话场景自动生成图片，先用 LLM 生成英文描述，再调用 Pollinations 免费接口生成
- 后台模型管理添加内置服务商下拉（与前端一致），选择提供商自动填入 API 端点、显示获取密钥链接，编辑已有模型自动匹配
- 修复后台"获取模型"按钮调用错误路由（/ai-chat/api/models/fetch 需前台权限）导致 400 的问题，新增后台专属端点 /admin/ai-chat/api/models/fetch
- 新增 sta1n.ai 内置服务商（api.sta1n.ai/v1）
- TTS 设置整合到右侧面板「记忆」标签页，支持语音选择、语速、音调调节

## v8.16.2 (2026-11-09)

**优化：聊天体验升级 + 上下文压缩 + 后台与前端一致 + sta1n.ai 支持**

- 微信式左右气泡：用户消息靠右、AI 回复靠左，`width: fit-content` 自适应宽度；每条消息显示 token 统计，顶栏显示会话总 token 估算
- 上下文压缩节省 token：长消息（>500 tokens）自动截断并标注；世界书条目按 key+内容前100字去重，超长条目（>2000字）截断
- 后台模型管理添加内置服务商下拉（与前端一致）：选择提供商自动填入 API 端点、显示获取密钥链接，编辑已有模型自动匹配
- 新增 sta1n.ai 内置服务商（`api.sta1n.ai/v1`）

## v8.16.1 (2026-11-09)

**修复：独立页面被误套主站布局（导航栏残留根因）**

- 根因：`express-ejs-layouts@2.5.1` 仅认 render 选项里的 `layout:false`；`res.locals.layout=false` 因 falsy 被 `||` 跳过，中间件的独立布局设置从未生效
- AI 聊天页 `/ai-chat`：render 选项显式 `layout:false`，去除主站导航栏（修复多版本"布局仍未改"反馈）
- 小说阅读器 `/novels/:id` 与章节页：两处 render 加 `layout:false`
- 图片分享站 `/image-share/*`：路由器级中间件统一默认 `layout:false`，保留显式覆盖与回调语义
- IM 私信页 `/chat/:id` 维持套布局（body 片段视图依赖布局提供 HTML/CSS）

## v8.16.0 (2026-11-09)

**新增 + 修复：群聊扩容至 16 人 + 后台世界书导入 + 线上报障修复**

- 群聊成员上限 8 → 16：成员卡上下文注入改为按人数均分总预算（总量封顶 10500 字），8 人及以下行为不变，避免大群撑爆上下文窗口
- 后台默认世界书支持文件导入：兼容 SillyTavern lorebook JSON（entries 对象/数组、位置映射、触发词数组、常驻/禁用）与 Markdown（按标题拆条目），多文件批量上传，按 key 去重
- 修复后台 AI 聊天页内联 JSON 未转义 `<`，预设/模板内容含 `</script>` 时截断脚本引发 `SyntaxError: Unexpected token '&'`
- 修复角色创建/导入遇 429 或错误响应时向角色列表推入 undefined，导致群聊弹窗崩溃（`Cannot read properties of undefined (reading 'id')`）；三处入口加成功守卫
- 角色操作限流 10/分 → 30/分，减少正常操作误触 429
- 修复聊天页静态资源双版本号畸形拼接（`?v=a?v=b`）：改用分隔符感知的缓存破坏，兼容线上旧版 cdn-config

## v8.15.0 (2026-11-09)

**新增：SillyTavern 群聊 + 聊天页体验升级 + 导出权限管控**

- 群聊（Group Chats）：创建 2–8 角色群聊，轮流发言（每轮全员依次回复）/ 手动指定（点击成员头像触发）两种模式
- 群成员条：头像芯片 + 模式标签；消息按说话人显示名字与头像，SSE 上报 speaker 事件
- ST 式群聊上下文：system 声明当前扮演角色、注入其他成员角色卡、其他成员历史发言归入 user 侧带名字前缀
- 聊天页全屏平铺布局，侧栏品牌区改为仅显示登录用户头像与昵称
- 会话重命名：侧栏 ✎ 按钮或双击会话名；服务端标题统一 trim
- 世界书文件导入：支持 .md / .json，兼容 SillyTavern lorebook 格式（触发词数组 / 位置映射 / 常驻 / 禁用 / 排序），按 key 去重
- 聊天记录导入兼容 SillyTavern .jsonl 导出格式（mes / is_user / is_system / character_name）
- 导出独立高危权限 aichat.export：普通用户默认不授予，前端导出按钮按权限隐藏，后台角色卡导出路由同权限受控（走既有高危审批流）
- 后台角色卡管理增强：PNG（SillyTavern 角色卡）/ JSON 导入导出、批量删除、复制、排序移动、头像上传

## v8.14.1 (2026-11-08)

**修复：AI 聊天页全屏显示与会话列表选择**

- 聊天页改为全屏布局：去除外边距与圆角边框，铺满整个视口（不展示顶部导航栏）
- 修复浏览器自动填充用户名进入会话搜索框，导致会话列表被过滤为「暂无会话」、无法选择对话的 bug
- 搜索框改为 type=search 并禁用自动填充；API Key 输入框使用 new-password 阻止凭据自动填充
- 自动填充防护：非聚焦输入事件、加载后残留值自动清空并恢复列表
- 移动端同步全屏布局

## v8.14.0 (2026-11-08)

**重写：AI 聊天 SillyTavern 风格全面升级**

- 右侧设置面板（5 标签页）：角色 / 生成参数 / 世界书 / 记忆 / 高级
- 生成参数滑块：Temperature、Top P、Top K、Frequency/Presence Penalty、Max Tokens，per-conversation 保存
- 生成预设系统：用户私有 + 管理员全局预设，保存/加载/删除
- 提示词模板：支持 {{char}}/{{user}}/{{scenario}}/{{personality}} 变量替换，管理员全局 + 用户私有
- 作者注释（Author's Note）：可配置插入深度，注入上下文指定位置
- 消息滑动（Swipe）：备选回复切换、生成新备选
- 继续生成 / 模仿用户：一键续写 AI 回复或生成用户消息
- 上下文预览：查看实际发送给模型的完整 messages 数组
- 后台新增「生成预设」「提示词模板」管理标签页
- 世界书/记忆/分支/TTS 设置整合进右侧面板，顶栏精简
- 修复聊天记录导入调用未定义函数的 bug

## v8.13.5 (2026-11-08)

**新增：输入区实时 Token 估算**

- 输入消息时实时显示预计消耗 token 数（CJK ≈ 1 token/字，其他 ≈ 4 字符/token）
- 超 2000 tokens 橙色警告，超 4000 红色提示
- 发送后自动清零
- AI 聊天页完全独立化（不依赖主站布局），CSS 变量自包含

## v8.13.4 (2026-11-08)

**修复：角色卡导入中文乱码**

- PNG 角色卡：`extractPngChara` 改用 `TextDecoder('utf-8')` 解码（`atob` 返回 Latin-1 字符串，中文会乱码）
- JSON 角色卡：`readAsText` 显式指定 UTF-8 编码
- URL 抓取：收集 Buffer 后按 Content-Type / HTML meta charset 检测编码，用 iconv-lite 解码 GBK/Latin-1
- 聊天记录导入：`readAsText` 显式指定 UTF-8

## v8.13.3 (2026-11-08)

**AI 聊天全面优化：SillyTavern 风格功能增强**

- 全屏聊天模式：一键切换全屏，ESC 退出，状态持久化到 localStorage
- TTS 语音朗读：基于 Web Speech API，支持音色选择、语速/音调调节、中文语音优先，每条消息独立控制
- 角色卡导入/导出：支持 PNG（SillyTavern tEXt chunk 解析）和 JSON（V2 格式）导入，导出兼容 SillyTavern
- 角色卡头像：创建/导入/导出均支持 avatar 字段，角色列表显示头像
- 角色卡分类筛选 + 收藏：搜索框、分类标签（全部/通用/RP/星铁/写作/我的/收藏），localStorage 持久化收藏
- 聊天记录导出/导入：导出为 JSON 文件，支持导入恢复（新建会话 + 批量插入消息）
- 从外部 URL 抓取角色卡：多策略解析（Next.js __NEXT_DATA__、嵌入 JSON、meta 标签、HTML 提取）
- 世界书优化：搜索过滤、批量启用/禁用/删除、条目计数
- 新增官方角色「昔涟/Cyrene」（崩坏：星穹铁道），完整 ~8000 字角色设定
- 角色卡去重：种子数据改为显式名称去重，清理存量重复官方角色
- 后端字段限制放宽：system_prompt 32000、greeting 2000、description 500、personality/scenario 4000、examples 8000

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
