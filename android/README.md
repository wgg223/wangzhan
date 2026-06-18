# RP-HUB Android App

## 项目结构

```
android/
├── app/
│   ├── build.gradle
│   ├── proguard-rules.pro
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml
│           ├── java/com/dalaowang/app/
│           │   └── MainActivity.java
│           └── res/
│               ├── drawable/
│               ├── layout/
│               ├── mipmap-*/
│               └── values/
├── build.gradle
├── gradle.properties
└── settings.gradle
```

## 构建要求

- JDK 17 或更高版本
- Android SDK (API 34)
- Android Studio 或 Gradle

## 构建步骤

### 方式一：使用 Android Studio

1. 打开 Android Studio
2. 选择 "Open an existing Android Studio project"
3. 选择 `android` 目录
4. 等待 Gradle 同步完成
5. 点击 Build > Build Bundle(s) / APK(s) > Build APK(s)

### 方式二：使用命令行

```bash
cd android
./gradlew assembleDebug
```

APK 输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`

## 配置说明

- 服务器地址：`https://dalaowang233.top` (在 `MainActivity.java` 中修改 `URL` 常量)
- 包名：`com.dalaowang.app`
- 最低 SDK 版本：24 (Android 7.0)
- 目标 SDK 版本：34 (Android 14)

## 功能特性

- WebView 加载网页
- 支持 JavaScript
- 支持 DOM Storage
- 返回键导航
- 加载进度条
- 全屏模式
