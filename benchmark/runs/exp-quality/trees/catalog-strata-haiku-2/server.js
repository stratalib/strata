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

const app = express();

app.use(requestLogger(logger));

app.use(rateLimitMiddleware(limiter));

app.use(express.json());


// INJECT: point the route at this project's real data source.
// These two arrays are an ALLOWLIST, not documentation. A sort or filter field that is not named
// here is silently dropped — which is what keeps a caller-supplied column name out of the query.
const ITEMS_SORTABLE = ['id'];
const ITEMS_FILTERABLE = [];

// The unique key this schema actually uses. NOT always "id" — a Mongoose document keys on _id, and
// hardcoding "id" makes every cursor undefined, so page 2 silently re-serves page 1.
const ITEMS_ID = 'id';

app.get(
  '/items',
  listQueryMiddleware({ sortable: ITEMS_SORTABLE, filterable: ITEMS_FILTERABLE }),
  async (req, res, next) => {
    try {
      // INJECT: point this at the real data source.
      const rows = applyQuery([], req.listQuery, { idField: ITEMS_ID });

      // Cursor by default: it does not skip or duplicate rows when the data changes between pages.
      // ?offset= opts into offset paging for a UI that genuinely needs page numbers.
      res.json(req.query.offset !== undefined
        ? paginateOffset(rows, req.listQuery)
        : paginateCursor(rows, req.listQuery, { idField: ITEMS_ID }));
    } catch (err) {
      next(err);
    }
  },
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
