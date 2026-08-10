'use strict';

const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

function formatLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] ${level}: ${message}${dataStr}`);
}

function info(message, data) {
  formatLog(LOG_LEVELS.INFO, message, data);
}

function warn(message, data) {
  formatLog(LOG_LEVELS.WARN, message, data);
}

function error(message, data) {
  formatLog(LOG_LEVELS.ERROR, message, data);
}

module.exports = { info, warn, error };
