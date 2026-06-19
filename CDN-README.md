# CDN加速配置

为 dalaowang233.top 网站配置CDN加速，提升访问速度和用户体验。

## 文件说明

- `cdn-config.js` - CDN配置管理模块
- `test-cdn.js` - CDN配置测试脚本
- `monitor-cdn.js` - CDN状态监控脚本
- `deploy-cdn.sh` - Linux/Mac部署脚本
- `deploy-cdn.bat` - Windows部署脚本
- `nginx-cdn.conf.example` - Nginx配置示例
- `.env.example` - 环境变量配置示例
- `CDN配置指南.md` - 详细配置指南

## 快速开始

### 1. 选择CDN服务商

推荐选择：
- **阿里云CDN** - 国内节点多，稳定
- **腾讯云CDN** - 性价比高
- **Cloudflare** - 免费方案

### 2. 配置环境变量

复制并编辑环境变量文件：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```bash
CDN_ENABLED=true
CDN_BASE_URL=https://cdn.dalaowang233.top
ORIGIN_URL=https://dalaowang233.top
CDN_VERSION=1.0.0
```

### 3. 配置CDN服务商

#### 阿里云CDN
1. 添加加速域名：`cdn.dalaowang233.top`
2. 源站地址：您的服务器IP
3. 配置CNAME记录
4. 配置缓存规则
5. 配置HTTPS证书

#### 腾讯云CDN
1. 添加域名：`cdn.dalaowang233.top`
2. 源站配置：您的服务器IP
3. 配置CNAME记录
4. 配置缓存策略
5. 配置SSL证书

#### Cloudflare
1. 添加站点：`dalaowang233.top`
2. 修改域名服务器
3. 配置缓存规则
4. 启用SSL

### 4. 部署配置

#### Linux/Mac
```bash
chmod +x deploy-cdn.sh
sudo ./deploy-cdn.sh
```

#### Windows
```cmd
deploy-cdn.bat
```

### 5. 验证配置

运行测试脚本：

```bash
node test-cdn.js
```

运行监控脚本：

```bash
node monitor-cdn.js
```

## 配置详情

### CDN配置模块

`cdn-config.js` 提供以下功能：

```javascript
const cdnConfig = require('./cdn-config');

// 获取CDN URL
const cssUrl = cdnConfig.getUrl('/css/style.css');
// 返回: https://cdn.dalaowang233.top/css/style.css?v=1.0.0

// 检查CDN状态
console.log(cdnConfig.enabled); // true/false
console.log(cdnConfig.baseUrl); // https://cdn.dalaowang233.top
```

### 前端模板使用

在EJS模板中使用CDN URL：

```html
<link rel="stylesheet" href="<%= cdn.getUrl('/css/style.css') %>">
<script src="<%= cdn.getUrl('/js/main.js') %>"></script>
<img src="<%= cdn.getUrl('/assets/images/logo.png') %>">
```

### 缓存策略

- CSS/JS文件：30天
- 图片文件：30天
- 字体文件：1年
- 用户上传文件：不通过CDN

### 安全配置

- 启用HTTPS
- 配置CORS
- 设置防盗链
- 启用WAF

## 监控和维护

### 监控脚本

```bash
# 实时监控
node monitor-cdn.js

# 定时监控（每5分钟）
watch -n 300 node monitor-cdn.js
```

### 性能指标

- 首次字节时间（TTFB）
- 首次内容绘制（FCP）
- 最大内容绘制（LCP）
- 累积布局偏移（CLS）

### 缓存更新

1. 修改 `CDN_VERSION` 环境变量
2. 在CDN控制台手动刷新缓存
3. 使用CDN提供的API刷新

## 故障排除

### 常见问题

**Q: CDN回源失败怎么办？**
A: 检查原站是否正常运行，检查防火墙设置，确保CDN IP可以访问原站。

**Q: 如何更新CDN缓存？**
A: 修改 `CDN_VERSION` 环境变量或在CDN控制台手动刷新。

**Q: 如何监控CDN性能？**
A: 使用 `monitor-cdn.js` 脚本或CDN服务商提供的监控工具。

### 调试命令

```bash
# 检查DNS解析
nslookup cdn.dalaowang233.top

# 检查HTTP头
curl -I https://cdn.dalaowang233.top/css/style.css

# 检查缓存状态
curl -I https://cdn.dalaowang233.top/css/style.css | grep -i cache-control

# 测试访问速度
curl -w "@curl-format.txt" -o /dev/null -s https://cdn.dalaowang233.top/css/style.css
```

## 性能优化建议

### 1. 资源优化
- CSS/JS文件合并压缩
- 图片使用WebP格式
- 启用Gzip/Brotli压缩

### 2. 缓存策略
- 静态资源：30天
- 图片资源：30天
- 字体文件：1年
- HTML文件：不缓存或短时间缓存

### 3. 安全配置
- 启用HTTPS
- 配置CORS
- 设置防盗链
- 启用WAF

## 成本估算

### 阿里云CDN
- 流量费：0.24元/GB（中国内地）
- 请求费：0.01元/万次
- HTTPS请求费：0.05元/万次

### 腾讯云CDN
- 流量费：0.21元/GB（中国内地）
- 请求费：0.01元/万次
- HTTPS请求费：0.05元/万次

### Cloudflare
- 免费方案：无限流量
- Pro方案：$20/月
- Business方案：$200/月

## 最佳实践

1. **选择合适的CDN服务商**
   - 国内用户选择阿里云或腾讯云
   - 海外用户选择Cloudflare

2. **合理配置缓存**
   - 静态资源设置长缓存
   - 动态内容不缓存或短缓存

3. **启用HTTPS**
   - 使用免费SSL证书
   - 强制HTTPS跳转

4. **监控性能**
   - 定期检查CDN状态
   - 监控访问速度

5. **优化成本**
   - 合理设置缓存时间
   - 启用压缩
   - 使用WebP格式

## 联系支持

如有问题，请联系：
- CDN服务商技术支持
- 域名注册商支持
- 服务器提供商支持

## 更新日志

### v1.0.0 (2026-06-19)
- 初始版本
- 支持阿里云、腾讯云、Cloudflare
- 提供完整的配置和部署脚本
- 包含监控和测试工具