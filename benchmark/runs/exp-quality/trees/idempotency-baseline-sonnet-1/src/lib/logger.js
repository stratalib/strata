'use strict';
// Minimal structured logger. Every line is one JSON object so attempt logs stay greppable/parseable
// without pulling in a logging library for a service this small.

function log(level, msg, fields = {}) {
  const line = { time: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};
