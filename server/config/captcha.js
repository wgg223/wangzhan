/**
 * 图形验证码模块
 * 使用 svg-captcha 生成 SVG 格式的图形验证码
 */
const svgCaptcha = require('svg-captcha');

/**
 * 生成 SVG 图形验证码
 * @returns {{ svg: string, text: string }} 包含 SVG 内容和验证码文本
 */
function generateCaptcha() {
  const captcha = svgCaptcha.createMathExpr({
    mathMin: 1,
    mathMax: 20,
    mathOperator: '+',
    width: 120,
    height: 40,
    fontSize: 36,
    color: true,
    noise: 2,
    background: '#f0f4f8'
  });

  // 如果生成的表达式有问题，回退到普通字符验证码
  if (!captcha.text || captcha.text.length === 0) {
    return generateTextCaptcha();
  }

  return captcha;
}

/**
 * 生成纯文本 SVG 验证码（备选方案）
 * @returns {{ svg: string, text: string }}
 */
function generateTextCaptcha() {
  const captcha = svgCaptcha.create({
    size: 4,
    width: 120,
    height: 40,
    fontSize: 40,
    charPreset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    color: true,
    noise: 2,
    background: '#f0f4f8'
  });
  return captcha;
}

/**
 * 验证用户输入的验证码是否正确（不区分大小写）
 * @param {string} userInput - 用户输入的验证码
 * @param {string} captchaText - 存储的正确验证码文本
 * @returns {boolean}
 */
function verifyCaptcha(userInput, captchaText) {
  if (!userInput || !captchaText) return false;
  return userInput.toUpperCase() === captchaText.toUpperCase();
}

module.exports = {
  generateCaptcha,
  generateTextCaptcha,
  verifyCaptcha
};
