const { queryOne, getDb, saveDatabase } = require('../config/database');

function ensureMaintenanceSettings(db) {
  const defaults = [
    ['maintenance_mode', 'false'],
    ['maintenance_title', '系统维护中'],
    ['maintenance_message', '系统正在进行维护升级，请稍后再试。']
  ];

  let changed = false;
  for (const [key, value] of defaults) {
    const existing = queryOne(db, `SELECT id FROM settings WHERE setting_key = '${key}'`);
    if (!existing) {
      db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('${key}', '${value}')`);
      changed = true;
    }
  }
  if (changed) {
    try { saveDatabase(); } catch (e) { /* ignore */ }
  }
}

function getMaintenanceStatus() {
  try {
    const db = getDb();
    if (!db) return { enabled: false };

    ensureMaintenanceSettings(db);

    const setting = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_mode'");
    const message = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_message'");
    const title = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_title'");
    return {
      enabled: setting?.setting_value === 'true',
      title: title?.setting_value || '系统维护中',
      message: message?.setting_value || '系统正在进行维护升级，请稍后再试。'
    };
  } catch (err) {
    return { enabled: false };
  }
}

function maintenanceMiddleware(req, res, next) {
  // Always set csrfToken for templates
  if (!res.locals.csrfToken) {
    res.locals.csrfToken = req.session?.doubleSubmitToken || '';
  }

  const status = getMaintenanceStatus();

  if (!status.enabled) {
    return next();
  }

  const path = req.path;

  // Allow admin routes, health check, setup, static assets, and API calls
  if (path.startsWith('/admin') ||
      path.startsWith('/auth') ||
      path.startsWith('/health') ||
      path.startsWith('/setup') ||
      path.startsWith('/css/') ||
      path.startsWith('/js/') ||
      path.startsWith('/uploads/') ||
      path.startsWith('/assets/') ||
      path.startsWith('/rp-hub/') ||
      req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return next();
  }

  // Return maintenance page for all other routes
  res.status(503).render('maintenance', {
    title: status.title,
    message: status.message
  });
}

module.exports = { maintenanceMiddleware, getMaintenanceStatus };
