'use strict';
require('dotenv').config();
const express = require('express');
const {
  badJsonHandler,
  createIdempotencyStore,
  createLogger,
  errorLogger,
  installProcessLogging,
  requestLogger,
} = require('../strata/lib.js');
const healthRoutes = require('./routes/health');
const buildOrdersRouter = require('./routes/orders');

const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('../package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

// In-process only: behind N replicas each has its own store (see strata/lib.js comment on
// createIdempotencyStore). Fine for this service today; a fleet would need this backed by Redis.
const idempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000),
});

const app = express();

app.use(requestLogger(logger));
app.use(express.json());
app.use(badJsonHandler());

app.use(healthRoutes);
app.use(buildOrdersRouter({ idempotencyStore }));

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
