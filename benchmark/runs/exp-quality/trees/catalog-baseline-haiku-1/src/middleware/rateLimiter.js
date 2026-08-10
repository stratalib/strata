'use strict';

const store = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100;

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!store.has(ip)) {
    store.set(ip, []);
  }

  const requests = store.get(ip);
  const recentRequests = requests.filter(t => now - t < WINDOW_MS);

  if (recentRequests.length >= MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: WINDOW_MS / 1000,
      requestId: req.requestId,
    });
  }

  recentRequests.push(now);
  store.set(ip, recentRequests);
  next();
}

module.exports = rateLimiter;
