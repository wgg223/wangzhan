# 网站客户端（Flutter）

本目录是网站的 Android / Windows 原生客户端（Flutter 开发），通过服务器的 `/api/v1` JSON 接口与网站数据互通。

## 环境要求

| 目标 | 必需工具 |
| --- | --- |
| 通用 | Flutter SDK（3.x 稳定版）、Android Studio（或仅命令行工具） |
| Windows 桌面 | Visual Studio 2022（需安装「使用 C++ 的桌面开发」工作负载） |
| Android | Android SDK（API 34+）、JDK 17 |

## 首次初始化（只需一次）

本目录已包含全部 Dart 源码（`lib/`）和 `pubspec.yaml`，但 `android/`、`windows/` 平台工程需要由 Flutter 生成：

```bash
# 在 app/ 目录下执行（会自动生成 android/ 和 windows/ 平台工程，不会覆盖已有源码）
flutter create --project-name mi_app --org com.example --platforms android,windows .
```

如果提示文件已存在，可先删除生成的 `android/`、`windows/` 目录后再执行上面的命令。

## 安装依赖

```bash
flutter pub get
```

## 配置服务器地址

编辑 `lib/config/app_config.dart`：

```dart
static const String serverBaseUrl = 'https://你的服务器域名或IP';
```

> 生产环境请务必使用 HTTPS（服务器端已配置 HSTS）。局域网调试可使用 `http://<服务器IP>:3000`，此时 Android 端需要允许明文流量：在 `android/app/src/main/AndroidManifest.xml` 的 `<application>` 标签加 `android:usesCleartextTraffic="true"`。

## 构建

### Android APK

```bash
flutter build apk --release
# 产物: build/app/outputs/flutter-apk/app-release.apk
```

如需拆包（更小的安装包）：

```bash
flutter build apk --split-per-abi --release
```

### Windows 桌面程序

```bash
flutter build windows --release
# 产物: build/windows/x64/runner/Release/mi_app.exe
```

生成的 exe 可直接运行，也可用 Inno Setup 等工具打包成安装程序。

## 运行调试

```bash
flutter run -d windows   # Windows 桌面
flutter run -d <android设备ID>   # 连接的安卓设备/模拟器
```

## 项目结构

```
app/
├── pubspec.yaml              # 依赖声明
├── lib/
│   ├── main.dart             # 入口（登录态路由）
│   ├── config/app_config.dart   # 服务器地址配置
│   ├── api/                  # 接口调用层（Dio 封装 + 各功能模块）
│   │   ├── api_client.dart   # token 注入、401 自动登出、错误处理
│   │   ├── auth_api.dart     # 注册/登录/资料/改密
│   │   ├── article_api.dart  # 文章
│   │   ├── image_share_api.dart # 图片分享
│   │   ├── poem_api.dart     # 诗词题库/排行榜
│   │   ├── novel_api.dart    # 小说
│   │   ├── community_api.dart  # 社区/关注/点赞/通知
│   │   ├── message_api.dart  # 私信
│   │   └── admin_api.dart    # 管理后台
│   ├── models/               # 数据模型
│   ├── state/auth_state.dart # 登录状态管理
│   ├── theme/app_theme.dart  # 主题（浅色/深色）
│   ├── widgets/              # 共用组件
│   └── screens/
│       ├── auth/             # 登录/注册
│       ├── main_shell.dart   # 底部导航框架
│       ├── home/             # 首页
│       ├── articles/         # 文章列表/详情
│       ├── image_share/      # 图片分享/详情/上传
│       ├── poem_game/        # 诗词游戏/排行榜
│       ├── novels/           # 小说列表/详情/阅读器
│       ├── community/        # 社区动态
│       ├── messages/         # 私信会话/聊天
│       ├── profile/          # 我的/收藏/通知/设置
│       ├── search/           # 搜索
│       └── admin/            # 管理后台（仪表盘/用户/文章/评论/图片/小说/设置/日志/权限/媒体/备份/维护）
└── README.md
```

## 功能清单

**用户端**
- 账号：注册 / 登录 / 登出 / 编辑资料 / 修改密码
- 内容：文章列表与详情（富文本渲染、附件展示）、搜索（文章+图片）
- 图片分享：分类浏览、上传（免审核用户直接通过）、收藏、点赞、评论
- 诗词游戏：接龙 / 飞花令 / 猜诗名三种玩法，题目由服务器题库随机下发，成绩自动上榜
- 小说：列表 / 目录 / 章节阅读（可调字号）
- 社区：动态流（关注聚合）、发布动态、关注/取关、点赞、通知
- 私信：会话列表、聊天、未读角标

**管理后台**（管理员账号在「我的 → 管理后台」进入）
- 仪表盘统计、用户管理（角色/状态/删除）、文章管理（上下架/删除）、评论管理、
  图片审核与分类管理、小说管理、系统设置、操作日志（含按天清理）、
  权限管理（按用户勾选权限）、媒体管理、备份管理（创建/删除）、
  服务器维护（维护模式开关、系统信息）

## 说明

- 鉴权采用服务器签发的 Token（存于本地 `shared_preferences`），有效期 30 天，过期自动登出。
- 诗词游戏题库由服务器 `GET /api/v1/poems/random` 提供（与网页端同一份 4 万余首诗词数据）。
- 服务器地址修改后需重启应用生效。
