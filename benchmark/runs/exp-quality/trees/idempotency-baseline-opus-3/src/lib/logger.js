'use strict';
// Minimal structured logger. One place to control log shape, so every attempt is logged the same way
// and the format can change without hunting through call sites. Structured (JSON) lines are trivial for
// a log aggregator to parse later; a bare console.log string is not.

function log(level, message, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME || 'catalog-service',
    message,
    ...fields,
  });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  info: (message, fields) => log('info', message, fields),
  warn: (message, fields) => log('warn', message, fields),
  error: (message, fields) => log('error', message, fields),
};
