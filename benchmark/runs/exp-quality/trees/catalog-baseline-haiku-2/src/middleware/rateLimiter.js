'use strict';

const ipRequests = new Map();
const REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!ipRequests.has(ip)) {
    ipRequests.set(ip, []);
  }

  const requests = ipRequests.get(ip);
  const recentRequests = requests.filter(time => now - time < WINDOW_MS);

  if (recentRequests.length >= REQUESTS_PER_MINUTE) {
    return res.status(429).json({ error: 'Rate limit exceeded', requestId: req.id });
  }

  recentRequests.push(now);
  ipRequests.set(ip, recentRequests);

  next();
}

module.exports = rateLimiter;
