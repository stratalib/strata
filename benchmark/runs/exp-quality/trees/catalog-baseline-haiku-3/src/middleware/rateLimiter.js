'use strict';
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.ip || req.connection.remoteAddress,
  skip: (req) => req.path === '/health',
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: req.rateLimit.resetTime,
      traceId: req.traceId,
    });
  },
});

module.exports = limiter;
