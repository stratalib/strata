'use strict';
require('dotenv').config();
const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const rateLimiter = require('./middleware/rateLimiter');
const healthRoutes = require('./routes/health');
const productsRoutes = require('./routes/products');

const app = express();
app.use(express.json());
app.use(requestLogger);
app.use(rateLimiter);
app.use(healthRoutes);
app.use(productsRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
