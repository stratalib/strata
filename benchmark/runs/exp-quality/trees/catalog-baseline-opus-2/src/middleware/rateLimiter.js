'use strict';
// Per-IP rate limiting. Uses express-rate-limit (battle-tested: correct sliding window, standard
// RateLimit headers, no memory leak from unbounded IP tracking) rather than a hand-rolled counter.
//
// The default store is in-memory, so each process counts independently. That's right for this
// single-instance service; behind a load balancer you'd point it at a shared store (e.g. Redis) so the
// limit is enforced across instances.

const rateLimit = require('express-rate-limit');

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000; // 1 minute
const max = Number(process.env.RATE_LIMIT_MAX) || 100; // requests per window per IP

const rateLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true, // send RateLimit-* headers so clients can self-throttle
  legacyHeaders: false,
  // Custom handler so a throttled request still carries the trace id and a consistent JSON shape.
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      requestId: req.id,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    });
  },
});

module.exports = rateLimiter;
