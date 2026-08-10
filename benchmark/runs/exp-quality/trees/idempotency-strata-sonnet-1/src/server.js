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
const ordersRoutes = require('./routes/orders');

const logger = createLogger({ name: process.env.SERVICE_NAME || 'catalog-service' });
installProcessLogging(logger);

// In-process only (per strata.guide.json: no external store in this project). Behind N replicas
// each instance has its own map, so retries only dedupe within the instance that handled the first
// attempt — acceptable here since the service runs as a single process.
const idempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000,
});

const app = express();
app.use(requestLogger(logger));
app.use(express.json());
app.use(badJsonHandler());
app.use(healthRoutes);
// Scoped to /orders, not global: idempotency is meaningful for the writes it protects, and forcing
// GET /health through it would be pure overhead for a route that's already idempotent by contract.
app.use(idempotencyMiddleware(idempotencyStore, { required: true, methods: ['POST'] }));
app.use(ordersRoutes);
app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
