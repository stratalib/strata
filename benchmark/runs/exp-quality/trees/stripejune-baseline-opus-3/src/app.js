'use strict';

const express = require('express');
const { router: webhookRouter } = require('./routes/webhook');
const logger = require('./lib/logger');

/**
 * Builds the Express app. Exported as a factory (no listen) so tests can drive
 * it with supertest-style injection without binding a port.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Health check for load balancers / readiness probes.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // IMPORTANT: mount the webhook router (which uses express.raw internally)
  // BEFORE any global JSON body parser. If express.json() ran first it would
  // consume the stream and Stripe signature verification would fail.
  app.use('/webhooks', webhookRouter);

  // Any non-webhook routes below here can safely use JSON parsing.
  app.use(express.json());

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('unhandled error', { error: err.message, path: req.path });
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
