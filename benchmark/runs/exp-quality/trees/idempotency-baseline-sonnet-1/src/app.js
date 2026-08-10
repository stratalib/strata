'use strict';
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(express.json());
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});
app.use(healthRoutes);
app.use(orderRoutes);

module.exports = app;
