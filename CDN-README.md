# CDN加速配置指南

## 概述

本指南帮助您为网站配置CDN加速，提升访问速度和用户体验。

## 支持的CDN服务商

| 服务商 | 优势 | 免费额度 | 流量费用 |
|--------|------|----------|----------|
| Cloudflare | 免费无限流量，全球节点，自带DDoS防护 | 无限 | 免费 |
| 阿里云CDN | 国内节点多，速度快，稳定 | 100GB/月 | 0.24元/GB |
| 腾讯云CDN | 性价比高，免费额度大 | 10GB/月 | 0.21元/GB |
| 华为云CDN | 企业级服务，稳定可靠 | 100GB/月 | 0.21元/GB |
| 百度云CDN | 与百度生态集成好 | 10GB/月 | 0.24元/GB |
| 七牛云CDN | 图片处理能力强 | 10GB/月 | 0.26元/GB |
| 又拍云CDN | 适合中小型网站 | 10GB/月 | 0.29元/GB |
| CDNfly | 价格便宜，适合个人站长 | - | - |
| jsDelivr | 完全免费，无需注册 | 无限 | 免费 |

## 快速配置

### 第1步：配置CDN服务商

#### Cloudflare（推荐）

1. 注册 https://dash.cloudflare.com
2. 添加站点 `your-domain.com`
3. 修改域名服务器为Cloudflare提供的地址
4. 配置SSL/TLS模式为 `Full (Strict)`
5. 在后台设置填写主域名：`https://your-domain.com`

#### 阿里云CDN

1. 登录 https://cdn.console.aliyun.com
2. 添加加速域名：`cdn.your-domain.com`
3. 源站地址：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.your-domain.com`

#### 腾讯云CDN

1. 登录 https://console.cloud.tencent.com/cdn
2. 添加域名：`cdn.your-domain.com`
3. 源站配置：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.your-domain.com`

### 第2步：配置DNS解析

在域名注册商处添加CNAME记录：
```
类型：CNAME
主机记录：cdn
记录值：xxxx.cdn.com（CDN服务商提供）
```

### 第3步：后台配置

1. 登录网站后台
2. 进入「网站设置」→「CDN加速设置」
3. 选择CDN服务商
4. 填写CDN域名
5. 启用CDN
6. 保存设置
7. 点击「测试CDN连接」验证

## 缓存规则配置

| 资源类型 | 缓存时间 |
|----------|----------|
| CSS/JS文件 | 30天 |
| 图片文件 | 30天 |
| 字体文件 | 1年 |
| HTML文件 | 不缓存或短时间缓存 |

## 环境变量配置

创建 `.env` 文件：

```bash
# 启用CDN
CDN_ENABLED=true

# CDN域名
CDN_BASE_URL=https://cdn.your-domain.com

# 原站域名
ORIGIN_URL=https://your-domain.com

# 资源版本号（修改可强制更新缓存）
CDN_VERSION=1.0.0
```

## 前端模板使用

在EJS模板中使用CDN URL：

```html
<link rel="stylesheet" href="<%= cdn.getUrl('/css/style.css') %>">
<script src="<%= cdn.getUrl('/js/main.js') %>"></script>
<img src="<%= cdn.getUrl('/assets/images/logo.png') %>">
```

## 验证配置

### 检查DNS解析
```bash
nslookup cdn.your-domain.com
```

### 检查HTTP响应头
```bash
curl -I https://cdn.your-domain.com/css/style.css
```

应该看到：
- `server: cloudflare`（Cloudflare）
- `cf-cache-status: HIT` 或 `DYNAMIC`
- `cache-control: max-age=2592000`

## 常见问题

### Q1: 如何选择CDN服务商？

- **国内用户**：阿里云、腾讯云、华为云
- **海外用户**：Cloudflare
- **免费方案**：Cloudflare、jsDelivr
- **性价比**：腾讯云、七牛云、又拍云

### Q2: CDN域名填什么？

- **Cloudflare**：填写主域名，如 `https://your-domain.com`
- **其他服务商**：填写CDN加速域名，如 `https://cdn.your-domain.com`

### Q3: 如何更新CDN缓存？

1. 修改后台「资源版本号」
2. 保存设置
3. 在CDN服务商控制台清除缓存

### Q4: CDN不生效怎么办？

1. 检查CNAME解析是否正确
2. 检查CDN配置是否正确
3. 清除浏览器缓存
4. 等待DNS生效（最多24小时）

### Q5: CDN回源失败怎么办？

1. 检查原站是否正常运行
2. 检查防火墙设置
3. 确保CDN IP可以访问原站

## 性能优化建议

1. **资源优化**
   - CSS/JS文件合并压缩
   - 图片使用WebP格式
   - 启用Gzip/Brotli压缩

2. **安全配置**
   - 启用HTTPS
   - 配置CORS
   - 设置防盗链
   - 启用WAF

3. **监控性能**
   - 定期检查CDN状态
   - 监控访问速度
   - 查看CDN服务商统计面板

## Cloudflare专项配置

### 验证Cloudflare状态

登录 https://dash.cloudflare.com，确认：
- 站点状态显示 **「Active」**
- SSL证书显示 **「Active Certificate」**

### 检查HTTP响应头

```bash
curl -I https://your-domain.com
```

应该看到：
- `server: cloudflare`
- `cf-ray: xxx`
- `cf-cache-status: HIT` 或 `DYNAMIC`

### 常用操作

**清除缓存**：进入 「Caching」→「Configuration」→「Purge Cache」

**更新资源版本号**：修改 `.env` 文件中的 `CDN_VERSION`

### 性能优化

1. 启用HTTP/2和HTTP/3（「Network」页面）
2. 启用Brotli压缩（「Speed」→「Optimization」）
3. 配置WAF规则（「Security」→「WAF」）

## 故障排除

| 问题 | 解决方案 |
|------|----------|
| 网站无法访问 | 检查Cloudflare状态、域名服务器、源站服务器 |
| SSL证书错误 | 确认SSL模式为Full (Strict)，检查源站证书 |
| 缓存未生效 | 检查页面规则配置，清除CDN缓存 |
| DNS解析失败 | 检查CNAME记录，等待DNS生效 |

## 技术支持

- Cloudflare：https://developers.cloudflare.com
- 阿里云：https://help.aliyun.com
- 腾讯云：https://cloud.tencent.com/document/product/228
- 华为云：https://support.huaweicloud.com
