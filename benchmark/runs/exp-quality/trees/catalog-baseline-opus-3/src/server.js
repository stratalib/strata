'use strict';
require('dotenv').config();
const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const createRateLimiter = require('./middleware/rateLimit');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');

const app = express();

// trust proxy stays OFF: with it off, req.ip is the real socket address and can't be spoofed via
// X-Forwarded-For. If this ever runs behind a trusted proxy/load balancer, set app.set('trust
// proxy', ...) so the limiter keys on the true client IP instead of the proxy's.

app.use(express.json());

// Logging first so every request — including rate-limited ones — gets an id and a log line.
app.use(requestLogger);

app.use(createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
}));

app.use(healthRoutes);
app.use(productRoutes);

// JSON error handler (4 args = Express treats it as the error handler). Keeps the request id in the
// response so a failing call is traceable.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.log(JSON.stringify({
    level: 'error',
    requestId: req.id,
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  }));
  res.status(500).json({ error: 'Internal Server Error', requestId: req.id });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
