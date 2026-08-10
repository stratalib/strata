const express = require('express');
const stripe = require('../services/stripeClient');
const { config } = require('../config/env');

const router = express.Router();

// Creates a Stripe Checkout session for a single line item. In a real
// storefront the price/quantity would come from a cart persisted server-side,
// not trusted client input — this trusts the request body for simplicity.
router.post('/', express.json(), async (req, res) => {
  const { priceId, quantity = 1, customerEmail, description } = req.body || {};

  if (!priceId) {
    return res.status(400).json({ error: 'priceId is required' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity }],
      customer_email: customerEmail,
      metadata: description ? { description } : undefined,
      success_url: `${config.publicBaseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicBaseUrl}/checkout/cancel`,
    });

    return res.status(201).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[checkout] failed to create session:', err.message);
    return res.status(502).json({ error: 'stripe_error', message: err.message });
  }
});

module.exports = router;
