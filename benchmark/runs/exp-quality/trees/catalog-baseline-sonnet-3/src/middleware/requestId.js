'use strict';
const crypto = require('crypto');

// Every request gets an id: reuse an inbound X-Request-Id (so callers can pass their own trace id
// through a gateway) or mint one. Logged on the way in and the way out so the two lines can be
// joined on id to get the request's duration and outcome.
function requestId(req, res, next) {
  const id = req.get('x-request-id') || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  const start = process.hrtime.bigint();
  console.log(JSON.stringify({
    id,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    event: 'request.start',
    time: new Date().toISOString(),
  }));

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({
      id,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      event: 'request.finish',
      time: new Date().toISOString(),
    }));
  });

  next();
}

module.exports = requestId;
