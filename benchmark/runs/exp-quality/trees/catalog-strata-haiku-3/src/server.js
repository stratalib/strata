'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productsRoutes = require('./routes/products');
const {
  createLogger,
  createRateLimiter,
  errorLogger,
  installProcessLogging,
  requestLogger,
  badJsonHandler,
} = require('../strata/lib.js');

const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('../package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

const limiter = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_BURST || 60),
  refillPerSec: Number(process.env.RATE_LIMIT_PER_SEC || 1),
});

const app = express();

app.use(requestLogger(logger));
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const result = limiter.take(ip, 1);
  res.set('ratelimit-remaining', String(result.remaining));
  if (!result.allowed) {
    res.set('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Rate limit exceeded', requestId: req.id });
  }
  next();
});

app.use(express.json());
app.use(healthRoutes);
app.use('/products', productsRoutes);

app.use(badJsonHandler());
app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
