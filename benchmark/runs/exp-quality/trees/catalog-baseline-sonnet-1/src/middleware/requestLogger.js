'use strict';
const crypto = require('crypto');

// Trace header lets a caller correlate their own logs with ours; we still mint our own id
// if they don't send one, so every request is traceable even from untrusted clients.
const REQUEST_ID_HEADER = 'x-request-id';

function requestLogger(req, res, next) {
  const requestId = req.headers[REQUEST_ID_HEADER] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    }));
  });

  next();
}

module.exports = { requestLogger, REQUEST_ID_HEADER };
