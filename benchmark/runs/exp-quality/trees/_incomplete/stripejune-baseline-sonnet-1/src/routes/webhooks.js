const express = require('express');
const { config } = require('../config/env');
const stripe = require('../services/stripeClient');
const orders = require('../db/orders');
const { handleCheckoutCompleted } = require('../services/purchaseHandler');

const router = express.Router();

// Stripe requires the exact raw request bytes to verify the signature, so this
// route must receive an unparsed Buffer body — it is mounted before any
// express.json() middleware in app.js.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Stripe delivers events at-least-once; skip anything we've already handled.
  if (orders.hasProcessedEvent(event.id)) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }
      default:
        // Unhandled event types are acknowledged but ignored.
        break;
    }

    orders.markEventProcessed(event.id, event.type);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[webhook] error handling event ${event.id} (${event.type}):`, err);
    // 500 tells Stripe to retry; the event is not marked processed.
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
