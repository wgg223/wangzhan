# 更新日志（Changelog）

> 详细版本历史见 [README.md](./README.md)「版本历史」章节。

## v8.31.6 (2026-11-25)

**修复：Seedance 2K 固定比例尺寸协议，真实生成验证通过**

- 根因：请求同时发送 `metadata.resolution` 与 `width/height`；Seedance 会优先使用 `resolution` 并忽略宽高，既无法保证固定比例，也可能触发上游网关异常
- 修复：固定比例仅发送精确宽高，`auto` 比例才发送画质档位；2K 图生图 `auto` 保持模型自适应；所有请求携带明确 `User-Agent`
- 防重复计费：已提交任务的失败保留 task_id 与原始 `fail_reason`，不再按尺寸错误自动重提；`Invalid IP address: undefined` 增加上游网关排查提示
- 验证：Seedance 模拟回归 136 项、MomoAPI 61 项、HTTP 集成 8 项、安全下载 10 项全部通过；真实 Seedance 任务 `task_5jAgP4Ca6R63d8bM6yOdv5nDyNdeoV1W` 返回 SUCCESS，实际 PNG 为 2048×1152，最终实扣 ¥0.1157

## v8.31.5 (2026-11-25)

**回退 gpt-image 模型名改写：直接使用 Key 的 /v1/models 原始模型名**

- 现象：把 `gpt-image-2` 改写成 `gpt-image-2-ratio_4k` 后，网关报 `only imagen models are supported`（模型不存在，回落到同步端点只列 imagen）
- 根因：Momo 网关只认 Key 的 `/v1/models` 里返回的 id，`-2k/-4k/ratio_*` 只是插件目录里的选择值，不是 API 模型名；擅自改名会被判不支持
- 修复：`resolveApiModel` 改为原样返回用户选择的模型名，画质完全由 `size` + `quality` 控制（与插件实际 apiModel 行为一致）
- 验证：模型映射 6/6 PASS——gpt-image-2 的 1K/2K/4K、图生图、banana、seedream 均保持原始模型名；Seedream JSON 7/7、Momo 协议 5/5 回归通过；ESLint 0 error

## v8.31.4 (2026-11-25)

**Momo「扣款但没图」：任务创建后不再重复提交同步接口，失败信息带 task_id**

- 现象：Momo 控制台出现扣款记录，但站点没拿到图
- 根因：异步任务提交后如果轮询返回失败/空结果，旧逻辑会**再发一次同步请求**——同一张图可能被提交两次（多扣一次），而且已经创建成功的异步任务被直接丢弃
- 修复：对齐插件行为——**任务一旦创建（拿到 task_id）就只轮询、不再回退同步**；只有提交阶段失败（404/405/不支持/未返回任务）才回退同步
- 失败信息现在带 `task_id`（如 `MomoAPI 异步任务失败：empty task data（task_id: task_xxx）`），生成记录里可直接拿去和 Momo 控制台/客服核对退款
- 验证：mock 网关 5/5 PASS——异步任务失败时错误含 task_id、**不再触发第二次同步提交**、4K 模型映射保持；模型映射 7/7 回归通过；ESLint 0 error

## v8.31.3 (2026-11-25)

**Momo 失败信息保留两段原因（异步退款 / 同步拒绝），便于区分网关限制与代码问题**

- 现象：`seedream-5.5 2048x1152` 报 `Invalid IP address: undefined`，而同时段 gpt 记录报 `only imagen models are supported`——两者其实分别是「异步任务空结果退款后回退同步」与「同步端点模型白名单限制」
- 修复：`submitWithAsyncFallback` 在同步接口也失败时，把异步阶段的失败原因拼进最终错误（`（异步阶段：…）`），生成记录里能同时看到两段
- 说明：Momo 侧当前对非 imagen 模型的限制/异步通道故障，属于服务商状态，客户端无法绕过；换 Key/分组或改用其他服务商即可
- 验证：Momo 协议 8/8 回归通过；`node --check` 通过；ESLint 0 error

## v8.31.2 (2026-11-25)

**修复 Momo gpt-image 全部失败：按插件目录的「画质即模型」规则映射 model id**

- 根因：Momo 的 gpt-image-2 按画质拆成**不同模型**（插件静态目录）：
  `gpt-image-2-ratio_1k` / `gpt-image-2-ratio_2k` / `gpt-image-2-ratio_4k`。
  我们一直发基础名 `gpt-image-2` + 4K 尺寸，上游拿不到可用通道 → 异步任务空结果、Momo 自动退款（`empty task data`）
- 修复：Momo 适配器新增 `resolveApiModel()`，按请求尺寸（长边 1K/2K/4K）自动换 model id：
  - `gpt-image-2` → 1K 保持基础名（已验证可用），2K/4K 换 `gpt-image-2-ratio_2k` / `gpt-image-2-ratio_4k`（已是 ratio 后缀的按尺寸重算）
  - `[官流]gpt-image-2`、`gpt-image-2.5/2.6-*` 保持原 model
  - gemini / nano-banana 的 `-2k/-4k` 选择值会还原成基名（插件 apiModel 规则）
  - seedream 保持原 model，继续走 generations JSON
- 验证：mock 网关 6/6 PASS——4K gpt-image-2 → `gpt-image-2-ratio_4k`（t2i 与 i2i 都是）、2K → `ratio_2k`、banana 4K → 基名、banana 后缀选择值 → 基名、seedream 不变；Seedream 7/7 回归通过；ESLint 0 error

## v8.31.1 (2026-11-25)

**修复 Momo Seedream「异步任务 empty task data 退款」：按插件改用 generations JSON + image dataURL**

- 现象：Momo 控制台 `seedream-5.5` 异步任务提交 3 秒后即「异步任务退款」，失败原因 `empty task data`，站点拿不到图
- 根因：Seedream 在 Momo 上不是 multipart `/v1/images/edits`，而是 **`/v1/images/generations`（JSON）**，参考图以 **dataURL 字符串**放在 `image` 字段（插件 `buildMomoSeedreamRequest` 同款）。适配器之前对所有模型都用 edits multipart，Seedream 的上游解析不到图，任务结果为空
- 修复：Momo 适配器新增 Seedream 专用请求体
  `{ model, prompt, n:1, response_format:'url', output_format:'png', background:'auto', size, image: dataURL|dataURL[] }`
  走 `/v1/images/generations?async=true`，失败/空结果仍自动回退同步接口；gpt-image 系列保持 multipart edits
- 验证：mock 网关 7/7 PASS——Seedream 图生图走 generations JSON、模型名保留、`response_format=url`、`output_format=png`、`image` 为 dataURL、无 multipart 字段、任务轮询出图；模型切换 4/4、Momo 协议 8/8 回归通过；ESLint 0 error

## v8.31.0 (2026-11-25)

**后台 AI 生图服务商支持批量启用/停用**

- 服务商网格上方新增批量操作条：**全选 / 已选 N 个 / 批量启用 / 批量停用**；每张站点卡片头部新增勾选框（全选支持半选态）
- 后端新增 `POST /admin/ai-image/providers/batch-enabled`：接收 `provider_keys[]` + `enabled`，一次更新多个站点，返回更新数量并写操作日志（批量启用/停用站点）
- 批量执行后即时同步各卡片的「启用」勾选与顶部「已启用」统计，无需整页刷新；未勾选时给出提示
- 验证：隔离实例 8/8 PASS——批量条与勾选框渲染、CSRF 校验通过、批量停用 2 个站点、批量启用 2 个站点、空选择 400；`node --check` 通过；ESLint 0 error

## v8.30.4 (2026-11-25)

**修复后台「AI 聊天管理」把整段 JS 当文本显示（脚本被注释里的 </scr+ipt> 截断）**

- 根因：`views/admin/ai-chat.ejs` 内联 script 的注释里写了字面量 `</script>`，HTML 解析器不理会 JS 注释，到此就结束脚本，后面的 `截断） var adminProviders = [...]` 全部作为页面文本输出
- 修复：改写注释措辞，不再出现脚本闭合标签；并全量扫描 `views/**/*.ejs` 确认没有同类问题（其余都是正常的 `<script src=...></script>`）
- 验证：隔离实例渲染 `/admin/ai-chat`，`var adminProviders = [...]` 回到脚本内、页面无原始 JS 文本泄漏

## v8.30.3 (2026-11-25)

**修复「改过默认模型又被改回 gpt-image-2」：同步模型时保留后台设置的默认模型**

- 根因：Momo 适配器的 `selectDefaultModel` 在每次「保存 Key / 验证连接 / 同步模型」时都会重新挑默认模型，且**优先 Imagen、其次 gpt-image-2**，完全忽略后台已配置的 `default_model` → 用户改成 seedream 后一保存就被改回 gpt-image-2，画布/基础页自然又用 gpt
- 修复：
  1. `selectDefaultModel` 改为**优先保留 currentModel**（只要它仍在模型列表里），Imagen/gpt 排序只作为没有配置时的兜底
  2. 基础生图页 `renderModels` 保留用户当前已选模型（仍在校验列表内时不再重置为默认模型）
  3. 画布 `renderModels` 原本已保留上一次选择，行为一致
- 验证：`selectDefaultModel([seedream-5.5, gpt-image-2], 'seedream-5.5') → seedream-5.5`；`'gpt-image-2' → gpt-image-2`；空/失效值才回退 gpt-image-2；ESLint 0 error

## v8.30.2 (2026-11-25)

**Momo 异步任务被退款（任务失败/空结果）时自动改走同步接口**

- 现象：Momo 控制台出现「消费 → 同秒退款 / 异步任务退款」的记录，异步任务在服务端直接失败，客户端拿不到图
- 处理：`submitWithAsyncFallback` 不再只在 404/405/empty task data 时回退——异步任务返回 `PROVIDER_FAILED / EMPTY_RESPONSE / BAD_RESPONSE`（含退款场景）也会**改发同步接口再试一次**；同步仍失败才向上抛错，并继续走「4K→2K→1K」尺寸降级
- 验证：mock 网关 5/5 + 模型切换 4/4 全部通过；ESLint 0 error

## v8.30.1 (2026-11-25)

**修复「切换模型后仍然用 gpt-image-2」：去掉跨请求的模型偏好记忆，尊重显式选择**

- 根因：
  1. Momo 适配器有跨请求的「模型偏好记忆」——某次 seedream 失败自动换到 gpt-image-2 后，会把 gpt 记住 10 分钟，之后即使再选 seedream 也继续打 gpt
  2. `resolveProviderModel` 对不在模型列表里的显式选择会静默回退到 `default_model`（gpt-image-2）
- 修复：
  1. 删除模型偏好记忆（`preferredModel / rememberPreferredModel / modelPreferences`），**每次请求都以用户选中的模型为第一次尝试**；换模型只发生在「本次请求内部」的重试
  2. `resolveProviderModel` 改为尊重用户显式选择的模型：不在列表里也不再静默替换，只打一条警告并照常提交（列表过期/自定义模型场景）
- 验证：mock 网关 4/4 PASS——首次 seedream 503 会自动换 gpt 成功；**第二次请求 seedream 时确实重新打 seedream**；Momo 协议 8/8 保持；ESLint 0 error

## v8.30.0 (2026-11-25)

**RunningHub 工作流自动获取并复用（对齐 TTAI 插件）**

- 新增 `server/services/image-gen/runninghub-workflow.js`，把插件里两个「自动获取」逻辑搬过来：
  1. **appId → workflowId**：只填应用 ID 时，依次尝试 `GET /api/webapp/apiCallDemo?apiKey&webappId|webAppId|appId` 与 `POST /api/webapp/apiCallDemo`，递归扫描响应任意层级里的 `workflowId/workflowids`（6 位以上数字，兼容 JSON 塞在字符串字段里的情况）
  2. **workflowId → 工作流 JSON**：`POST /api/openapi/getJsonApiFormat`（兼容 `/openapi/getJsonApiFormat` 与 `workflow_id` 参数写法）拉取 API 格式图结构
  3. **自动识别 prompt 节点**：优先 `CLIPTextEncode/TextEncode/Prompt` 且 `inputs.text` 的节点，其次任意带 `inputs.text/prompt` 的节点
- `runninghub` 适配器集成：`api_path` 可写 `/run/workflow/<appId>`（自动反查真实 workflowId）；`模型` 字段可留空由工作流 JSON 自动识别，仍支持手填 `6:text` 覆盖；解析结果缓存 10 分钟
- **验证**：mock RunningHub 4/4 PASS——appId 反查成功并提交到 workflowId、拉取 getJsonApiFormat、自动识别 node 6/text 且 nodeInfoList 带 prompt、提交体正确
- 说明：插件本地 ComfyUI 工作流存于 localStorage `nb_comfyui_workflow`（映射文件路径），本机未配置；本站 ComfyUI 适配器读取工作流文件，如需从插件目录批量导入，可再补一个扫描脚本

## v8.29.2 (2026-11-25)

**修复 Momo 异步任务返回 empty task data 时直接失败：轮询路径 + 同步回退**

- 现象：Momo 控制台显示 `gpt-image-2` 异步任务已计费后退款，失败原因 `empty task data`（任务 ID `task_4Z1YkY...`），站点侧拿不到图
- 反混淆核对：插件轮询的是 `GET /v1/images/{generations|edits}/{taskId}`（不是 `/v1/images/tasks/{id}`），且 `isMomoAsyncUnsupportedError` 明确把 **empty task data / 404 / 405** 视为「异步不可用」，随即回退**同步接口**重发
- 修复：
  1. 轮询路径改为优先 `/v1/images/{generations|edits}/{id}`，`/v1/images/tasks` 仅作最后候选
  2. 异步提交与轮询统一走 `submitWithAsyncFallback()`：遇到 empty task data / 404 / 405 / 无图完成，自动改发同步接口（`/v1/images/generations`、`/v1/images/edits`）再解析
  3. 图生图 multipart 去掉 `n` 字段（与插件字段完全一致：model/prompt/size/quality/image）
- 验证：mock 网关 5/5 PASS——异步文生图轮询 `/v1/images/generations/{id}` 出图、异步图生图返回 empty task data 后自动回退 `edits` 同步并出图、quality 透传、4K 尺寸保持

## v8.29.1 (2026-11-25)

**按插件协议对齐其余模型 API：WaveSpeed 改用画质关键词 + 比例，画质/比例全平台透传**

- **WaveSpeed**：按插件 `buildOfficialCloudImageRequest` 重写请求体——`{ prompt, resolution:'1k|1.5k|2k', aspect_ratio, output_format:'png', background:'auto', images:[dataURL] }`，不再发像素 `size`；参考图以 data URL 数组传入（插件同款）；服务商上限从 4K 收紧到 2K（官方只有 1K/1.5K/2K 三档）
- **统一画质/比例**：`sizes.js` 新增 `qualityKeyword()` 与 `aspectRatioOf()`，生图主流程把 `quality`/`aspectRatio` 透传给所有适配器（WaveSpeed/MiniMax/Seedream/Momo 都能按各自协议取用）
- **已核对无需改动的平台**（与插件行为一致）：Seedance/新贞贞（metadata：resolution + width/height）、豆包（OpenAI 兼容 size）、MiniMax（aspect_ratio + response_format）、硅基流动/智谱/通义/文心/混元/阶跃/AIHubMix/GrsAI/T8Star（标准 OpenAI 兼容）、RunningHub（workflowId 工作流已实现）
- **未实现的平台**（插件有、本站没有对应入口）：即梦 Jimeng（依赖启动器桥）、柏拉图 Plato、BizyAir、Midjourney 任务流
- **验证**：WaveSpeed mock 5/5 PASS——请求体含 `resolution=2k`、`aspect_ratio=16:9`、无像素 size、images 为 data URL；Momo 协议 8/8 PASS 保持；`node --check` 通过；ESLint 0 error

## v8.29.0 (2026-11-25)

**按 TTAI 插件反混淆结果重写 MomoAPI 调用协议：异步任务 + 质量档位 + 逐模型分辨率表**

- **反混淆**：用 webcrack 还原插件 26MB 主包（→3.4MB 可读），拿到 Momo 的真实协议
  - 站点获取：`MOMO_BASE_URL_MAP = { main: api.momoapi.icu, backup1: api1.momoapi.icu, backup2: api2.momoapi.icu }`，按主站→备用1→备用2 自动探测
  - 调用方式：文生图 `POST /v1/images/generations?async=true`（JSON），图生图 `POST /v1/images/edits?async=true`（multipart），字段 `model / prompt / n / size / quality`（部分模型加 `background`）
  - 工作流（异步队列）：提交拿 `task_id` → 轮询 `GET /v1/images/tasks/{id}`，网关不支持 async 时回退同步接口
  - 分辨率：`getGptImage2OfficialRatioSize` 的 13 种比例 × 1K/2K/4K 表（16:9 4K=3840×2160、1:1 4K=2880×2880、4:3 4K=3264×2448…）；seedream 仅 1K/1.5K/2K；wavespeed 1K/1.5K/2K
- **我方修复**：Momo 适配器改为 `?async=true` + `/v1/images/tasks/{id}` 轮询（原来只轮询 generations/edits，且不带 async，正是「调用成功但拿不到图」的原因）；请求补 `quality=auto`；失败自动回退同步
- **分辨率表**：`sizes.js` 增加 Momo gpt-image-2 的比例×画质表（4K 恢复可用，不再被压到 1536）；seedream 在 Momo 上限 2K；OpenAI/兼容站的 gpt-image 仍限制 1024/1536
- **验证**：mock 网关 8/8 PASS——异步文生图轮询出图、异步图生图轮询出图、async 不支持时回退同步、请求带 quality、gpt-image 4K 横/竖不降级、4:3 4K 按插件表映射 3264×2448、dall-e 仍限制 1792×1024

## v8.28.3 (2026-11-25)

**修复 MomoAPI「API 调用成功但没有图」：异步图片任务轮询 + 响应结构兼容**

- 诊断：Momo 控制台日志显示 seedream-5.5 走的是**异步接口**（提交即计费成功），而适配器只处理同步图片返回，拿不到图就报「未返回图片数据」；gpt-image-2 也有部分返回结构与旧解析不匹配
- 新增异步任务支持：提交后若返回体无图片且有 `task_id`/`id`，自动轮询 `GET /v1/images/generations/{id}`（不可用则回退 `/v1/images/edits/{id}` 并记住可用路径），3 秒一次、最长约 8 分钟，支持取消；识别 SUBMITTED/IN_PROGRESS/SUCCESS/FAILED 等状态
- 响应解析兼容多种结构：`data[]`、`data.data[]`、`images[]`、`output[]`、`result[]`、单对象 `url/b64_json`；仍解析不到时错误信息带上响应形状（`keys=… data=… itemKeys=…`），下次失败可直接在生成记录里看到返回结构
- 验证：本地 mock 网关 4/4 PASS——同步模型直接出图、异步模型轮询 2 次后出图、异步图生图走 `/v1/images/edits/{id}` 出图、缺 task id 时错误信息包含响应形状；`node --check` 通过；ESLint 0 error

## v8.28.2 (2026-11-25)

**修复 MomoAPI 4K 图生图仍失败：把 Invalid IP 纳入尺寸降级并跳过无意义的换模型重试**

- 诊断：换用 `[yu]gemini-nano-banana-2.1` 后 4K 仍报 Invalid IP，说明不是 gpt-image 独有，而是 Momo 的 4K 图生图通道本身会以该错误拒绝；此前该错误走的是「换模型重试」，换几个模型都还是 4K，必然连续失败
- 修复：Momo 适配器遇到 Invalid IP 时给错误打 `sizeFallback` 标记并**直接上抛**，由 `generateImage` 的既有降级阶梯自动重试 **4K → 2K → 1K**；`isSizeFallbackError` 识别该标记
- 效果：4K 请求不再直接失败，会自动用 2048×1152（或 1024×576）出图，并在完成提示里注明「已按模型/服务商能力生成 …」
- 验证：mock 网关（>2048 返回 Invalid IP，≤2048 正常）5/5 PASS——4K 被拒且错误带标记、`isSizeFallbackError=true`、2K 正常出图、降级阶梯为 `3840x2160 → 2048x1152 → 1024x576`
- 说明：Momo 若要真 4K，建议改用其 `seedream-5.5`（支持 4K）或火山豆包 seedream 4.0

## v8.28.1 (2026-11-25)

**修复 MomoAPI gpt-image 系列 4K 图生图失败：模型级尺寸上限**

- 诊断：同一 Key + 同一上传路径下，1024×1024 图生图成功、3840×2160 连续失败并返回误导性的「Invalid IP address: undefined」——说明不是上传/网络问题，而是 gpt-image 系列模型不接受 4K 尺寸，网关把上游的尺寸错误包装成了 IP 错误
- 新增**模型级尺寸上限**（`sizes.js` 的 `MODEL_LIMITS`）：命中模型规则时优先于服务商上限
  - `gpt-image-*` → 仅 1024×1024 / 1536×1024 / 1024×1536（按横竖方向就近映射）
  - `dall-e-*` → 1024×1024 / 1792×1024 / 1024×1792
  - `imagen*` → 最长边 2048
  - `seedream` 等不受影响，4K 照常
- 预设映射改为「同方向 + 比例最接近」的通用算法（原来写死 1792/1024 候选，换成新预设表后会误退成方形）
- 生成结果提示改为「已按模型/服务商能力生成 1536×1024」，让降级不再静默；MomoAPI 的 Invalid IP 文案补充尺寸/模型提示
- 验证：`resolveSizeForProvider` 断言——momoapi+gpt-image-2+3840×2160 → **1536×1024**（adjusted）、2160×3840 → 1024×1536、momoapi+seedream-5.5+3840×2160 → 3840×2160、imagen → 2048×1152、dall-e-3 → 1792×1024/1024×1792；`node --check` 通过；ESLint 0 error

## v8.28.0 (2026-11-25)

**画布新增「生成历史」面板：历史结果可一键插回画布**

- 画布顶部条新增「生成历史」按钮，弹窗分页展示（9 条/页）当前账号的生成记录：缩略图、提示词、服务商 · 模型 · 尺寸、成功/失败状态；点击缩略图可看大图
- 每条记录支持 **插入画布**：由画布引擎新增的 `addImageNode()` 在视口中心插入 Image 节点，并带上 prompt / provider / model / size 元数据，可直接作为下一轮参考图或右键「按此参数重新生成」
- 支持 **复制提示词**（navigator.clipboard，降级 execCommand）与分页（上一页 / 下一页 / 共 N 条）
- 数据复用 `/ai-canvas/api/history`，与基础生图页共用 `ai_image_records` 表，无需新表；失败记录显示「生成失败」且插入按钮禁用
- 验证：隔离实例 `/ai-canvas/api/history` 返回 19 条真实记录、字段齐全；页面渲染出「生成历史」按钮；`node --check` 通过；ESLint 0 error；EJS 编译渲染通过

## v8.27.3 (2026-11-25)

**修复 MomoAPI 图生图失败：Invalid IP address: undefined（chunked multipart 被网关拒绝）**

- 根因：图生图用 `form-data` + 文件流上传，axios 会发 `Transfer-Encoding: chunked`；手工加的 `content-length` 与 chunked 同时出现时，New API 网关解析失败并返回“Invalid IP address: undefined”
- 修复：改为**先读入 Buffer、自建 multipart**（与 TTAI 插件固定长度上传的做法一致），显式设置 `Content-Length`，并用 `transformRequest: (d) => d` 禁止 axios 二次转换，彻底不再走 chunked
- 顺带：参考图 MIME 以魔数为准（PNG/JPG/WebP/GIF/BMP/AVIF/TIFF），参考图空/超限给出明确错误；Invalid IP 的错误文案改为可操作提示（模型通道不支持图生图时换 imagen / gpt-image-2）
- 验证：本地 mock New API 网关（对 chunked 请求返回同样的 Invalid IP 错误）8/8 PASS——不再出现 chunked、Content-Length 与 body 长度一致、multipart 含 model/prompt/image 字段且 MIME 正确、返回图片解析成功
- 说明：模型轮询与 `Invalid IP` 的模型回退逻辑保持不变；若换固定长度上传后仍报该错误，说明该模型渠道未开放图生图，需换模型

## v8.27.2 (2026-11-25)

**生图尺寸改为「比例 + 画质」模型（对齐 TTAI 插件的 pkRatio / pkQuality）**

- 尺寸不再只是一串固定像素：新增比例（自适应 / 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 5:4 / 4:5 / 21:9）与画质档位（1K=1024 / 2K=2048 / 4K=3840 长边），由比例×画质推导具体像素，短边自动取 16 的倍数
- 画布底栏改为「比例 + 画质」两个下拉，画质选「自定义宽 × 高」时出现 64–4096 的宽高输入；旧像素下拉保留为隐藏兼容值，历史节点/偏好仍能恢复
- 基础生图页尺寸下拉升级为 1K/2K/4K/兼容 四组，选项带比例与像素（如「16:9 · 1024 × 576（1K 横屏）」），原有全部尺寸继续可用
- 服务端 `/ai-canvas/api/generate` 与 `/ai-image/api/generate` 支持 `ratio`/`quality` 参数，优先级：自定义宽高 > 比例×画质 > 直接 size；最终仍按服务商上限降级并回报 `effectiveSize` / `sizeAdjusted`
- 服务商尺寸上限继续生效：同一 16:9 4K 请求，Pollinations 会降为 2048×1152，Momo/Seedance 保持 3840×2160
- 验证：隔离实例实测 16:9 1K → 1024×576、16:9 4K → 请求 3840×2160 / 实际 2048×1152（sizeAdjusted=true）、21:9 2K → 2048×880；bootstrap 下发 11 种比例、3 档画质、完整矩阵；两个页面均渲染新选项；`node --check` 通过；ESLint 0 error

## v8.27.1 (2026-11-25)

**画布内新增「API 密钥 / 余额」面板**

- 画布顶部条新增「API 密钥」按钮，弹窗按服务商列出：Key 配置状态（我的 Key / 后台全局 Key / 未配置）、保存、查余额、清除
- 保存 Key 走 `/ai-canvas/api/keys/save`：自动验证 Key、同步模型列表（并调用画布 `syncProviders` 即时生效）、顺带回显余额；查不到余额只提示，不影响保存
- 新增 `/ai-canvas/api/keys/balance`：用当前用户 Key（缺省回退后台全局 Key）查询余额，按适配器能力返回；未配置 Key / 服务商未开放计费接口时给出明确文案
- `/ai-canvas/api/bootstrap` 的 provider 增加 `has_user_key` / `has_global_key` / `supports_balance` / `supports_models`（只暴露布尔值与来源，**绝不回显 Key 明文**）
- 验证：隔离实例实测——无 Key 查询余额返回「请先配置 API Key」、空 Key 保存 400、伪 Key 保存成功且余额接口返回网关鉴权文案、查询/清除接口正常；`node --check` 通过；ESLint 0 error

## v8.27.0 (2026-11-25)

**画布独立通道：/ai-canvas 页面与 API 从基础生图页拆分 ｜ 服务端项目 + 协作 + 自定义分辨率 + 多参考图 + 更多格式**

- **独立通道**：新增 `server/routes/ai-canvas.js` 与 `views/frontend/ai-canvas.ejs`，页面 `/ai-canvas`、接口 `/ai-canvas/api/*` 自成一套；基础页 `/ai-image` 移除内嵌画布，改为「进入创作画布 →」入口，两套生成逻辑不再互相牵连
- **能力对齐**：画布 API 覆盖基础页全部能力——生成 / 状态轮询 / 取消 / 历史 / 我的 API Key（含验证、模型同步、余额）/ 提示词优化；服务商、模型、尺寸、数量、种子、风格、负向提示词完全一致
- **服务端项目**：新增 `ai_canvas_projects`（state/thumbnail/version/updated_by）、`ai_canvas_members`、`ai_canvas_presence` 三张表；画布改动 1.2s 防抖保存到服务端，带乐观锁（版本不一致返回 409 + 最新状态），页面重开/换设备不丢
- **协作**：创建者可邀请成员（可编辑 / 只读），可开启只读分享链接（`/ai-canvas?share=TOKEN` 自动加入）；2.5s 轮询版本同步他人改动，实时显示他人光标与在线状态
- **自定义分辨率**：尺寸下拉新增「自定义宽 × 高」，64–4096、自动取 8 的倍数，最终按服务商上限降级并回报实际尺寸
- **多参考图**：单次最多 4 张参考图；Seedance（images 数组）与豆包（image 数组）声明支持多图，其余服务商只取第一张并在结果里用 `referenceLimited` 提示，避免误以为全部生效
- **更多文件格式**：上传支持 JPG/PNG/WebP/GIF/BMP/AVIF；GIF/BMP/AVIF 在前端转 PNG 后再上传/生成；服务端魔数校验补 TIFF/HEIC/AVIF 识别；参考图上传接口 `/ai-canvas/api/uploads` 供协作项目共享素材
- **验证**：隔离副本 + 伪造管理员会话实测——页面 200 且注入 `AI_CANVAS_CONFIG`、项目创建/读取/保存/409 冲突/版本、在线状态读写、上传接口、自定义 1280×720 生成任务真实出图（Pollinations）、多参考图与非图生图服务商校验、非法尺寸拒绝；`node --check` 11 文件通过；ESLint 0 error；两个 EJS 模板编译渲染通过
- **修复画布显示异常**：① `/ai-canvas` 被主站布局包裹（顶部出现站点导航）→ 渲染时显式 `layout:false` + 布局中间件改用 `startsWith('/ai-canvas')` 双保险；② 引擎 `.aic` 自带 `height:100%` 叠加在 `top:48px` 上，画布整体多出 48px、底部工具条被挤出可视区 → 页面用 id 覆盖为 `height:auto/min-height:0` 并锁定 body 不滚动；③ `.aic-btn{display:inline-flex}` 覆盖了 `hidden` 属性，导致「简洁表单」等本应隐藏的按钮仍显示 → 注入 `.aic [hidden]{display:none!important}`

## v8.26.1 (2026-11-25)

**优化：MomoAPI 节点余额（New API 计费接口）+ 保存 Key 即显示余额 ｜ 前台/后台余额联动**

- **momo 余额按真实计费协议查询**（`providers/momoapi.js`）：`GET /v1/dashboard/billing/subscription`（hard_limit_usd）+`GET /v1/dashboard/billing/usage`（total_usage 单位“分”），剩余 = 总额度 − 已用；结果 60 秒缓存，401/403 明确报鉴权失败，计费接口缺失时回退 OpenAI 兼容探测，都没有则返回 null 且不影响生图
- **统一余额入口**（`services/image-gen/index.js`）：新增 `fetchProviderBalance(db, providerKey, userId, timeoutMs)`，支持用户自填 Key / 全局 Key、带超时、永不抛错，并对外导出
- **后台**：保存新 Key 时与模型同步**并行**查询余额，卡片提示「余额：$x / $y」；「💰 查余额」按钮改用统一封装；余额写入 `settings`（`ai_image_balance_<provider>`），页面重开直接显示「上次余额：…（时间）」，不必每次请求网关
- **前台**：用户保存自己的 Key 后，Key 状态行显示「✓ 已配置 · 余额 $x / $y」，悬停显示失败原因；余额失败不影响 Key 保存结果
- **模板**：MomoAPI 模板补充「保存即查余额」「国内/国际节点用不同域名建实例（momoapi__intl）」说明
- **验证**：本地 mock New API 网关单测 9/9 PASS（总额度+已用、缓存命中、仅 subscription、计费接口全缺失、无 Key）；`node --check` 6 个文件通过；ESLint 0 error；后台 EJS 渲染通过

## v8.26.0 (2026-11-25)

**新增：AI 生图「平台实例」体系（任意 OpenAI 兼容站点 / 多账号 / 国际节点 / 余额查询） ｜ 修复：后台「验证连接」按钮因变量遮蔽永不显示**

- **平台实例**（新增 `server/services/image-gen/templates.js`）：适配器表改为按 key 动态解析——内置平台（`seedance`）、模板实例（`seedance__hk`）、任意站点（`custom__my`）统一走 `resolveAdapterKey`；数据库里的 provider 行就是可增删的平台实例，前台服务商下拉自动出现，新增平台不再需要改代码
- **后台「＋ 新增平台」**：新增 `POST /admin/ai-image/providers/create|delete`，选协议模板 → 填名称/域名/Key → 生成 `模板__后缀` 记录；内置平台不可删除（只能停用），删除实例会清理用户自填 Key 并在必要时重置默认服务商
- **通用 OpenAI 兼容适配器**（新增 `providers/openai_compat.js`）：`/images/generations` + `/images/edits`（手写 multipart，不新增 form-data 依赖）、`/models` 拉模型与验 Key、b64/url 双解析、可选 `/dashboard/billing/*` 余额探测；负向提示词/多图/图生图能力由后台开关透传，避免把不支持的参数发给站点
- **新增平台**：GrsAI、贞贞/T8Star（OpenAI 兼容模板）、WaveSpeed AI（`/api/v3` 异步提交 + 轮询，标注需联调）；新装/升级后默认不启用，填 Key 再启用
- **余额查询**：适配器可选实现 `fetchBalance`，后台卡片出现「💰 查余额」（OpenAI 兼容站点、硅基流动 `/user/info`、MomoAPI 探测）；查不到给出明确提示，不影响生图
- **多节点**：`sizes.js` 与免 Key 判断改为按 `模板__后缀` 前缀解析，`seedance__hk`、`minimax__intl` 等实例自动继承协议默认上限
- **修复**：`server/routes/admin/ai-image.js` 页面数据数组与导入的适配器表同名遮蔽，`providers[key]` 恒为 undefined，导致「✓ 验证连接与配置」按钮从不渲染；改用 `providerRows`，并补 `is_instance / adapter_key / supports_balance`
- **验证**：`node --check` 覆盖 9 个改动文件；ESLint 0 error；`require` 冒烟验证 `seedance__hk→seedance`、`custom__mine→openai_compat`、`grsai→openai_compat`、未知前缀→null；后台 EJS 模板编译渲染通过

## v8.25.0 (2026-11-25)

**新增：AI 生图节点画布 + 4K/100MB 参考图 + ComfyUI/MomoAPI/Seedance 多服务商治理 ｜ 修复：MomoAPI 模型无渠道与图生图 Invalid IP**

- **AI 生图节点画布**（新增 `public/js/ai-image-canvas.js`）：Text / 参考图 / Image 三种节点、输出→输入锚点连线、画布平移缩放、小地图、框选与多选、整组拖动、对齐/等距/网格整理、8px 网格吸附与节点参考线、撤销重做、复制粘贴、方向键微调、节点锁定、项目 JSON 导入导出、整块画布 PNG 导出、自动布局、快捷键帮助与自动保存状态
- **4K 尺寸与向下兼容**（新增 `server/services/image-gen/sizes.js`）：新增 4K（3840×2160 / 2160×3840 / 2880×2880）与 2K 档位，原有全部尺寸保留；按服务商上限请求前降级，运行时遇到尺寸/显存错误按 `4K → 2K → 1K` 自动重试；OpenAI 离散尺寸映射；ComfyUI 尺寸上限由 2048 提升到 4096；生成结果记录并展示实际尺寸
- **参考图上限 5MB → 100MB**：服务端 multer、简洁表单、画布上传与页面提示同步；大图预览改用 Blob URL，避免 100MB 图片转 base64；画布超过 20MB 的参考图不常驻 JS 内存，生成时按需从 IndexedDB 读取并处理写入时序
- **ComfyUI 原生工作流**：支持后台粘贴 API 工作流 JSON、自动识别/手动配置节点映射（positive/negative/size/seed/image/model）、连接与配置验证、内置默认工作流兜底
- **MomoAPI**：认证模型列表为准同步模型；Imagen/模型通道不可用时自动换模型并记忆可用替身；`Invalid IP address: undefined` 图生图错误识别与模型回退；multipart 显式 Content-Length，兼容对 chunked 解析不稳定的网关
- **Seedance**：新增文生图/图生图适配器，支持 1k/2k/4k 分辨率档位与参考图上传
- **模型与默认服务商治理**：后台可指定默认生图服务商；保存 Key/获取模型后按服务商能力同步白名单与默认模型；新增连接验证；免 Key 服务商（ComfyUI/Pollinations）不再出现在用户 Key 配置中
- **AI 聊天场景生图**：独立 `imagegen.use` 权限与额度校验；新增任务状态/取消接口；保存图片消息时校验图片属于当前用户的成功任务；轮询上限放宽到约 12 分钟以适配 ComfyUI 工作流
- **安全与稳定性**：服务商返回图片 URL 统一走 `safeFetchBuffer`（SSRF/私网 IP/重定向/体积/取消信号）；AI 聊天内联 JSON 改用 `jsJson`；用户与管理员 Key 保存、模型同步、默认服务商切换均补服务端校验
- **验证**：`node --check` 全部通过；ESLint 0 error；本地 Mock 覆盖模型无渠道、Invalid IP、Imagen、鉴权、模型列表失败、multipart Content-Length、4K/2K/旧尺寸降级；无头浏览器验证画布多选、组拖动、对齐、框选、自动布局全部 PASS；EJS 模板渲染通过

## v8.24.1 (2026-11-20)

**安全审查修复 + Bug 修复 + 美观优化**

- 安全：头像上传 MIME 映射扩展名 + 魔数校验；OAuth/API 头像路径注入防护（`sanitize-avatar`）；`safe-fetch` SSRF 防护（私网 IP 拦截 + DNS 重绑定防护 + 重定向/体积上限）；TOTP 重放保护；补齐 community/content/private-message/spreadsheet/image-share 的 CSRF 双提交校验，登出改 POST；`escapeHtml` 统一为转义引号的正则版；模型列表拉取加体积/重定向上限；API 5xx 生产环境不再泄露内部错误详情
- Bug：sql.js 分支 `run()` 返回 `lastInsertRowid`/`changes`、语句泄漏修复；RAG 开关读取错误表修复；群聊/再生消息计数修正；AI 聊天流式生成中禁止切换/删除会话等竞态防护；角色卡导入上限对齐 200
- 美观：AI 聊天/角色卡广场品牌桥接（粉紫渐变 + 返回主站入口 + 字体栈对齐）；站内信/欢迎/隐私弹窗、站内信列表、错误页、图片分享提示页硬编码色令牌化；`--text-muted` 对比度达 WCAG AA；主导航补角色卡广场入口（含 i18n）；7 个页面补齐 `variables.css` 修复主题层令牌失效

## v8.24.0 (2026-11-12)

**新增：世界书自动识别（自动补二级触发词 + 自动常驻）+ 命中诊断 ｜ 修复：前台 CSRF 令牌为空导致写操作 403**

- 新增纯函数模块 `services/ai-chat/world-book.js`（扫描期叠加，不写库、不改用户条目）：
  - 自动二级键：内容按「引号专名 > `名称：`/`武器：` 定义值 > 定义行左侧专名 > 英文专名 > 高频中文 2–6 字词」抽词，去停用词/功能字边界/更长词碎片，最多 8 个补进 `secondary_keys`
  - 自动常驻：无触发词 / 触发词全是 `世界观、设定、背景、lore…` 全局标签 / 条目名或内容自称全局设定 → 按常驻注入
- 触发语义修正（`context.js:scanWorldBook`）：「未勾选选择性」= 主键**或**二级键任一命中（补充触发词只扩大召回）；「勾选选择性」保持 SillyTavern 的 **AND** 语义，且只给非选择性条目自动补键，避免凭空补键反而收窄触发
- 触发词切分与 RP-Hub / SillyTavern 对齐：只按逗号家族 + 换行切分，英文多词键保持整体，含中文的片段才额外按空白切
- 后台开关 `ai_world_auto_enhance` / `ai_world_auto_secondary` / `ai_world_auto_constant`（默认开启，旧库缺行也按开启处理，只有显式 `0` 才关闭）
- 可观测：世界书列表返回 `auto_constant` / `auto_reason` / `auto_secondary_keys` 并显示「自动常驻 / 自动二级键 N」徽标；编辑弹窗提示自动补键内容；「🔍 预览上下文」新增试算输入 + 逐条命中诊断（是否注入 / 命中词 / 未命中原因 / 第几层递归）
- **修复：前台 CSRF 令牌为空**（`server/app.js`）。`res.locals.csrfToken` 原先是 `''` 占位，只有 `/admin` 等少数路由会跑 `doubleSubmitCookie` 填充，导致登录态前台页面 `meta[name="csrf-token"]` 恒为空，个人主页「裁剪头像 → 确认上传」等写操作全部 403「CSRF 验证失败」。现改为在全局 locals 中间件里按会话生成/复用 `req.session.doubleSubmitToken`，与校验逻辑共用同一令牌
- 验证：纯函数断言 38/38；隔离临时数据目录 E2E 26/26（真实 `database.sqlite` 未触碰），覆盖「主键不命中但自动二级键命中 → 注入」「全局标签条目自动常驻」「选择性条目仍需双键」「后台关闭自动识别后同句 0 命中、重开恢复」；106 个 EJS 模板编译通过；`eslint` 0 error

## v8.23.2 (2026-11-11)

**修复：登录态页面内联脚本 `Uncaught SyntaxError: Unexpected token '&'`（私信功能整体失效）**
- 根因：内联 `<script>` 里用 EJS 转义输出标签注入 `JSON.stringify(...)`，双引号被写成 `&quot;`，浏览器解析脚本即在 `&` 处报错，整段脚本（私信弹窗 / 私信页）全部不执行
- 新增全局模板助手 `app.locals.jsJson`：原始输出 JSON，并把 `< >` 与 U+2028/U+2029 转成 JS 转义序列，防 `</script>` 截断与行分隔符断行
- `layout.ejs` 私信弹窗改用 `chatSelfId` / `chatSelfAvatar`，`chat.ejs` 新增 `currentUserAvatar`，共 5 处内联注入统一走 `jsJson`
- 验证：106 个 EJS 模板全部编译通过、内联脚本已无转义输出 JSON；隔离建库真实 HTTP 渲染（含恶意头像 payload）逐段脚本语法检查全部通过

## v8.23.1 (2026-11-11)

**修复：在线更新后重启失效（版本号变了但功能没变 / PM2 无限重启）**
- `ecosystem.config.js`：`listen_timeout` 10 秒 → 30 秒（初始化超时被 PM2 判「未就绪」直接杀进程，导致 335 次重启循环）；`logs` 目录加载时自动创建，`error_file`/`out_file` 改绝对路径，删除 PM2 不支持的 `pre_start`、`combine_logs`
- `system-update.js`：重启不再走 npm（Windows 下 `npm.cmd` + shell 退出码 1、裸 `.cmd` 抛 `spawn EINVAL`），改为按 start 脚本参数用 `process.execPath` 直接拉起；PM2 模式下重启失败不再裸 spawn，杜绝孤儿进程占端口
- `app.js`：`EADDRINUSE` 由「立即退出」改为每秒重试最多 10 次，重启期间端口重叠可自愈

## v8.23.0 (2026-11-11)

**新增：角色卡广场上传 + 卡片屏蔽治理 + 后台批量操作**
- 广场上传端点 `POST /characters/api/cards/upload`：管理员批量导入即官方卡（≤50 文件），普通用户私有导入（≤10 文件，需自行分享）；仅 `.json`/`.png`、单文件 ≤10MB、按名去重、单人上限 200 张
- 新增 `ai_role_blocks` 表承载卡片屏蔽：被屏蔽卡对全员隐藏，仅上传者可继续使用；屏蔽即失效分享链接；广场与 AI 聊天角色列表/详情统一走 `ROLE_VISIBLE_WHERE`
- 下架 / 屏蔽 / 删除三档语义落地，均支持批量 `ids` 且逐卡记活动日志；后台新增官方卡与默认世界书的批量操作，超管新增全站批量下架/提升/删除/屏蔽

**修复 + 优化：AI 聊天智能预测**
- 预测贴合当前楼层：历史窗口 16 条、【本轮重点】（用户上一句 + AI 最新回复）、5 条硬约束提示词、意图互斥、多要 2 条候选
- 预测去重：`isSimilarText` 覆盖语序改写，blocklist 取最近 6 条用户发言
- 修复预测全程不出：`stream_options` 只在 `stream: true` 时发送（同时修好 3 处非流式调用）；预测调用从 `loadBootstrap` 链中拆出，每轮回复后必拉
- 修复截断 JSON 被当建议：`max_tokens` 480 + 只捞成对引号片段
- 修复 `card-import.js` 相对路径少一层导致重启即启动失败
- 群聊成员摘要补注入 `【所在场景】`；思考块流式默认折叠；修复 `csrfFetch` 二次 `.json()` 报错

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
