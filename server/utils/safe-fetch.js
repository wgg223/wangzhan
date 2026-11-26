/**
 * 安全外部抓取工具（防 SSRF / 资源耗尽）
 * 用于"从 URL 导入角色卡"等用户可控 URL 的服务端抓取场景：
 *   1. 仅允许 http/https；
 *   2. 自定义 DNS lookup：连接建立时校验解析出的 IP，拒绝环回/私网/链路本地/
 *      元数据地址（169.254.169.254 等），校验与连接使用同一结果，防 DNS rebinding；
 *   3. 重定向最多 maxRedirects 次，每一跳都重新走安全校验；
 *   4. 响应体超过 maxBytes 立即断开，防止无界缓冲打爆内存。
 * 注意：用户自填的 AI 模型端点（可能合法地位于内网，如本机 Ollama）不使用本工具。
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

// IPv4 私网/保留段判定
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true; // 畸形一律拒绝
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;             // 192.0.0/24、192.0.2/24 等保留
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a >= 224) return true;                          // 组播 / 保留 / 广播
  return false;
}

function isPrivateIP(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6（::ffff:10.0.0.1）
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower === '::1' || lower === '::') return true;
  if (/^f[cd]/.test(lower)) return true;   // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (lower.startsWith('2001:db8')) return true; // 文档段
  if (lower.includes(':')) return false;   // 其余公网 IPv6
  return isPrivateIPv4(lower);
}

// 自定义 lookup：http.request 建连时调用，校验后只返回公网地址。
// Node 20.13+/24 的 autoSelectFamily 会传 options.all=true，并期望回调
// (null, [{ address, family }])；旧签名 (null, address, family) 会被当成
// 地址数组解析，抛 ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined。
function safeLookup(hostname, options, callback) {
  const opts = options && typeof options === 'object' ? options : { family: Number(options) || 0 };
  const all = Boolean(opts.all);
  const lookupOpts = { all: true };
  if (opts.family === 4 || opts.family === 6) lookupOpts.family = opts.family;
  if (opts.hints) lookupOpts.hints = opts.hints;
  dns.lookup(hostname, lookupOpts, (err, addresses) => {
    if (err) return callback(err);
    const list = (Array.isArray(addresses) ? addresses : [addresses])
      .filter(item => item && item.address && !isPrivateIP(item.address));
    if (!list.length) return callback(new Error('禁止访问内网或保留地址'));
    if (all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * 安全抓取，返回 { buffer, contentType }
 * @param {string} url 目标 URL
 * @param {object} opts { maxBytes=2MB, maxRedirects=3, timeoutMs=15000 }
 */
function abortError() {
  return Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' });
}

async function safeFetchBuffer(url, opts = {}) {
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects == null ? 3 : opts.maxRedirects;
  const timeoutMs = opts.timeoutMs || 15000;
  const signal = opts.signal;
  let current = String(url);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal && signal.aborted) throw abortError();
    let parsed;
    try { parsed = new URL(current); } catch (e) { throw new Error('URL 格式不正确'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('仅支持 http/https 协议');
    }
    if (parsed.username || parsed.password) throw new Error('URL 不允许包含账号密码');
    // 主机直接写 IP 时 Node 会跳过 lookup，自定义 safeLookup 不会执行，必须在请求前拦截。
    const literalHost = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literalHost) && isPrivateIP(literalHost)) {
      throw new Error('禁止访问内网或保留地址');
    }
    const client = parsed.protocol === 'https:' ? https : http;
    let request;
    const onAbort = () => {
      if (request) request.destroy(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let result;
    try {
      result = await new Promise((resolve, reject) => {
        request = client.get(parsed, {
          headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) },
          timeout: timeoutMs,
          lookup: safeLookup
        }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            resp.resume(); // 丢弃重定向响应体
            let next;
            try {
              next = new URL(resp.headers.location, parsed).toString();
            } catch (e) {
              reject(new Error('重定向地址无效'));
              return;
            }
            resolve({ redirect: next });
            return;
          }
          const chunks = [];
          let total = 0;
          resp.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              request.destroy();
              reject(new Error('响应内容过大'));
              return;
            }
            chunks.push(chunk);
          });
          resp.on('end', () => resolve({
            buffer: Buffer.concat(chunks),
            contentType: resp.headers['content-type'] || '',
            status: resp.statusCode || 0
          }));
          resp.on('error', reject);
        });
        request.on('error', reject);
        request.on('timeout', () => { request.destroy(); reject(new Error('请求超时')); });
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (result.redirect) { current = result.redirect; continue; }
    return result;
  }
  throw new Error('重定向次数过多');
}

module.exports = { safeFetchBuffer, isPrivateIP };
