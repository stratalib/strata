'use strict';
const crypto = require('crypto');

function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;

  const start = Date.now();
  const originalJson = res.json;

  res.json = function(data) {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      status: res.statusCode,
      duration: `${duration}ms`,
    }));
    return originalJson.call(this, data);
  };

  next();
}

module.exports = requestLogger;
