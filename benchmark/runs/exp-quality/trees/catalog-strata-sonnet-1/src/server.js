'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const {
  createLogger,
  installProcessLogging,
  requestLogger,
  errorLogger,
  createRateLimiter,
  rateLimitMiddleware,
} = require('../strata/lib.js');

// SERVICE_NAME tags every log line, so it's what tells you which service you're reading when
// several ship into one sink. Falls back to package.json's name rather than a generic default so
// an unconfigured deploy is still attributable.
const logger = createLogger({
  name: process.env.SERVICE_NAME || require('../package.json').name,
});
installProcessLogging(logger);

// Token-bucket, keyed by req.ip (not x-forwarded-for, which is caller-controlled and spoofable).
// Lives in this process's memory: behind N replicas a "60/min" limit really allows 60*N — fine for
// a single instance, swap the store for Redis before scaling out.
const limiter = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_BURST || 60),
  refillPerSec: Number(process.env.RATE_LIMIT_PER_SEC || 1),
});

const app = express();

app.use(requestLogger(logger));
app.use(rateLimitMiddleware(limiter));
app.use(express.json());

app.use(healthRoutes);
app.use(productRoutes);

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
