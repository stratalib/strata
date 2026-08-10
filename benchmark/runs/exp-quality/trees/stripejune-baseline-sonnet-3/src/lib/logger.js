// Minimal structured logger. Swap for pino/winston later if log volume demands it.
function timestamp() {
  return new Date().toISOString();
}

function log(level, message, meta) {
  const line = { timestamp: timestamp(), level, message, ...(meta ? { meta } : {}) };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
