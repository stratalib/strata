'use strict';

// Fixed-window, per-IP rate limiter. For each client IP we keep a request count and the timestamp at
// which its current window ends. Within a window we increment; past the limit we reject with 429.
//
// Tradeoffs, stated so they're not surprises:
//   - Fixed window (not sliding): a client can burst up to 2x the limit across a window boundary. Fine
//     for basic abuse protection; swap for a token bucket if precise smoothing ever matters.
//   - In-memory Map: counters live per process. Behind multiple instances each has its own view — move
//     the store to Redis if you scale horizontally.
// A Map (not a plain object) because we look up and delete by IP key constantly, which is what it's for.

function createRateLimiter({ windowMs = 60_000, max = 100 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Without this sweep the Map grows unbounded — every IP ever seen would linger forever. Drop expired
  // entries periodically; unref() so this timer never keeps the process alive on its own.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function middleware(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
        requestId: req.id,
      });
    }
    next();
  }

  // Expose internals so tests (and a graceful shutdown) can reach the sweeper and the store.
  middleware.hits = hits;
  middleware.stop = () => clearInterval(sweeper);
  return middleware;
}

module.exports = createRateLimiter;
