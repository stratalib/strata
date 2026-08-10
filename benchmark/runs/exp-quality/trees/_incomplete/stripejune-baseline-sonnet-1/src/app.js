const express = require('express');
const webhooksRouter = require('./routes/webhooks');
const checkoutRouter = require('./routes/checkout');

function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Mounted first, and raw-parsed internally, so Stripe's signature check
  // sees the exact bytes Stripe signed. Must stay ahead of express.json().
  app.use('/webhooks', webhooksRouter);

  app.use('/checkout', checkoutRouter);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[app] unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
