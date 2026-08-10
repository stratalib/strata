'use strict';
// Request tracing + access logging. Runs before everything else so a request id is attached to the
// whole lifecycle. We honor an inbound X-Request-Id if a client or upstream proxy already set one, so
// a single trace can span multiple services; otherwise we mint a fresh UUID.

const { randomUUID } = require('crypto');

function requestLogger(req, res, next) {
  const requestId = req.get('x-request-id') || randomUUID();
  req.id = requestId;
  // Echo the id back so the caller can quote it when reporting a problem — that's what makes it traceable.
  res.set('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();

  // Log on finish, not on arrival: only then do we know the status and how long it took. One line per
  // request keeps logs greppable by id.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(JSON.stringify({
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    }));
  });

  next();
}

module.exports = requestLogger;
