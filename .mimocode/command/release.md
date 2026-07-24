---
name: release
description: "发布新版本到GitHub：更新版本号、提交代码、创建GitHub Release。用法: /release [版本号] [标题] [说明]"
---

# GitHub Release 发布工作流

自动化以下重复步骤：

1. **更新版本号** - 修改 `package.json` 中的 `version` 字段
2. **检查变更** - `git status` 查看待提交文件
3. **暂存并提交** - `git add` 相关文件 + `git commit`
4. **推送代码** - `git push origin main`
5. **创建Release** - `gh release create vX.Y.Z --title "..." --notes "..."`

## 参数

- `$1` - 版本号（如 `v4.2.0`），如未提供则从 package.json 读取当前版本并自增 patch
- `$2` - Release 标题，如未提供则从最近 commit 信息推断
- `$3` - Release 说明，如未提供则从最近 commit 信息生成

## 执行流程

```bash
# 1. 读取当前版本
node -e "console.log(require('./package.json').version)"

# 2. 检查 git 状态
git status --short
git log --oneline -5

# 3. 更新 package.json 版本号（如需要）
# 使用 node 修改 JSON，避免 sed 在 Windows 上的兼容问题

# 4. 提交所有变更
git add -A
git commit -m "chore: bump version to $VERSION"

# 5. 推送
git push origin main

# 6. 创建 GitHub Release
gh release create $VERSION --title "$TITLE" --notes "$NOTES"
```

## 注意事项

- GitHub CLI (`gh`) 必须已认证：`gh auth status`
- 如果推送失败（代理问题），尝试：`git -c http.proxy="" -c https.proxy="" push`
- Release notes 应使用中文，格式参考：`## 版本标题\n\n### 变更\n- 修复xxx\n- 新增xxx`
- 如果需要创建 tag：`git tag -a $VERSION -m "$TITLE"` 然后 `git push origin $VERSION`
- 版本号格式：`vX.Y.Z`（遵循 semver）
