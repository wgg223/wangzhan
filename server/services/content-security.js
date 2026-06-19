/**
 * 内容安全扫描服务
 * 提供敏感内容检测、垃圾评论过滤、恶意链接检测等功能
 */

/**
 * 敏感词列表 (示例)
 * 实际使用中建议从配置文件或数据库加载
 */
const SENSITIVE_WORDS = [
  // 这里仅作示例，实际部署时应替换为完整词库
];

/**
 * 可疑链接模式
 */
const SUSPICIOUS_URL_PATTERNS = [
  /https?:\/\/\d+\.\d+\.\d+\.\d+/g, // IP 地址链接
  /https?:\/\/(?:[a-z0-9-]+\.)?(?:xyz|top|club|work|loan|gq|ml|cf|ga)\/[^\s]*/gi, // 可疑顶级域名
  /https?:\/\/bit\.ly\/[^\s]*/gi, // 短链接
  /https?:\/\/tinyurl\.com\/[^\s]*/gi,
  /https?:\/\/shorturl\.at\/[^\s]*/gi,
];

/**
 * 垃圾评论模式
 */
const SPAM_PATTERNS = [
  /(?:免费|领取|红包|加微信|加QQ|兼职|刷单|日赚|月入)/,
  /(?:联系我|私聊我|加我好友|扫码|二维码)/,
  /(?:https?:\/\/[^\s]*){3,}/, // 大量链接
  /(?:[^\w]{5,})/, // 连续特殊字符
];

/**
 * 扫描文本内容中的敏感信息
 * @param {string} text - 要扫描的文本
 * @returns {Object} 扫描结果
 */
function scanText(text) {
  if (!text || typeof text !== 'string') {
    return { safe: true, issues: [], score: 0 };
  }

  const issues = [];
  let score = 0;

  // 1. 检查敏感词
  for (const word of SENSITIVE_WORDS) {
    if (text.includes(word)) {
      issues.push({
        type: 'sensitive_word',
        severity: 'high',
        message: `包含敏感词: ${word}`
      });
      score += 10;
    }
  }

  // 2. 检查可疑链接
  for (const pattern of SUSPICIOUS_URL_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      issues.push({
        type: 'suspicious_url',
        severity: 'medium',
        message: `包含可疑链接: ${matches.slice(0, 3).join(', ')}`,
        count: matches.length
      });
      score += 5 * matches.length;
    }
  }

  // 3. 检查垃圾评论模式
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        type: 'spam_pattern',
        severity: 'medium',
        message: `匹配垃圾内容模式: ${pattern}`
      });
      score += 8;
    }
  }

  // 4. 检查重复内容 (连续重复字符/词语)
  const repeatPattern = /(.)\1{10,}/;
  if (repeatPattern.test(text)) {
    issues.push({
      type: 'repetitive_content',
      severity: 'low',
      message: '包含大量重复字符'
    });
    score += 3;
  }

  // 5. 检查个人信息泄露 (手机号、身份证等)
  const phonePattern = /1[3-9]\d{9}/g;
  const phoneMatches = text.match(phonePattern);
  if (phoneMatches) {
    issues.push({
      type: 'personal_info',
      severity: 'high',
      message: `包含手机号码: ${phoneMatches[0].replace(/\d{4}$/, '****')}`
    });
    score += 10;
  }

  const idCardPattern = /\d{17}[\dXx]/g;
  if (idCardPattern.test(text)) {
    issues.push({
      type: 'personal_info',
      severity: 'high',
      message: '包含身份证号码'
    });
    score += 10;
  }

  return {
    safe: score < 10,
    issues: issues,
    score: score,
    risk: score >= 20 ? 'high' : (score >= 10 ? 'medium' : 'low')
  };
}

/**
 * 扫描 HTML 内容 (去除标签后扫描文本)
 * @param {string} html - HTML 内容
 * @returns {Object} 扫描结果
 */
function scanHtml(html) {
  if (!html) return { safe: true, issues: [], score: 0 };

  // 去除 HTML 标签
  const text = html.replace(/<[^>]*>/g, '');
  return scanText(text);
}

/**
 * 检查内容是否适合发布
 * @param {string} content - 内容文本
 * @param {Object} options - 选项
 * @param {number} options.maxScore - 最大允许分数 (默认 15)
 * @returns {boolean} 是否允许发布
 */
function isContentAllowed(content, options = {}) {
  const maxScore = options.maxScore || 15;
  const result = scanText(content);
  return result.score < maxScore;
}

/**
 * 获取内容安全建议
 * @param {string} content - 内容文本
 * @returns {Object} 安全建议
 */
function getContentAdvice(content) {
  const result = scanText(content);

  if (result.safe) {
    return { action: 'allow', message: '内容安全' };
  }

  if (result.score >= 20) {
    return {
      action: 'block',
      message: '内容包含严重违规信息，已被拦截',
      issues: result.issues
    };
  }

  return {
    action: 'review',
    message: '内容需要人工审核',
    issues: result.issues
  };
}

module.exports = {
  scanText,
  scanHtml,
  isContentAllowed,
  getContentAdvice
};
