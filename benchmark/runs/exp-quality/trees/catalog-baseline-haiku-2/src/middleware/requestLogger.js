'use strict';
const crypto = require('crypto');

function requestLogger(req, res, next) {
  req.id = crypto.randomUUID();
  req.startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    const ip = req.ip;
    console.log(JSON.stringify({
      requestId: req.id,
      method: req.method,
      path: req.path,
      ip,
      statusCode: res.statusCode,
      duration,
    }));
  });

  next();
}

module.exports = requestLogger;
