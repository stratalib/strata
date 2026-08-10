'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(express.json());
app.use(healthRoutes);
app.use(orderRoutes);

// Turn malformed-JSON parse errors into a clean 400 instead of a 500 with a stack trace.
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  return next(err);
});

const port = process.env.PORT || 3000;

// Only listen when run directly (node src/server.js). When required by tests we export the app so
// they can drive it in-process without binding a port.
if (require.main === module) {
  app.listen(port, () => console.log(`catalog-service on ${port}`));
}

module.exports = app;
