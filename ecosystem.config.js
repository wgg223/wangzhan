const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ SESSION_SECRET 持久化存储 ============
// 避免每次 PM2 重启时生成新的随机密钥导致所有用户会话失效
// 首次启动时生成密钥并保存到文件，后续从文件读取
function getOrCreateSecret() {
  const secretFile = path.join(__dirname, '.session_secret');
  
  // 优先使用环境变量
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  
  // 尝试从文件读取持久化的密钥
  try {
    if (fs.existsSync(secretFile)) {
      const secret = fs.readFileSync(secretFile, 'utf-8').trim();
      if (secret.length >= 32) {
        return secret;
      }
    }
  } catch (err) {
    console.error('[ecosystem] 读取 .session_secret 文件失败:', err.message);
  }
  
  // 首次运行：生成新密钥并保存到文件
  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, newSecret, 'utf-8');
    console.log('[ecosystem] 已生成新的 SESSION_SECRET 并持久化到 .session_secret');
  } catch (err) {
    console.error('[ecosystem] 保存 .session_secret 文件失败:', err.message);
  }
  
  return newSecret;
}

const sessionSecret = getOrCreateSecret();

module.exports = {
  apps: [{
    name: 'website-admin',
    script: 'server/app.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '1200M',
    node_args: ['--max-old-space-size=1024', '--expose-gc'],
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      SESSION_SECRET: sessionSecret
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 30000,
    pre_start: 'mkdir -p logs',
    // 健康检查配置
    min_uptime: '60s',
    wait_ready: true,
    listen_timeout: 10000,
    // 日志轮转（通过 PM2 插件）
    combine_logs: true,
    time: true,
  }]
};