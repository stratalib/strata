'use strict';
require('dotenv').config();
const express = require('express');
const {
  createLogger,
  createRateLimiter,
  installProcessLogging,
  rateLimitMiddleware,
  requestLogger,
  errorLogger,
} = require('../strata/lib.js');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');

const logger = createLogger({ name: process.env.SERVICE_NAME || 'catalog-service' });
installProcessLogging(logger);

// Lives in this process's memory: N replicas means N independent limiters, so a "60/min" limit
// really allows 60*N. Fine for a single instance; swap the store for Redis before scaling out.
const limiter = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_BURST || 60),
  refillPerSec: Number(process.env.RATE_LIMIT_PER_SEC || 1),
});

const app = express();

// trust proxy only as many hops deep as TRUST_PROXY_HOPS says — otherwise req.ip is the raw socket
// address and a caller-supplied X-Forwarded-For can't be used to spoof the rate-limit key.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10);
if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

app.use(requestLogger(logger));
app.use(rateLimitMiddleware(limiter));
app.use(express.json());

app.use(healthRoutes);
app.use(productRoutes);

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
