'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const { requestLogger } = require('./middleware/requestLogger');
const { apiRateLimiter } = require('./middleware/rateLimiter');

const app = express();
// Trust exactly one hop (the reverse proxy/load balancer in front of this service) so
// req.ip reflects the real client. `true` would trust the whole X-Forwarded-For chain,
// letting a client spoof its own IP to dodge the rate limiter below.
app.set('trust proxy', 1);
app.use(requestLogger);
app.use(express.json());
app.use(apiRateLimiter);
app.use(healthRoutes);
app.use(productRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
