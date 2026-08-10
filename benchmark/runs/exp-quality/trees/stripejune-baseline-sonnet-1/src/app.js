const express = require('express');
const webhookRouter = require('./routes/webhook');
const checkoutRouter = require('./routes/checkout');

function createApp() {
  const app = express();

  // Mounted BEFORE express.json() and with its own express.raw() middleware,
  // so the body stays a raw Buffer for Stripe's signature check.
  app.use('/webhooks', webhookRouter);

  app.use(express.json());

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.use('/api', checkoutRouter);

  app.use((err, req, res, next) => {
    console.error('[app] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
