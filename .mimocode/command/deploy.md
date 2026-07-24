---
name: deploy
description: "部署到服务器：通过deploy.py上传文件并重启PM2。用法: /deploy [模式]"
---

# 服务器部署工作流

封装已有的 `deploy.py` 脚本，自动化部署流程。

## 参数

- `$1` - 部署模式，可选值：
  - `changed`（默认）- 仅上传变更文件（推荐日常使用）
  - `full` - 全量上传
  - `fix` - 仅重启 PM2
  - `check` - 健康检查
  - `logs` - 查看服务器日志

## 执行流程

```bash
# 1. 确认本地代码已提交
git status

# 2. 设置服务器密码（环境变量）
$env:DEPLOY_PASS = "20030423Wang"

# 3. 执行部署
python deploy.py --upload-changed   # 默认模式
# 或
python deploy.py --upload-only      # 全量上传
# 或
python deploy.py --fix-only         # 仅重启
# 或
python deploy.py --check            # 健康检查

# 4. 验证部署结果
python deploy.py --check
```

## 部署前检查清单

- [ ] 本地代码已 `git commit`
- [ ] `package.json` 版本号已更新（如果是新版本）
- [ ] `cdn-config.js` 文件存在（PM2 依赖此文件）
- [ ] 数据库 schema 变更已写入迁移代码（`db-seed.js`）

## 常见问题

- **PM2 崩溃循环**：通常是缺少文件。检查 `deploy.py --logs` 看具体错误
- **cdn-config.js 缺失**：确保此文件在 `deploy.py` 的 `core_files` 列表中
- **数据库锁定**：服务器上 SQLite 可能被锁定，等待几秒后重试

## 服务器信息

- 主机: `8.156.91.188:22`
- 用户: `root`
- 目录: `/var/www/dalaowang233.top`
- PM2 进程名: `website-admin`
- 域名: `dalaowang233.top`
