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

const app = express();

app.use(requestLogger(logger));

app.use(express.json());

app.use(idempotencyMiddleware(idempotencyStore));


app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(badJsonHandler());

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
