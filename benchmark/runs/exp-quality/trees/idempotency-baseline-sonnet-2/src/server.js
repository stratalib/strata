'use strict';
require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');
const orderRoutes = require('./routes/orders');
const logger = require('./logger');

const app = express();
app.use(express.json());

// express.json() throws a SyntaxError for malformed JSON bodies; without this handler that becomes
// Express's default HTML error page instead of the JSON error response every other validation failure
// returns.
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});

app.use(healthRoutes);
app.use(orderRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info('server.listening', { port }));
