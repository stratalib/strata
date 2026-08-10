import { stripe } from '../config/stripe.js';
import { config } from '../config/env.js';

export function verifyStripeSignature(req, res, next) {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  try {
    req.stripeEvent = stripe.webhooks.constructEvent(
      req.body,
      sig,
      config.stripe.webhookSecret
    );
    next();
  } catch (error) {
    console.error('Stripe webhook verification failed:', error.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }
}
