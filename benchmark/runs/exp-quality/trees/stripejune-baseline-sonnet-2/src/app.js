const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');

function createApp() {
  const app = express();

  // Mounted BEFORE express.json() -- the webhook route needs the raw body
  // for Stripe signature verification, and once express.json() consumes the
  // stream for a route, the raw bytes are gone.
  app.use('/webhooks', webhookRoutes);

  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((err, req, res, next) => {
    console.error('[app] unhandled error:', err);
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}

module.exports = { createApp };
