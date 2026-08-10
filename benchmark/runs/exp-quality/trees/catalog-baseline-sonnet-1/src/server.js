'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productsRoutes = require('./routes/products');
const { requestLogger } = require('./middleware/requestLogger');
const { apiRateLimiter } = require('./middleware/rateLimiter');

const app = express();

// trust one hop of proxy (e.g. a load balancer) so req.ip reflects the real client instead of
// the proxy's address — without this, per-IP rate limiting would bucket everyone together.
app.set('trust proxy', 1);

app.use(express.json());
app.use(requestLogger);
app.use(healthRoutes);
app.use(apiRateLimiter, productsRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));

module.exports = app;
