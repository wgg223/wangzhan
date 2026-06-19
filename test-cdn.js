/**
 * CDN配置测试脚本
 * 用于验证CDN配置是否正确
 */

require('dotenv').config();
const cdnConfig = require('./cdn-config');
const fs = require('fs');
const path = require('path');

console.log('=== CDN配置测试 ===\n');

// 测试1: 检查配置加载
console.log('1. 配置加载测试:');
console.log('   CDN启用状态:', cdnConfig.enabled);
console.log('   CDN服务商:', cdnConfig.provider);
console.log('   CDN域名:', cdnConfig.baseUrl);
console.log('   原站域名:', cdnConfig.originUrl);
console.log('   版本号:', cdnConfig.version);
console.log('');

// 测试2: 测试URL生成
console.log('2. URL生成测试:');
const testPaths = [
  '/css/style.css',
  '/js/main.js',
  '/assets/images/logo.png',
  '/uploads/user/avatar.jpg',
  '/api/users',
  '/admin/dashboard'
];

testPaths.forEach(testPath => {
  const cdnUrl = cdnConfig.getUrl(testPath);
  const isExcluded = cdnConfig.excludePaths.some(excludePath => testPath.startsWith(excludePath));
  const ext = testPath.substring(testPath.lastIndexOf('.')).toLowerCase();
  const isStatic = cdnConfig.staticExtensions.includes(ext);

  console.log(`   ${testPath}`);
  console.log(`     -> ${cdnUrl}`);
  console.log(`     排除路径: ${isExcluded}, 静态资源: ${isStatic}`);
});

console.log('');

// 测试3: 检查环境变量
console.log('3. 环境变量测试:');
const envVars = [
  'CDN_ENABLED',
  'CDN_BASE_URL',
  'ORIGIN_URL',
  'CDN_VERSION'
];

envVars.forEach(envVar => {
  const value = process.env[envVar];
  console.log(`   ${envVar}: ${value || '未设置'}`);
});

console.log('');

// 测试4: 检查静态资源目录
console.log('4. 静态资源目录测试:');

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  console.log('   public目录存在: ✓');

  const cssDir = path.join(publicDir, 'css');
  const jsDir = path.join(publicDir, 'js');

  if (fs.existsSync(cssDir)) {
    const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'));
    console.log(`   CSS文件数量: ${cssFiles.length}`);
    console.log(`   CSS文件: ${cssFiles.join(', ')}`);
  }

  if (fs.existsSync(jsDir)) {
    const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
    console.log(`   JS文件数量: ${jsFiles.length}`);
    console.log(`   JS文件: ${jsFiles.join(', ')}`);
  }
} else {
  console.log('   public目录不存在: ✗');
}

console.log('');

// 测试5: 生成示例URL
console.log('5. 示例URL生成:');
if (cdnConfig.enabled) {
  console.log('   启用CDN后的URL示例:');
  console.log('   CSS:', cdnConfig.getUrl('/css/style.css'));
  console.log('   JS:', cdnConfig.getUrl('/js/main.js'));
  console.log('   图片:', cdnConfig.getUrl('/assets/images/logo.png'));
} else {
  console.log('   CDN未启用，使用原站URL:');
  console.log('   CSS: /css/style.css');
  console.log('   JS: /js/main.js');
  console.log('   图片: /assets/images/logo.png');
}

console.log('\n=== 测试完成 ===');

// 测试6: 检查Nginx配置文件
console.log('\n6. Nginx配置检查:');
const nginxConfigFile = path.join(__dirname, 'nginx-cdn.conf.example');
if (fs.existsSync(nginxConfigFile)) {
  console.log('   Nginx配置示例文件存在: ✓');
  console.log('   文件路径:', nginxConfigFile);
} else {
  console.log('   Nginx配置示例文件不存在: ✗');
  console.log('   请创建nginx-cdn.conf.example文件');
}

// 测试7: 检查环境变量示例文件
console.log('\n7. 环境变量示例文件检查:');
const envExampleFile = path.join(__dirname, '.env.example');
if (fs.existsSync(envExampleFile)) {
  console.log('   .env.example文件存在: ✓');
  console.log('   文件路径:', envExampleFile);
} else {
  console.log('   .env.example文件不存在: ✗');
  console.log('   请创建.env.example文件');
}

console.log('\n=== 所有测试完成 ===');
