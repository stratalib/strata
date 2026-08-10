'use strict';
require('dotenv').config();
const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const rateLimiter = require('./middleware/rateLimiter');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');

const app = express();

// Only trust X-Forwarded-For when explicitly enabled (e.g. deployed behind a known proxy/LB). Off by
// default so a client can't spoof its IP via the header to escape the rate limit. Value is the number
// of proxy hops to trust, or falsy to trust none.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

app.use(express.json());

// Order matters: assign the request id + start logging first, so even rate-limited requests are
// traceable, then throttle before doing any route work.
app.use(requestLogger);
app.use(rateLimiter);

app.use(healthRoutes);
app.use(productRoutes);

const port = process.env.PORT || 3000;

// Don't listen when imported by a test harness; only when run directly.
if (require.main === module) {
  app.listen(port, () => console.log(`catalog-service on ${port}`));
}

module.exports = app;
