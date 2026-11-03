# Word Office 功能对等实现总结

## 已完成功能（v8.11.0）

### Stage 1: 共享渲染层 ✓
- **doc-renderer.js**: 文档 IR（中间表示）构建器
  - 解析 Univer Docs 快照为统一 IR
  - 支持章节、段落、文本运行、样式
  - 支持自定义块（表格、图片）
  - 支持超链接、脚注、页眉页脚
  - 自动提取目录（TOC）

- **doc-html-renderer.js**: HTML 渲染器
  - 富文本样式（加粗/斜体/下划线/删除线/颜色/字号/字体）
  - 图片内联为 data URI（离线可用）
  - 表格渲染（合并单元格、边框）
  - 超链接渲染
  - 页眉/页脚渲染
  - 页码显示
  - 目录自动生成
  - 脚注渲染
  - 分栏布局支持
  - 列表渲染（有序/无序）
  - 打印优化 CSS（@page 规则）
  - 阅读模式样式

### Stage 2: .docx 导入增强 ✓
- **表格导入**: 解析 HTML 表格，转换为 Univer customBlocks
  - 支持合并单元格（rowspan/colspan）
  - 保留边框样式
  
- **图片导入**: 使用 mammoth 的 convertImage 选项
  - 自动提取图片并保存到 uploads
  - 支持 base64 内联和外部链接
  
- **超链接导入**: 解析 `<a>` 标签
  - 提取链接文本和目标 URL
  - 转换为 customRanges
  
- **样式增强**: 保留更多格式属性
  - 字体、颜色、字号
  - 对齐方式

### Stage 3: .docx 导出增强 ✓
- **表格导出**: 生成 OOXML 表格
  - 支持合并单元格
  - 边框样式
  - 单元格内容格式化
  
- **图片导出**: 嵌入到 docx media 目录
  - 支持 PNG/JPG/GIF/WebP
  - 自动创建关系引用
  
- **超链接导出**: 保留链接关系
  - 生成 hyperlink relationship
  - 应用 Hyperlink 样式
  
- **页眉/页脚导出**: 生成 header/footer XML
  - 默认页眉显示文档名
  - 默认页脚显示页码
  
- **目录导出**: 生成 TOC 域代码
  - 自动检测标题层级
  - Word 中可更新目录
  
- **样式导出**: 完整的 styles.xml
  - 内建标题样式（Title, Heading 1-5）
  - 超链接样式
  - 目录样式

### HTML 导出增强 ✓
- 使用共享渲染层
- 支持所有 docx 导出功能
- 图片内联为 data URI
- 打印优化 CSS
- 阅读模式优化

### Markdown 导出 ✓
- 保留原有功能
- 支持标题层级
- 支持列表
- 支持基本格式（加粗/斜体/下划线/删除线）

### Stage 4: 页面布局视图 ✓

- **真实分页**：`public/js/doc-layout.js` 在 `srcdoc` iframe 内按服务端 `renderDocFlow` 输出的分节几何（纸型、页边距、分栏）实测排版，段落跨页时按行边界二分拆分，保留加粗/颜色/链接等内联样式，不依赖服务端估算
- **页面设置**：`GET/PUT /api/spreadsheet/:id/page-setup`，纸张（A4/A5/B5/Letter/自定义）、纵横方向、四边边距、1–4 栏、起始页码，落到 `documentStyle`；PUT 时写入版本快照并广播 `docReload`
- **防丢配置**：Univer 编辑器回传的快照不含页面设置字段，保存链路调用 `preservePageSetup` 从库里补回，避免一次编辑就清空版面配置
- **页眉/页脚**：布局视图内点击页眉或页脚区域直接编辑，支持 `{PAGE}`/`{NUMPAGES}`/`{SECTION}` 占位符，页脚默认「第 X 页 / 共 N 页」
- **标尺**：Canvas 绘制 cm 刻度并涂出页边距禁区，可开关
- **缩放**：40%–250% 与「适应宽度」，通过 `documentElement.style.zoom` 实现，不影响分页测量
- **未保存预览**：`POST /api/spreadsheet/:id/page-view` 接收编辑器当前快照，改动无需先保存即可看到分页效果
- **打印 / 存为 PDF**：`@media print` 隐藏标尺、页码提示与阴影，每页 `break-after: page`，交由浏览器打印管线输出

### Stage 5: 打印 / PDF 精确分页 ✓

- **打印对话框**：页面视图内「🖨️ 打印 / PDF」弹出选项，可指定页码范围（全部 / 从 X 到 Y）与是否带页眉页脚；范围外的页在打印时整页移除，打印结束（`afterprint`）自动还原视图
- **页码字段动态渲染**：`{PAGE}` / `{NUMPAGES}` / `{SECTION}` 按物理页逐页解析，第 1 页显示「第 1 页 / 共 2 页」，不会所有页都印同一个数
- **服务端 PDF**：`POST /api/spreadsheet/:id/export-pdf`，用无头 Chromium 落盘。打印页由服务端拼装，但**内联的是同一份 `doc-layout.js`**，分页仍由浏览器实测——`@page` 尺寸按页面设置的磅值换算成毫米，PDF 的 MediaBox 与屏幕上的页面盒子等大（实测 A4 输出 594.96 × 841.92 pt）
- **中文字体与文本层**：输出 PDF 内嵌子集字体并带 `ToUnicode`，文字可选中、可搜索，加粗走 `MicrosoftYaHei-Bold`
- **不新增依赖**：Chromium 不随包分发（2 核 2G 服务器装不下），沿用 LibreOffice 的探测模式——`CHROMIUM_PATH` 环境变量或 PATH 里的 `chromium` / `chromium-browser` / `google-chrome` / `microsoft-edge`，命中即用
- **降级不报错**：未安装 Chromium 时返回 501 `NO_BROWSER` 与中文提示，前端自动改走浏览器打印，用户仍能另存为 PDF
- **小服务器保护**：同一时刻只跑一个浏览器实例（并发请求返回 429「服务器正在生成其他 PDF」），`--disable-dev-shm-usage`、独立 `--user-data-dir`、临时目录用完即删，仅 root 运行时才加 `--no-sandbox`

### Stage 6: 阅读视图 + 样式面板 + 目录自动生成 ✓

- **阅读视图**：「📖 阅读」用同一份 `page-view` 数据（`?mode=reading`）在 `srcdoc` iframe 内连续排版，不分页；字号 14–24px、页宽（窄栏 / 标准 / 宽栏 / 自适应）即时生效，可直接打印，样式仍由服务端 readingMode CSS 决定
- **大纲窗格**：`renderOutline` 按 `toc.level` 缩进生成条目按钮，点击调 `instance.goTo(anchor)` 滚动定位并闪动高亮（`.dl-hl` 动画）；`bindScrollTracking` 以 rAF 节流监听滚动，把当前章节同步回窗格高亮。编辑态大纲直接读本地快照（`docHeadings`），不必先保存
- **段落样式面板**：「🎨 样式」左列段落清单（序号 + 预览 + 当前样式），右列「正文 / 标题 1–5 / 大标题 / 副标题」。应用走 `univerAPI.executeCommand('doc.command.set-paragraph-named-style', { value, textRanges })`，`textRanges` 由快照偏移量算出，命令会同时写入 `namedStyleType` 与 `outlineLevel`
- **目录自动生成**：「📑 生成目录」先离屏挂载一次页面视图（`?mode=layout&toc=0`，只渲染文档真实内容，否则目录块自身会把后文顶到下页、页码偏大），用 `instance.anchorPages()` 实测每条标题的页码，再倒序 `insertParagraph(0, …)` 插入「目录」标题与条目；条目按级别 `indentStart` 缩进 18pt/级，并配右对齐点线前导 `tabStops`（偏移 = 页面内容宽度磅值）。再次点击时先用 `deleteRange({ startOffset: 0, endOffset: 末条段尾 + 2 })` 删掉旧块，等价 Word 的「更新域」
- **制表符渲染**：`doc-html-renderer` 把段落里的 `\t` 渲染为 `.doc-tab` 弹性间隔 + 点线前导，段落改用 `display:flex;flex-wrap:wrap`；文本先按 tab 切分再逐段套样式，`<strong>` 等标签不会被劈开，页面视图 / 阅读视图 / 打印 / PDF / HTML 导出共用同一结果
- **快照读取兼容**：Univer 1.3.1 的 `FDocument` 并没有 `getSnapshot`，`extractDocSnapshot` 改走 `save()`，再逐级回退到 `_documentDataModel.getSnapshot()`
- **无段落 id 兼容**：导入器生成的段落不带 id，facade 的 `getText/getInfo/getRange/setStyle/remove` 会抛 `Multiple document paragraphs with id undefined found`；样式与目录一律走「快照偏移量 + 命令 + `deleteRange`」，新建段落的 `setStyle` 仍可直接使用

## 技术亮点

1. **统一 IR 架构**: 所有导出格式共享同一个中间表示，保证一致性
2. **图片内联**: HTML 导出自动将本地图片转为 data URI，实现真正的离线可用
3. **超链接完整支持**: 导入导出都保留超链接关系
4. **表格支持**: 合并单元格、边框样式完整保留
5. **页眉页脚**: 自动添加默认页眉页脚，支持自定义
6. **目录生成**: 自动检测标题并生成 TOC
7. **所见即所得分页**: 布局视图、打印、HTML 导出共用同一份 CSS 与几何，客户端实测代替服务端估算

## 已知限制

- 站内生成的目录是普通段落而非 Word 域，改动正文后需再点一次「📑 生成目录」刷新页码
- 导出的 .docx 里目录是 `TOC` 域代码，重新导入时导入器不跳过 `w:sdt`，域占位文本会作为正文出现（在 Word/WPS 中更新目录后另存不受影响）
- 服务端 PDF 依赖服务器上的 Chromium；未安装时接口返回 501 中文提示，前端自动降级为浏览器打印「另存为 PDF」

## 文件清单

### 新增文件
- `server/utils/doc-renderer.js` - 文档 IR 构建器
- `server/utils/doc-html-renderer.js` - HTML 渲染器（含 `renderDocFlow` 分页数据、制表符点线前导）
- `public/js/doc-layout.js` - 页面布局视图 + 阅读视图（客户端实测分页、锚点页码测量、滚动跟随）
- `public/css/doc-layout.css` - 视图外壳样式（工具栏、大纲窗格、样式面板）
- `server/utils/doc-pdf.js` - 无头浏览器 PDF 导出（探测 + 打印页拼装 + 落盘）

### 修改文件
- `server/utils/office-import.js` - 增强 .docx 导入
- `server/utils/docx-export.js` - 增强 .docx/HTML/Markdown 导出
- `server/utils/spreadsheet-doc-store.js` - 页面设置读写与 `preservePageSetup`
- `server/routes/spreadsheet.js` - `page-view`（`?mode=layout|reading`、`?toc=0`）/ `page-setup` / `export-pdf` 路由
- `public/js/document-editor.js` - 页面视图与阅读视图入口、大纲窗格、段落样式面板、目录生成
- `views/frontend/document-editor.ejs` - 视图容器、工具栏按钮与 API 地址

## 版本信息
- **当前版本**: 8.11.0
- **发布日期**: 2026-11-03
- **主要变更**: Word 文档 Office 功能对等实现（Stage 1-6，全部完成）
