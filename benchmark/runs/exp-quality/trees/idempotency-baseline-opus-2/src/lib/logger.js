'use strict';
// Minimal structured logger: one JSON object per line (a "JSON Lines" log). Structured instead of
// free-text because these logs are meant to be searched — "every attempt for this idempotency key"
// is a jq/grep one-liner over JSON, but a nightmare over prose. No dependency needed; this is all
// the app's logging needs today.

const SERVICE = process.env.SERVICE_NAME || 'catalog-service';

function write(level, event, fields) {
  // Errors go to stderr, everything else to stdout — the conventional split, so ops tooling can
  // route them differently.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    event,
    ...fields,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  info: (event, fields = {}) => write('info', event, fields),
  warn: (event, fields = {}) => write('warn', event, fields),
  error: (event, fields = {}) => write('error', event, fields),
};
