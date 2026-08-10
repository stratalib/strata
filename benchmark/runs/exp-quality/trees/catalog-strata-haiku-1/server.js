'use strict';
require('dotenv').config();
const express = require('express');
const {
  applyQuery,
  createLogger,
  createRateLimiter,
  errorLogger,
  installProcessLogging,
  listQueryMiddleware,
  paginateCursor,
  paginateOffset,
  rateLimitMiddleware,
  requestLogger,
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

// NOTE: this limiter lives in THIS process's memory. Behind N replicas you get N independent
// limiters, so a "60/min" limit really allows 60*N. Fine on a single instance; swap the store for
// Redis before scaling out.
const limiter = createRateLimiter({
  capacity: Number(process.env.RATE_LIMIT_BURST || 60),        // burst
  refillPerSec: Number(process.env.RATE_LIMIT_PER_SEC || 1),   // sustained rate
});

const productRepository = require('./src/data/productRepository');

const app = express();

app.use(requestLogger(logger));

app.use(rateLimitMiddleware(limiter));

app.use(express.json());

const PRODUCTS_SORTABLE = ['id', 'name', 'price', 'category', 'createdAt'];
const PRODUCTS_FILTERABLE = ['category', 'active'];
const PRODUCTS_ID = 'id';

app.get(
  '/products',
  listQueryMiddleware({ sortable: PRODUCTS_SORTABLE, filterable: PRODUCTS_FILTERABLE }),
  async (req, res, next) => {
    try {
      const rows = await productRepository.findAll();
      const sorted = applyQuery(rows, req.listQuery, { idField: PRODUCTS_ID });

      res.json(req.query.offset !== undefined
        ? paginateOffset(sorted, req.listQuery)
        : paginateCursor(sorted, req.listQuery, { idField: PRODUCTS_ID }));
    } catch (err) {
      next(err);
    }
  },
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
