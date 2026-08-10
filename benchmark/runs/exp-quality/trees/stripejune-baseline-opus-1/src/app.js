'use strict';

const express = require('express');
const { constructEvent } = require('./stripeClient');
const { handleCheckoutCompleted } = require('./orders');

// Build the Express app. Exported as a factory (no listen()) so tests can drive
// it in-process without binding a port.
function createApp() {
  const app = express();

  // --- Stripe webhook ---
  // Mounted BEFORE any JSON body parser and using express.raw() so req.body is
  // the exact Buffer Stripe sent. Signature verification hashes those raw bytes;
  // parsing to JSON first would change them and every verification would fail.
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const signature = req.headers['stripe-signature'];
      let event;
      try {
        event = constructEvent(req.body, signature);
      } catch (err) {
        // Bad signature or malformed payload => this is not a trustworthy
        // request. 400 tells Stripe not to keep retrying a forged/broken one.
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        let result = { status: 'ignored', type: event.type };
        switch (event.type) {
          case 'checkout.session.completed':
            result = await handleCheckoutCompleted(event);
            break;
          // Other event types are acknowledged but not acted on. Returning 200
          // stops Stripe from retrying events we intentionally don't handle.
          default:
            break;
        }
        // Acknowledge quickly. The heavy lifting (PDF + receipt email) already
        // happened on the background queue, not in this request.
        return res.status(200).json({ received: true, result });
      } catch (err) {
        // Something in our processing failed (e.g. confirmation email or
        // enqueue). Return 500 so Stripe retries and we get another chance.
        console.error('Error handling webhook:', err);
        return res.status(500).json({ received: false, error: err.message });
      }
    }
  );

  // JSON parser for all OTHER routes, mounted after the webhook.
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

module.exports = { createApp };
