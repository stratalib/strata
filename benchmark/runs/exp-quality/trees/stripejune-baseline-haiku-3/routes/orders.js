import Stripe from 'stripe';
import { randomBytes } from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function generateOrderId() {
  return 'ORD-' + randomBytes(8).toString('hex').toUpperCase();
}

export async function createOrderPaymentRoute(req, res) {
  const { items, customerEmail, customerName, currency = 'usd' } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  if (!customerEmail || !customerName) {
    return res.status(400).json({ error: 'customerEmail and customerName are required' });
  }

  // Validate items
  for (const item of items) {
    if (!item.description || typeof item.price !== 'number' || !item.quantity) {
      return res.status(400).json({
        error: 'Each item must have description, price (number), and quantity',
      });
    }
    if (item.price < 0 || item.quantity < 0) {
      return res.status(400).json({ error: 'Price and quantity must be non-negative' });
    }
  }

  try {
    const orderId = generateOrderId();

    // Calculate total in cents
    const totalCents = Math.round(
      items.reduce((sum, item) => sum + item.price * item.quantity * 100, 0)
    );

    if (totalCents <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than zero' });
    }

    // Create PaymentIntent with metadata
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency,
      payment_method_types: ['card'],
      metadata: {
        orderId,
        customerEmail,
        customerName,
        amount: totalCents,
        currency,
        items: JSON.stringify(items),
      },
      description: `Order ${orderId} for ${customerName}`,
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderId,
      paymentIntentId: paymentIntent.id,
      amount: totalCents,
      currency,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
}
