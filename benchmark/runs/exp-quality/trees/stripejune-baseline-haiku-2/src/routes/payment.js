import express from 'express';
import { stripe } from '../config/stripe.js';

const router = express.Router();

router.post('/create-payment-intent', async (req, res) => {
  const { amount, email, description } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      receipt_email: email,
      description: description || '',
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error('Payment intent creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/payment-status/:paymentIntentId', async (req, res) => {
  const { paymentIntentId } = req.params;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    res.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      receiptEmail: paymentIntent.receipt_email,
    });
  } catch (error) {
    console.error('Payment status retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
