const { logActivity } = require('../config/activity');

function safeLogActivity(db, data) {
  try {
    logActivity(db, data);
  } catch (err) {
    console.error('[activity-log] Error:', err.message);
  }
}

module.exports = { safeLogActivity };
