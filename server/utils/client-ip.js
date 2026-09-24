/**
 * 访问者 IP 解析（水印 / 溯源展示用途）
 * 背景：app.js 默认 trust proxy = 0（不信任任何代理），Nginx 反代后 req.ip 是代理回环/内网地址，
 * 水印里显示的将是「服务器的 IP」而非访客 IP。
 * 策略：优先取 X-Forwarded-For 首段（反代链中最原始的访客 IP），回退 req.ip / socket。
 * 边界：本函数仅用于展示与溯源记录，不是安全边界（伪造 XFF 最多导致溯源文字失真）；
 *       限流 / 验证码 / 安全审计仍应使用 req.ip 并配合 TRUST_PROXY 环境变量配置。
 */
'use strict';

// 规范化：去掉 IPv4-mapped IPv6 前缀（如 ::ffff:192.168.1.100 → 192.168.1.100）
function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice('::ffff:'.length);
  return s;
}

function getClientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
  const first = xff.split(',')[0].trim();
  if (first) return normalizeIp(first);
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

module.exports = { getClientIp, normalizeIp };
