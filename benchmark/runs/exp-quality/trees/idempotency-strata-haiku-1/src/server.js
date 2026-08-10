'use strict';
require('dotenv').config();
const express = require('express');
const { createLogger, requestLogger, errorLogger, badJsonHandler } = require('../strata/lib.js');
const healthRoutes = require('./routes/health');
const ordersRoutes = require('./routes/orders');

const logger = createLogger({ name: 'catalog-service' });
const app = express();

app.use(requestLogger(logger));
app.use(express.json());
app.use(badJsonHandler());
app.use(healthRoutes);
app.use(ordersRoutes);
app.use(errorLogger(logger));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
