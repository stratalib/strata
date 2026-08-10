'use strict';
// Minimal structured logger. Writes one JSON line per event so attempts can be grepped/parsed
// without pulling in a logging framework for a service this small.

function log(level, event, fields = {}) {
  const line = {
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
};
