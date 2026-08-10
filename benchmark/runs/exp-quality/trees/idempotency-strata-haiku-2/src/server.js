'use strict';
require('dotenv').config();
const express = require('express');
const {
  badJsonHandler,
  createIdempotencyStore,
  createLogger,
  errorLogger,
  idempotencyMiddleware,
  installProcessLogging,
  requestLogger,
  validateRequest,
} = require('../strata/lib.js');
const healthRoutes = require('./routes/health');
const ordersRoutes = require('./routes/orders');

const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('../package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

const idempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000),
});

const app = express();

app.use(requestLogger(logger));

app.use(express.json());

app.use(idempotencyMiddleware(idempotencyStore));

app.use(healthRoutes);
app.use(ordersRoutes);

app.use(badJsonHandler());

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
