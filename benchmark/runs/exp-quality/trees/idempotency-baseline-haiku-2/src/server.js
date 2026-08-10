'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(express.json());
app.use(healthRoutes);
app.use(orderRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`catalog-service on ${port}`));
