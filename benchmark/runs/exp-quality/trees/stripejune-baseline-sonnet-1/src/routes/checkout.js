const express = require('express');
const stripe = require('../lib/stripeClient');
const { config } = require('../lib/config');

const router = express.Router();

// Creates a Stripe Checkout Session for a single line item.
// Expects: { productName, unitAmount (integer cents), quantity, customerEmail, successUrl, cancelUrl }
router.post('/create-checkout-session', async (req, res) => {
  const { productName, unitAmount, quantity, customerEmail, successUrl, cancelUrl } = req.body || {};

  if (!productName || !Number.isInteger(unitAmount) || unitAmount <= 0) {
    return res.status(400).json({ error: 'productName and a positive integer unitAmount (in cents) are required' });
  }
  if (!successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'successUrl and cancelUrl are required' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
          price_data: {
            currency: config.stripe.currency,
            unit_amount: unitAmount,
            product_data: { name: productName },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    req.log?.error?.(err) ?? console.error('Failed to create checkout session', err);
    res.status(502).json({ error: 'Unable to create checkout session' });
  }
});

module.exports = router;
