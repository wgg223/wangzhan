# CDN加速配置指南

## 概述

本指南帮助您为 dalaowang233.top 网站配置CDN加速，提升访问速度和用户体验。

## 方案一：国内CDN服务商（推荐）

### 1. 阿里云CDN配置

#### 步骤1：开通CDN服务
1. 登录阿里云控制台
2. 进入CDN产品页面
3. 开通CDN服务

#### 步骤2：添加加速域名
1. 进入CDN控制台
2. 点击"添加域名"
3. 填写配置：
   - 加速域名：`cdn.dalaowang233.top`
   - 业务类型：`图片小文件`
   - 加速区域：`中国内地`
   - 源站类型：`IP`
   - 源站地址：`您的服务器IP`
   - 端口：`443`（HTTPS）

#### 步骤3：配置CNAME
1. 在域名服务商处添加CNAME记录：
   ```
   cdn.dalaowang233.top -> xxxx.kunlun.com
   ```
2. 等待DNS解析生效（通常10-30分钟）

#### 步骤4：配置缓存规则
1. 在CDN控制台找到"缓存配置"
2. 添加缓存规则：
   - 目录：`/css/`, `/js/`
   - 缓存时间：`30天`
   - 目录：`*.css`, `*.js`
   - 缓存时间：`30天`
   - 目录：`*.jpg`, `*.jpeg`, `*.png`, `*.gif`, `*.ico`, `*.svg`, `*.webp`
   - 缓存时间：`30天`
   - 目录：`*.woff`, `*.woff2`, `*.ttf`, `*.eot`
   - 缓存时间：`1年`

#### 步骤5：配置HTTPS
1. 在CDN控制台找到"HTTPS配置"
2. 上传SSL证书（或使用免费证书）
3. 强制HTTPS跳转：开启
4. HTTP/2：开启

### 2. 腾讯云CDN配置

#### 步骤1：开通CDN服务
1. 登录腾讯云控制台
2. 进入CDN产品页面
3. 开通CDN服务

#### 步骤2：添加域名
1. 进入CDN控制台
2. 点击"添加域名"
3. 填写配置：
   - 加速域名：`cdn.dalaowang233.top`
   - 业务类型：`静态内容`
   - 加速区域：`中国境内`
   - 源站类型：`自有源`
   - 源站地址：`您的服务器IP`
   - 端口：`443`

#### 步骤3：配置CNAME
1. 在域名服务商处添加CNAME记录：
   ```
   cdn.dalaowang233.top -> xxxx.cdn.dnsv1.com
   ```

#### 步骤4：配置缓存
1. 在CDN控制台找到"缓存配置"
2. 设置缓存规则（同阿里云）

## 方案二：Cloudflare（免费）

### 1. 注册Cloudflare账号
1. 访问 https://www.cloudflare.com
2. 注册账号

### 2. 添加站点
1. 点击"Add a Site"
2. 输入域名：`dalaowang233.top`
3. 选择免费计划

### 3. 配置DNS
1. Cloudflare会扫描现有DNS记录
2. 确认记录无误
3. 按照提示修改域名服务器

### 4. 配置缓存规则
1. 进入"Caching" -> "Configuration"
2. 设置缓存级别：`Standard`
3. 浏览器缓存TTL：`1 month`

### 5. 配置SSL
1. 进入"SSL/TLS"
2. 模式选择：`Full (Strict)`
3. 启用"Always Use HTTPS"

## 项目配置

### 1. 环境变量配置

创建 `.env` 文件：

```bash
# 启用CDN
CDN_ENABLED=true

# CDN域名
CDN_BASE_URL=https://cdn.dalaowang233.top

# 原站域名
ORIGIN_URL=https://dalaowang233.top

# 资源版本号
CDN_VERSION=1.0.0

# 其他配置
NODE_ENV=production
SESSION_SECRET=your_session_secret_here
```

### 2. 修改前端模板

在布局文件中使用CDN URL：

```html
<!-- 使用CDN URL -->
<link rel="stylesheet" href="<%= cdn.getUrl('/css/style.css') %>">
<script src="<%= cdn.getUrl('/js/main.js') %>"></script>

<!-- 或者使用asset函数 -->
<link rel="stylesheet" href="<%= cdn.asset('/css/style.css') %>">
<script src="<%= cdn.asset('/js/main.js') %>"></script>
```

### 3. Nginx配置

使用提供的 `nginx-cdn.conf.example` 配置文件：

```bash
# 复制配置文件
sudo cp nginx-cdn.conf.example /etc/nginx/sites-available/dalaowang233.top

# 创建符号链接
sudo ln -s /etc/nginx/sites-available/dalaowang233.top /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载Nginx
sudo systemctl reload nginx
```

## 验证配置

### 1. 检查CDN状态
```bash
# 检查DNS解析
nslookup cdn.dalaowang233.top

# 检查HTTP头
curl -I https://cdn.dalaowang233.top/css/style.css
```

### 2. 检查缓存头
```bash
# 检查Cache-Control头
curl -I https://cdn.dalaowang233.top/css/style.css | grep -i cache-control

# 检查CDN头
curl -I https://cdn.dalaowang233.top/css/style.css | grep -i x-cache
```

### 3. 性能测试
1. 使用GTmetrix：https://gtmetrix.com
2. 使用PageSpeed Insights：https://developers.google.com/speed/pagespeed/insights
3. 使用WebPageTest：https://www.webpagetest.org

## 常见问题

### Q1: CDN回源失败怎么办？
A: 检查原站是否正常运行，检查防火墙设置，确保CDN IP可以访问原站。

### Q2: 如何更新CDN缓存？
A: 
1. 修改 `CDN_VERSION` 环境变量
2. 在CDN控制台手动刷新缓存
3. 使用CDN提供的API刷新

### Q3: 如何监控CDN性能？
A: 
1. 使用CDN服务商提供的监控工具
2. 配置Google Analytics监控加载时间
3. 使用RUM（真实用户监控）工具

### Q4: 如何优化CDN成本？
A: 
1. 合理设置缓存时间
2. 启用Gzip/Brotli压缩
3. 使用WebP格式图片
4. 配置防盗链

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
- 启用WAF（Web应用防火墙）

## 监控和维护

### 1. 定期检查
- CDN服务状态
- 缓存命中率
- 带宽使用情况
- 错误率

### 2. 性能监控
- 首次字节时间（TTFB）
- 首次内容绘制（FCP）
- 最大内容绘制（LCP）
- 累积布局偏移（CLS）

### 3. 成本监控
- 带宽使用量
- 请求次数
- 存储使用量

## 故障排除

### 1. 常见问题
- DNS解析失败
- SSL证书错误
- 缓存未生效
- 回源失败

### 2. 解决方案
- 检查DNS配置
- 更新SSL证书
- 清除CDN缓存
- 检查原站状态

### 3. 联系支持
- CDN服务商技术支持
- 域名注册商支持
- 服务器提供商支持

## 总结

通过配置CDN加速，您的网站将获得：
1. 更快的访问速度
2. 更好的用户体验
3. 更高的可用性
4. 更强的安全性

建议选择国内CDN服务商（如阿里云、腾讯云）以获得最佳的国内访问体验。