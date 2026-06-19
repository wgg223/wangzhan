# Cloudflare CDN 配置完成指南

## 配置状态

✅ Cloudflare账号注册
✅ 域名添加
✅ 域名服务器修改（raegan.ns.cloudflare.com, sid.ns.cloudflare.com）
✅ SSL/TLS 配置（Full Strict）
✅ 缓存配置
✅ 速度优化
✅ 页面规则配置
✅ 环境变量配置
✅ 项目代码修改

## 验证步骤

### 1. 检查Cloudflare状态

登录 https://dash.cloudflare.com，确认：
- 站点状态显示 **「Active」**
- SSL证书显示 **「Active Certificate」**

### 2. 检查DNS解析

```bash
nslookup dalaowang233.top
```

应该返回Cloudflare的IP地址。

### 3. 检查HTTP响应头

```bash
curl -I https://dalaowang233.top
```

应该看到：
- `server: cloudflare`
- `cf-ray: xxx`
- `cf-cache-status: HIT` 或 `DYNAMIC`

### 4. 测试网站访问

访问 https://dalaowang233.top，确认：
- 网站正常加载
- HTTPS正常工作
- 无混合内容警告

## Cloudflare控制台监控

### 查看访问统计

进入 **「Analytics & Logs」** → **「Overview」**
- 总请求数
- 带宽节省量
- 缓存命中率

### 查看安全事件

进入 **「Security」** → **「Events」**
- 被阻止的请求
- 挑战请求

## 常用操作

### 清除缓存

进入 **「Caching」** → **「Configuration」** → **「Purge Cache」**
- 清除所有缓存：点击 **「Purge Everything」**
- 清除特定文件：输入URL

### 更新资源版本号

当需要强制更新缓存时，修改 `.env` 文件：
```bash
CDN_VERSION=1.0.1
```

然后重启应用。

## 故障排除

### 问题1：网站无法访问

1. 检查Cloudflare状态是否为Active
2. 检查域名服务器是否正确
3. 检查源站服务器是否正常运行

### 问题2：SSL证书错误

1. 确认SSL模式为 Full (Strict)
2. 检查源站是否有有效的SSL证书
3. 等待证书生效（最多24小时）

### 问题3：缓存未生效

1. 检查页面规则配置
2. 清除Cloudflare缓存
3. 检查源站Cache-Control头

## 性能优化建议

### 1. 启用HTTP/2和HTTP/3

在 **「Network」** 页面确认已启用。

### 2. 启用Brotli压缩

在 **「Speed」** → **「Optimization」** 确认已启用。

### 3. 配置负载均衡（可选）

如果有多台服务器，可以配置负载均衡。

### 4. 启用Argo Smart Routing（付费）

可进一步优化路由，减少延迟。

## 安全建议

### 1. 启用WAF

进入 **「Security」** → **「WAF」**，启用规则集。

### 2. 配置速率限制

进入 **「Security」** → **「WAF」** → **「Rate limiting rules」**

### 3. 启用Bot管理

进入 **「Security」** → **「Bots」**

### 4. 配置IP访问规则

进入 **「Security」** → **「WAF」** → **「Tools」**

## 联系支持

如遇到问题：
- Cloudflare文档：https://developers.cloudflare.com
- 社区论坛：https://community.cloudflare.com
- 支持工单：付费计划可提交工单

## 下一步

1. 监控网站性能
2. 根据需要调整缓存规则
3. 优化安全配置
4. 定期检查Cloudflare分析数据

---

配置完成时间：2026-06-19
配置版本：1.0.0
