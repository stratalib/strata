'use strict';
// Per-IP fixed-window rate limiter, dependency-free and in-memory.
//
// Why fixed-window and not a library: this repo pins only express + dotenv and ships no lockfile, so
// pulling in express-rate-limit risks an environment where `npm start` can't resolve it. A fixed
// window is a few lines, has no deps, and is plenty for protecting an internal catalog API. Its one
// weakness — a caller can burst up to 2x the limit across a window boundary — doesn't matter here.
//
// In-memory means the counters are per-process: if you run multiple instances behind a load
// balancer, each enforces its own limit. For a single-process service that's fine; a multi-instance
// deploy would want a shared store (e.g. Redis).

function createRateLimiter({ windowMs = 60_000, max = 100 } = {}) {
  // ip -> { count, resetAt }
  const buckets = new Map();

  // Periodically drop expired buckets so an attacker can't grow memory by rotating through IPs.
  // unref() lets the process exit even with this timer pending.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(ip);
    }
  }, windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function middleware(req, res, next) {
    const now = Date.now();
    const key = req.ip;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (bucket.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${resetSeconds}s.`,
        requestId: req.id,
      });
    }

    next();
  }

  // Expose the store for testing/inspection.
  middleware.buckets = buckets;
  return middleware;
}

module.exports = createRateLimiter;
