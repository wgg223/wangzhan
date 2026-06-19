/**
 * CDN监控脚本
 * 用于监控CDN状态和性能
 */

const https = require('https');
const http = require('http');
const dns = require('dns');

// 配置
const config = {
  cdnDomain: 'cdn.dalaowang233.top',
  originDomain: 'dalaowang233.top',
  testPaths: [
    '/css/style.css',
    '/js/main.js',
    '/assets/images/logo.png'
  ],
  timeout: 10000
};

// 测试URL访问
function testUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const startTime = Date.now();

    const req = protocol.get(url, { timeout: config.timeout }, (res) => {
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          url: url,
          statusCode: res.statusCode,
          responseTime: responseTime,
          headers: res.headers,
          contentLength: data.length,
          cacheStatus: res.headers['x-cache-status'] || 'N/A',
          cdnProvider: res.headers['x-cdn-provider'] || 'N/A'
        });
      });
    });

    req.on('error', (error) => {
      reject(new Error(`请求失败: ${url} - ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时: ${url}`));
    });
  });
}

// 检查DNS解析
function checkDNS(domain) {
  return new Promise((resolve, reject) => {
    dns.resolve4(domain, (err, addresses) => {
      if (err) {
        reject(err);
      } else {
        resolve(addresses);
      }
    });
  });
}

// 主监控函数
async function monitorCDN() {
  console.log('=== CDN监控报告 ===');
  console.log('监控时间:', new Date().toLocaleString());
  console.log('');

  // 1. 检查DNS解析
  console.log('1. DNS解析检查:');
  try {
    const cdnIPs = await checkDNS(config.cdnDomain);
    console.log(`   CDN域名 ${config.cdnDomain} 解析到: ${cdnIPs.join(', ')}`);
  } catch (error) {
    console.log(`   CDN域名解析失败: ${error.message}`);
  }

  try {
    const originIPs = await checkDNS(config.originDomain);
    console.log(`   原站域名 ${config.originDomain} 解析到: ${originIPs.join(', ')}`);
  } catch (error) {
    console.log(`   原站域名解析失败: ${error.message}`);
  }

  console.log('');

  // 2. 测试CDN访问
  console.log('2. CDN访问测试:');
  for (const testPath of config.testPaths) {
    const cdnUrl = `https://${config.cdnDomain}${testPath}`;
    const originUrl = `https://${config.originDomain}${testPath}`;

    try {
      console.log(`   测试路径: ${testPath}`);

      // 测试CDN
      const cdnResult = await testUrl(cdnUrl);
      console.log(`     CDN: ${cdnResult.statusCode} - ${cdnResult.responseTime}ms - 缓存状态: ${cdnResult.cacheStatus}`);

      // 测试原站
      const originResult = await testUrl(originUrl);
      console.log(`     原站: ${originResult.statusCode} - ${originResult.responseTime}ms`);

      // 计算加速比
      if (originResult.responseTime > 0) {
        const speedup = ((originResult.responseTime - cdnResult.responseTime) / originResult.responseTime * 100).toFixed(2);
        console.log(`     加速比: ${speedup}%`);
      }

      console.log('');
    } catch (error) {
      console.log(`     测试失败: ${error.message}`);
      console.log('');
    }
  }

  // 3. 检查缓存头
  console.log('3. 缓存头检查:');
  try {
    const cacheTestUrl = `https://${config.cdnDomain}/css/style.css`;
    const result = await testUrl(cacheTestUrl);

    console.log('   Cache-Control:', result.headers['cache-control'] || '未设置');
    console.log('   X-Cache-Status:', result.headers['x-cache-status'] || '未设置');
    console.log('   X-CDN-Provider:', result.headers['x-cdn-provider'] || '未设置');
    console.log('   ETag:', result.headers['etag'] || '未设置');
    console.log('   Last-Modified:', result.headers['last-modified'] || '未设置');
  } catch (error) {
    console.log(`   检查失败: ${error.message}`);
  }

  console.log('');

  // 4. 性能统计
  console.log('4. 性能统计:');
  const results = [];

  for (const testPath of config.testPaths) {
    const cdnUrl = `https://${config.cdnDomain}${testPath}`;
    const originUrl = `https://${config.originDomain}${testPath}`;

    try {
      const cdnResult = await testUrl(cdnUrl);
      const originResult = await testUrl(originUrl);

      results.push({
        path: testPath,
        cdnTime: cdnResult.responseTime,
        originTime: originResult.responseTime,
        speedup: originResult.responseTime > 0 ?
          ((originResult.responseTime - cdnResult.responseTime) / originResult.responseTime * 100).toFixed(2) : 0
      });
    } catch (error) {
      results.push({
        path: testPath,
        error: error.message
      });
    }
  }

  // 计算平均值
  const validResults = results.filter(r => !r.error);
  if (validResults.length > 0) {
    const avgCdnTime = validResults.reduce((sum, r) => sum + r.cdnTime, 0) / validResults.length;
    const avgOriginTime = validResults.reduce((sum, r) => sum + r.originTime, 0) / validResults.length;
    const avgSpeedup = validResults.reduce((sum, r) => sum + parseFloat(r.speedup), 0) / validResults.length;

    console.log(`   平均CDN响应时间: ${avgCdnTime.toFixed(2)}ms`);
    console.log(`   平均原站响应时间: ${avgOriginTime.toFixed(2)}ms`);
    console.log(`   平均加速比: ${avgSpeedup.toFixed(2)}%`);
  }

  // 显示详细结果
  console.log('');
  console.log('   详细结果:');
  results.forEach(result => {
    if (result.error) {
      console.log(`     ${result.path}: 错误 - ${result.error}`);
    } else {
      console.log(`     ${result.path}: CDN ${result.cdnTime}ms, 原站 ${result.originTime}ms, 加速 ${result.speedup}%`);
    }
  });

  console.log('');
  console.log('=== 监控完成 ===');
}

// 运行监控
if (require.main === module) {
  monitorCDN().catch(console.error);
}

module.exports = { monitorCDN, testUrl, checkDNS };
