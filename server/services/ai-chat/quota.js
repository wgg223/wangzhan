/**
 * AI 聊天配额：每日/总量限额 + 每日重置 + 管理员豁免
 */
const { queryOne } = require('../../config/database');
const { getSettings } = require('../../utils/settings');
const { isAdminRole } = require('../../middlewares/auth');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// 获取配额行（不存在则按设置默认值自动创建）
function getQuotaRow(db, userId) {
  const settings = getSettings(db);
  let row = queryOne(db, 'SELECT * FROM ai_quota WHERE user_id = ?', [userId]);
  if (!row) {
    db.run('INSERT INTO ai_quota (user_id, daily_limit, total_limit, last_reset_date) VALUES (?, ?, ?, ?)',
      [userId,
        parseInt(settings.ai_default_daily_limit, 10) || 50,
        parseInt(settings.ai_default_total_limit, 10) || 1000,
        todayStr()]);
    row = queryOne(db, 'SELECT * FROM ai_quota WHERE user_id = ?', [userId]);
  }
  // 跨天重置
  if (row.last_reset_date !== todayStr()) {
    db.run('UPDATE ai_quota SET daily_used = 0, last_reset_date = ? WHERE id = ?', [todayStr(), row.id]);
    row.daily_used = 0;
    row.last_reset_date = todayStr();
  }
  return row;
}

/**
 * 检查配额是否可用
 * @returns {{ok: boolean, unlimited: boolean, quota: Object, reason?: string}}
 */
function checkQuota(db, user) {
  if (isAdminRole(user)) {
    return { ok: true, unlimited: true, quota: { dailyLimit: 0, dailyUsed: 0, remaining: 0, totalLimit: 0, totalUsed: 0 } };
  }
  const row = getQuotaRow(db, user.id);
  const quota = {
    dailyLimit: row.daily_limit,
    dailyUsed: row.daily_used,
    totalLimit: row.total_limit,
    totalUsed: row.total_used,
    remaining: Math.max(0, row.daily_limit - row.daily_used)
  };
  if (row.daily_used >= row.daily_limit) {
    return { ok: false, unlimited: false, quota, reason: '今日对话次数已用完，请明天再试或联系管理员提高限额' };
  }
  if (row.total_used >= row.total_limit) {
    return { ok: false, unlimited: false, quota, reason: '累计对话次数已达上限，请联系管理员' };
  }
  return { ok: true, unlimited: false, quota };
}

/**
 * 消费配额：成功计入次数 + token 消耗；失败只计次数
 */
function consumeQuota(db, user, { tokens = 0, count = true } = {}) {
  if (isAdminRole(user)) return;
  const row = getQuotaRow(db, user.id);
  db.run('UPDATE ai_quota SET daily_used = daily_used + ?, total_used = total_used + ? WHERE id = ?',
    [count ? 1 : 0, tokens, row.id]);
}

module.exports = { getQuotaRow, checkQuota, consumeQuota, todayStr };
