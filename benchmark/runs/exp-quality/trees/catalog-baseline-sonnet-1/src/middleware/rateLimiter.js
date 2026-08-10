'use strict';
const rateLimit = require('express-rate-limit');

// Defaults: 100 req/min per IP. Generous enough for normal browsing/pagination, tight enough
// to blunt a scripted scrape. Overridable via env since "right" limit depends on real traffic.
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const max = Number(process.env.RATE_LIMIT_MAX) || 100;

const apiRateLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      requestId: req.requestId,
    });
  },
});

module.exports = { apiRateLimiter };
