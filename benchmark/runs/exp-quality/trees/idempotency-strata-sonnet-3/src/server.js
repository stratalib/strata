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
} = require('../strata/lib.js');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');

// The service name tags every log line, so it is what tells you WHICH service you are reading when
// several ship into one sink. Falls back to package.json's name if SERVICE_NAME is unset.
const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('../package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

// In-process only: behind multiple replicas each has its own store. Fine for this service today;
// would need a shared backend (e.g. Redis) if this ever runs behind more than one instance.
const idempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000),
});

const app = express();

app.use(requestLogger(logger));
app.use(express.json());
app.use(badJsonHandler());
// Required on /orders: a retried "create order" request without a key would be indistinguishable
// from a second, separate order. Optional elsewhere, since GETs are already safe to repeat.
app.use('/orders', idempotencyMiddleware(idempotencyStore, { required: true, methods: ['POST'] }));

app.use(healthRoutes);
app.use(orderRoutes);

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));

module.exports = app;
