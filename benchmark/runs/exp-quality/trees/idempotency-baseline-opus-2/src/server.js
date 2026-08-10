'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const { router: orderRoutes } = require('./routes/orders');
const log = require('./lib/logger');

const app = express();
app.use(express.json());

// express.json() throws a SyntaxError on a malformed body. Catch it here so callers get a clean JSON
// 400 instead of Express's default HTML error page — malformed JSON is the first way a body can be
// invalid, so it belongs with the rest of our validation surface.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    log.warn('request.invalid-json', { path: req.path });
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  return next(err);
});

app.use(healthRoutes);
app.use(orderRoutes);

// Export the app so tests can drive it without binding a port. Only listen when run directly.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => log.info('server.started', { port: Number(port) }));
}

module.exports = app;
