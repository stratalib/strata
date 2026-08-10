'use strict';

// Fixed-window per-IP rate limit, kept in memory. This service is a single process with no shared
// cache (no Redis in the stack), so an in-memory Map is the honest choice — it resets on restart and
// won't coordinate across instances, which is fine for an internal catalog API but would need to move
// to a shared store (Redis, etc.) before this service is ever run with more than one replica.
function createRateLimiter({ windowMs = 60_000, max = 100 } = {}) {
  const hits = new Map(); // ip -> { count, windowStart }

  // Bound the map's growth: sweep entries whose window has already expired.
  function sweep(now) {
    for (const [ip, entry] of hits) {
      if (now - entry.windowStart >= windowMs) hits.delete(ip);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip;

    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
      if (hits.size % 1000 === 0) sweep(now);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: 'too_many_requests',
        message: `Rate limit exceeded: ${max} requests per ${windowMs / 1000}s`,
      });
    }

    next();
  };
}

module.exports = createRateLimiter;
