'use strict';
require('dotenv').config();
const express = require('express');

const requestId = require('./middleware/requestId');
const requestLogger = require('./middleware/requestLogger');
const createRateLimiter = require('./middleware/rateLimit');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');

const app = express();

// Trust the proxy so req.ip is the real client address (from X-Forwarded-For) rather than the load
// balancer's — without this, per-IP rate limiting would treat every proxied client as one IP.
app.set('trust proxy', true);

app.use(express.json());

// Order matters:
//  1. requestId  — assigns req.id so everything downstream can reference it.
//  2. logger     — registers a finish listener, so it logs every response including 429s below it.
//  3. rateLimit  — blocked requests still get a log line, then get rejected.
app.use(requestId);
app.use(requestLogger);

const rateLimiter = createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
});
app.use(rateLimiter);

// Health check is intentionally still subject to logging + rate limiting; nothing here is exempt.
app.use(healthRoutes);
app.use(productRoutes);

// Fallthrough 404 + JSON error handler. Both echo the request id so a failure is traceable to a log line.
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', requestId: req.id });
});
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ id: req.id, error: err.message, stack: err.stack }));
  res.status(500).json({ error: 'Internal Server Error', requestId: req.id });
});

const port = process.env.PORT || 3000;

// Only listen when run directly, so tests can require the app without binding a port.
if (require.main === module) {
  const server = app.listen(port, () => console.log(`catalog-service on ${port}`));
  const shutdown = () => {
    rateLimiter.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { app, rateLimiter };
