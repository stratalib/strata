'use strict';

const express = require('express');
const Stripe = require('stripe');
const { config } = require('./config');
const { createConnection } = require('./redis');
const { enqueueReceipt } = require('./queue');
const { sendConfirmationEmail } = require('./mailer');
const { createWebhookRouter } = require('./webhook');
const { RedisIdempotencyStore } = require('./idempotency');

function buildApp({ stripe, idempotency }) {
  const app = express();

  // IMPORTANT: the Stripe webhook must receive the raw request body so its
  // signature can be verified against the exact bytes Stripe signed. Mount the
  // raw body parser ONLY on this route, before any JSON parser can touch it.
  app.use(
    '/webhook',
    express.raw({ type: 'application/json' }),
    createWebhookRouter({
      stripe,
      idempotency,
      enqueueReceipt,
      sendConfirmationEmail,
    })
  );

  // Everything else can use normal JSON parsing.
  app.use(express.json());

  app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

  return app;
}

function start() {
  const stripe = new Stripe(config.stripe.secretKey);
  const idempotency = new RedisIdempotencyStore(createConnection());
  const app = buildApp({ stripe, idempotency });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Payment server listening on :${config.port} (${config.env})`);
  });

  return server;
}

// Only auto-start when run directly (`node src/server.js`), not when imported by
// a test that wants to build the app with fakes.
if (require.main === module) {
  start();
}

module.exports = { buildApp, start };
