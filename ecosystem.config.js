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
    fs.writeFileSync(secretFile, newSecret, { encoding: 'utf-8', mode: 0o600 });
    console.log('[ecosystem] 已生成新的 SESSION_SECRET 并持久化到 .session_secret');
  } catch (err) {
    console.error('[ecosystem] 保存 .session_secret 文件失败:', err.message);
  }
  
  return newSecret;
}

const sessionSecret = getOrCreateSecret();

// 日志目录兜底：PM2 的 pre_start 钩子并不存在（会被静默忽略），
// logs 目录不存在时 PM2 打不开 error_file/out_file，崩溃日志直接丢失。
try {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
} catch (err) {
  console.error('[ecosystem] 创建 logs 目录失败:', err.message);
}

module.exports = {
  apps: [{
    name: 'website-admin',
    script: 'server/app.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '800M',
    node_args: ['--max-old-space-size=768', '--expose-gc'],
    // 每日 04:00 低峰期自动重启，释放长期运行累积的内存碎片（2G 小内存机建议保留）
    cron_restart: '0 4 * * *',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      SESSION_SECRET: sessionSecret
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      SESSION_SECRET: 'dev-secret-not-for-production'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
    out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
    merge_logs: true,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 30000,
    // 健康检查配置
    min_uptime: '60s',
    wait_ready: true,
    // 10s 太短：数据库初始化 + 播种超过 10 秒就会被 PM2 判为「未就绪」直接杀掉，
    // 表现为 uptime 0 / mem 0b / exit_code 1 的无限重启
    listen_timeout: 30000,
    time: true,
  }]
};