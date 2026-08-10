'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(express.json());
app.use(healthRoutes);
app.use(orderRoutes);

// express.json() throws a SyntaxError for malformed JSON bodies; without this handler it falls
// through to Express's default HTML error page instead of the JSON API responses used everywhere
// else.
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', details: [err.message] });
  }
  return next(err);
});

const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => console.log(`catalog-service on ${port}`));
}

module.exports = app;
