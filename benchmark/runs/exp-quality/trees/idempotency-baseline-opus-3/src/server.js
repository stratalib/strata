'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');
const logger = require('./lib/logger');

const app = express();
app.use(express.json());
app.use(healthRoutes);
app.use(orderRoutes);

// Turn malformed-JSON body-parser failures into a clean JSON 400 (Express's default is an HTML error
// page). Four args (err, req, res, next) is what marks this as an error handler to Express.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    logger.warn('request.bad_json', { path: req.path });
    return res.status(400).json({ error: 'ValidationError', details: ['request body must be valid JSON'] });
  }
  logger.error('request.unhandled_error', { path: req.path, message: err.message });
  return res.status(500).json({ error: 'InternalError' });
});

// Only start listening when run directly. When required from a test the app is exported unstarted, so
// tests can drive it in-process without binding a port.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => logger.info('server.start', { port: Number(port) }));
}

module.exports = app;
