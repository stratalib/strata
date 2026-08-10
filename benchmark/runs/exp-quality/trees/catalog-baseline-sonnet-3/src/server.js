'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const requestId = require('./middleware/requestId');
const createRateLimiter = require('./middleware/rateLimit');

const app = express();

// Behind a reverse proxy (nginx, ALB, etc.) req.ip would otherwise resolve to the proxy's address for
// every caller, which would bucket all clients under one rate-limit counter. Trusting the first proxy
// hop makes req.ip resolve from X-Forwarded-For instead.
app.set('trust proxy', 1);

app.use(requestId);
app.use(express.json());
app.use(createRateLimiter({ windowMs: 60_000, max: 100 }));

app.use(healthRoutes);
app.use(productRoutes);

app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ id: req.id, event: 'request.error', message: err.message }));
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));

module.exports = app;
