import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { handleWebhook } from './lib/webhook-handler.js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook endpoint must receive raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      await handleWebhook(req.body, req.headers['stripe-signature']);
      res.json({ received: true });
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(400).json({ error: err.message });
    }
  }
);

// JSON middleware for other endpoints
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Create payment intent endpoint (for testing)
app.post('/create-payment-intent', async (req, res) => {
  const { amount, email } = req.body;

  if (!amount || !email) {
    return res.status(400).json({ error: 'amount and email required' });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { email },
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Payment processor listening on port ${PORT}`);
});
