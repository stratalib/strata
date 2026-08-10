'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const productRoutes = require('./routes/products');
const requestLogger = require('./middleware/requestLogger');
const rateLimiter = require('./middleware/rateLimiter');

const app = express();
app.use(express.json());
app.use(requestLogger);
app.use(rateLimiter);
app.use(healthRoutes);
app.use(productRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
