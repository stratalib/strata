const express = require('express');
const { createWebhookRouter } = require('./routes/webhook');
const logger = require('./lib/logger');

function createApp(redisConnection) {
  const app = express();

  app.disable('x-powered-by');

  // Mounted before any global JSON body parser: this route needs the raw body
  // for Stripe signature verification (see routes/webhook.js).
  app.use(createWebhookRouter(redisConnection));

  // Any other JSON routes would go through the normal parser below this line.
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
