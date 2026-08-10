'use strict';
const rateLimit = require('express-rate-limit');

// Per-IP window: 100 requests/minute is generous for normal browsing/paging but
// stops a runaway script or scraper from hammering the catalog.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 100;

const apiRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

module.exports = { apiRateLimiter };
