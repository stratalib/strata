'use strict';
const { v4: uuidv4 } = require('uuid');

function requestLogger(req, res, next) {
  const traceId = uuidv4();
  req.traceId = traceId;

  const start = Date.now();
  const ip = req.ip || req.connection.remoteAddress;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = {
      traceId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      ip,
      durationMs: duration,
      query: Object.keys(req.query).length > 0 ? req.query : undefined,
    };
    console.log(JSON.stringify(log));
  });

  next();
}

module.exports = requestLogger;
