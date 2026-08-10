'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const {
  createLogger,
  createRateLimiter,
  errorLogger,
  installProcessLogging,
  rateLimitMiddleware,
  requestLogger,
} = require('../strata/lib.js');

// The service name tags every log line, so it is what tells you WHICH service you are reading when
// several ship into one sink.
const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('../package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

// NOTE: this limiter lives in THIS process's memory. Behind N replicas you get N independent
// limiters, so a "60/min" limit really allows 60*N. Fine on a single instance; swap the store for
// Redis before scaling out.
const limiter = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_BURST || 60),        // burst
  refillPerSec: Number(process.env.RATE_LIMIT_PER_SEC || 1),   // sustained rate
});

const app = express();

// trust proxy is OFF unless explicitly configured: rateLimitMiddleware keys on req.ip, and req.ip
// only reflects X-Forwarded-For when Express is told how many hops of proxy to trust. Trusting it
// blindly lets a caller spoof the header and pick a fresh IP (and fresh rate-limit bucket) per request.
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

app.use(requestLogger(logger));
app.use(rateLimitMiddleware(limiter));
app.use(express.json());

app.use(healthRoutes);
app.use('/products', productRoutes);

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
