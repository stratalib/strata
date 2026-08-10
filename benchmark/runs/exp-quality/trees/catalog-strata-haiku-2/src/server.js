'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const {
  createLogger,
  requestLogger,
  errorLogger,
  listQueryMiddleware,
  applyQuery,
  paginateCursor,
} = require('../strata/lib');
const {
  createRateLimiter,
  rateLimitMiddleware,
} = require('../strata/lib');
const products = require('./data/productRepository');

const logger = createLogger({ name: 'catalog-service' });
const rateLimiter = createRateLimiter({ maxBurst: 50, refillMs: 1000 });

const app = express();
app.use(express.json());
app.use(requestLogger(logger));
app.use(rateLimitMiddleware(rateLimiter, { keyFn: (req) => req.ip }));

// Health check
app.use(healthRoutes);

// Products endpoint with pagination
app.get('/items', listQueryMiddleware({ limit: { default: 10, max: 100 } }), (req, res) => {
  const allProducts = products.seed();

  // Apply filtering/sorting from query params
  const filtered = applyQuery(allProducts, req.listQuery, { idField: 'id' });

  // Apply cursor pagination
  const { data, pagination } = paginateCursor(filtered, req.listQuery, { idField: 'id' });

  res.json({
    data,
    pagination,
  });
});

app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info(`catalog-service listening on ${port}`));
