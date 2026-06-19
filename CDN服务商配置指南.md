# CDN服务商配置指南

## 支持的CDN服务商

### 1. Cloudflare（推荐）

**优势**：免费计划无限流量，全球节点多，自带DDoS防护

**配置步骤**：
1. 注册 https://dash.cloudflare.com
2. 添加站点 `dalaowang233.top`
3. 修改域名服务器为Cloudflare提供的地址
4. 在后台设置填写主域名：`https://dalaowang233.top`

**配置示例**：
```
CDN域名：https://dalaowang233.top
```

---

### 2. 阿里云CDN

**优势**：国内节点多，速度快，稳定

**配置步骤**：
1. 登录 https://cdn.console.aliyun.com
2. 添加加速域名：`cdn.dalaowang233.top`
3. 源站地址：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 3. 腾讯云CDN

**优势**：性价比高，免费额度大

**配置步骤**：
1. 登录 https://console.cloud.tencent.com/cdn
2. 添加域名：`cdn.dalaowang233.top`
3. 源站配置：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 4. 华为云CDN

**优势**：企业级服务，稳定可靠

**配置步骤**：
1. 登录 https://console.huaweicloud.com/cdn
2. 添加加速域名：`cdn.dalaowang233.top`
3. 源站配置：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 5. 百度云CDN

**优势**：与百度生态集成好

**配置步骤**：
1. 登录 https://console.bce.baidu.com/cdn
2. 添加域名：`cdn.dalaowang233.top`
3. 源站配置：您的服务器IP
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 6. 七牛云CDN

**优势**：图片处理能力强，免费额度

**配置步骤**：
1. 登录 https://portal.qiniu.com
2. 创建融合CDN域名：`cdn.dalaowang233.top`
3. 配置回源规则
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 7. 又拍云CDN

**优势**：提供免费额度，适合中小型网站

**配置步骤**：
1. 登录 https://console.upyun.com
2. 创建云分发服务
3. 添加域名：`cdn.dalaowang233.top`
4. 配置回源规则
5. 配置CNAME记录
6. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 8. CDNfly

**优势**：价格便宜，适合个人站长

**配置步骤**：
1. 登录CDNfly控制台
2. 添加域名：`cdn.dalaowang233.top`
3. 配置回源地址
4. 配置CNAME记录
5. 在后台设置填写：`https://cdn.dalaowang233.top`

**配置示例**：
```
CDN域名：https://cdn.dalaowang233.top
```

---

### 9. jsDelivr（免费）

**优势**：完全免费，无需注册

**限制**：需要将资源上传到GitHub，国内访问不稳定

**配置步骤**：
1. 创建GitHub仓库，上传静态资源
2. 在后台设置填写：`https://cdn.jsdelivr.net/gh/用户名/仓库名`

**配置示例**：
```
CDN域名：https://cdn.jsdelivr.net/gh/username/my-website-assets
```

---

### 10. 自定义CDN

适用于其他CDN服务商或自建CDN

**配置步骤**：
1. 在CDN服务商处配置加速域名
2. 配置回源规则
3. 配置CNAME解析
4. 在后台设置填写CDN域名

---

## 通用配置步骤

### 第1步：配置CDN服务商

1. 在CDN服务商处添加加速域名
2. 配置回源地址（您的服务器IP）
3. 配置缓存规则：
   - CSS/JS文件：30天
   - 图片文件：30天
   - 字体文件：1年
4. 启用HTTPS

### 第2步：配置DNS解析

在域名注册商处添加CNAME记录：
```
类型：CNAME
主机记录：cdn
记录值：xxxx.cdn.com（CDN服务商提供）
```

### 第3步：后台配置

1. 登录网站后台
2. 进入「网站设置」
3. 找到「CDN加速设置」
4. 选择CDN服务商
5. 填写CDN域名
6. 启用CDN
7. 保存设置
8. 点击「测试CDN连接」验证

---

## 缓存规则配置

### 阿里云CDN
- 目录：`/css/*`, `/js/*`
- 缓存时间：30天
- 目录：`*.jpg`, `*.png`, `*.gif`
- 缓存时间：30天

### 腾讯云CDN
- 路径：`/css/*`, `/js/*`
- 缓存时间：2592000秒（30天）

### Cloudflare
- Page Rules：`dalaowang233.top/css/*`
- Cache Level：Cache Everything
- Edge Cache TTL：1 month

---

## 常见问题

### Q1: 如何选择CDN服务商？

- **国内用户**：阿里云、腾讯云、华为云
- **海外用户**：Cloudflare
- **免费方案**：Cloudflare、jsDelivr
- **性价比**：腾讯云、七牛云、又拍云

### Q2: CDN域名填什么？

- **Cloudflare**：填写主域名，如 `https://dalaowang233.top`
- **其他服务商**：填写CDN加速域名，如 `https://cdn.dalaowang233.top`

### Q3: 如何更新CDN缓存？

1. 修改后台「资源版本号」
2. 保存设置
3. 在CDN服务商控制台清除缓存

### Q4: CDN不生效怎么办？

1. 检查CNAME解析是否正确
2. 检查CDN配置是否正确
3. 清除浏览器缓存
4. 等待DNS生效（最多24小时）

### Q5: 如何监控CDN效果？

1. 查看CDN服务商的统计面板
2. 使用GTmetrix测试加载速度
3. 使用PageSpeed Insights测试性能

---

## 费用参考

| 服务商 | 免费额度 | 流量费用 |
|--------|----------|----------|
| Cloudflare | 无限 | 免费 |
| 阿里云 | 100GB/月 | 0.24元/GB |
| 腾讯云 | 10GB/月 | 0.21元/GB |
| 华为云 | 100GB/月 | 0.21元/GB |
| 七牛云 | 10GB/月 | 0.26元/GB |
| 又拍云 | 10GB/月 | 0.29元/GB |
| jsDelivr | 无限 | 免费 |

---

## 技术支持

如遇到问题，请联系对应CDN服务商的技术支持：
- Cloudflare：https://community.cloudflare.com
- 阿里云：https://help.aliyun.com
- 腾讯云：https://cloud.tencent.com/document/product/228
- 华为云：https://support.huaweicloud.com
