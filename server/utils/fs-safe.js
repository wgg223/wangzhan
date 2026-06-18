const fs = require('fs');
const logger = require('./logger');

function safeUnlinkSync(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err) {
    logger.error('safeUnlinkSync failed:', filePath, err && err.message ? err.message : err);
    return false;
  }
}

async function safeUnlink(filePath) {
  return new Promise((resolve) => {
    fs.unlink(filePath, (err) => {
      if (err) {
        logger.error('safeUnlink failed:', filePath, err && err.message ? err.message : err);
        return resolve(false);
      }
      resolve(true);
    });
  });
}

module.exports = { safeUnlinkSync, safeUnlink };
