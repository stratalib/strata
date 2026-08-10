'use strict';
require('dotenv').config();
const express = require('express');
const {
  CircuitOpenError,
  HttpError,
  badJsonHandler,
  createHttpClient,
  createIdempotencyStore,
  createLogger,
  errorLogger,
  idempotencyMiddleware,
  installProcessLogging,
  requestLogger,
  validateRequest,
} = require('./strata/lib.js');


// The service name tags every log line, so it is what tells you WHICH service you are reading when
// several ship into one sink.
//
// It used to fall back to the literal 'api'. With no .env in a fresh clone (only .env.example), every
// line came out tagged `service: "api"` — indistinguishable from every other Strata-composed service
// on the same sink. Falling back to the project's own package.json name makes an unconfigured deploy
// still attributable, which is the case that actually happens.
const logger = createLogger({
  name: process.env.SERVICE_NAME
    || (() => { try { return require('./package.json').name; } catch { return 'app'; } })(),
});
installProcessLogging(logger);

// NOTE: this store lives in THIS process's memory. Behind N replicas each has its own store, so
// exactly-once degrades to at-most-once-per-instance. For a fleet, back it with Redis (the get/set/
// delete interface is the shape you would hand a Redis adapter).
const idempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000),
});

// One client per upstream. Each gets its OWN circuit breaker — a shared breaker would let a dead
// vendor take down calls to a perfectly healthy one.
//
// baseUrl falls back to a local default rather than passing `undefined` straight through. Without it,
// an unset UPSTREAM_URL produces `new URL(path, undefined)` and the app dies at the first request with
// an opaque error — and a session had to notice and patch that by hand before it could run anything.
// A scaffold that cannot boot on a fresh checkout is not a scaffold.
const upstream = createHttpClient({
  baseUrl: process.env.UPSTREAM_URL || 'http://localhost:4000',
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),   // per ATTEMPT, not for the whole call
  retries: Number(process.env.UPSTREAM_RETRIES || 3),
  headers: process.env.UPSTREAM_KEY ? { authorization: `Bearer ${process.env.UPSTREAM_KEY}` } : {},
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
});

const app = express();

app.use(requestLogger(logger));

app.use(express.json());

// Global idempotency middleware — all POSTs/PUTs/PATCHes are guarded.
// Set required: false globally; individual routes can override for strict endpoints like /orders.
app.use(idempotencyMiddleware(idempotencyStore, { required: false }));


const { validate } = require('./strata/lib.js');

const orderSchema = {
  customerId: { type: 'number', required: true, integer: true, min: 1 },
  items: {
    type: 'array',
    required: true,
    of: 'string',
    maxItems: 100,
  },
  total: { type: 'number', required: true, min: 0.01 },
};

let nextOrderId = 1;
const orders = [];

app.post('/orders', (req, res) => {
  req.log?.info({ body: req.body }, 'POST /orders received');

  const result = validate(req.body, orderSchema);
  if (!result.ok) {
    req.log?.warn({ errors: result.errors }, 'order validation failed');
    return res.status(400).json({
      error: 'validation failed',
      details: result.errors,
    });
  }

  const order = {
    id: nextOrderId++,
    customerId: result.value.customerId,
    items: result.value.items,
    total: result.value.total,
    createdAt: new Date(),
  };

  orders.push(order);
  req.log?.info({ orderId: order.id, customerId: order.customerId, total: order.total }, 'order created');

  res.status(201).json(order);
});

app.get('/orders', (req, res) => {
  res.json(orders);
});

app.get('/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === Number(req.params.id));
  if (!order) {
    return res.status(404).json({ error: 'order not found' });
  }
  res.json(order);
});

app.get('/proxy/:id', async (req, res, next) => {
  try {
    res.json(await upstream.get(`/items/${req.params.id}`));
  } catch (err) {
    // 503 + Retry-After, not 500: an open circuit is a TEMPORARY condition, and saying so lets the
    // caller back off instead of retrying us into the ground.
    if (err instanceof CircuitOpenError) {
      res.set('retry-after', String(Math.ceil(err.msRemaining / 1000)));
      return res.status(503).json({ error: 'upstream unavailable', retryInMs: err.msRemaining });
    }
    next(err);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(badJsonHandler());

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
