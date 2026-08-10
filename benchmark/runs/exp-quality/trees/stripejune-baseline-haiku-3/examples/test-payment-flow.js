import { config } from 'dotenv';
import Stripe from 'stripe';

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

async function createOrder() {
  console.log('Creating order...');

  const response = await fetch(`${API_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerEmail: 'customer@example.com',
      customerName: 'John Doe',
      currency: 'usd',
      items: [
        {
          description: 'Premium Widget',
          price: 2999,
          quantity: 1,
        },
        {
          description: 'Extended Warranty',
          price: 999,
          quantity: 1,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Order creation failed: ${response.statusText}`);
  }

  const order = await response.json();
  console.log('Order created:', {
    orderId: order.orderId,
    amount: `$${(order.amount / 100).toFixed(2)}`,
    clientSecret: order.clientSecret.substring(0, 20) + '...',
  });

  return order;
}

async function confirmPaymentWithTestToken(clientSecret) {
  console.log('\nConfirming payment with test token...');

  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: {
      number: '4242424242424242',
      exp_month: 12,
      exp_year: 2025,
      cvc: '314',
    },
  });

  console.log('Payment method created:', paymentMethod.id);

  const confirmed = await stripe.paymentIntents.confirm(clientSecret, {
    payment_method: paymentMethod.id,
  });

  console.log('Payment intent confirmed:', {
    status: confirmed.status,
    id: confirmed.id,
  });

  return confirmed;
}

async function main() {
  try {
    const order = await createOrder();
    const paymentIntent = await confirmPaymentWithTestToken(order.clientSecret);

    if (paymentIntent.status === 'succeeded') {
      console.log('\n✓ Payment succeeded!');
      console.log('Watch server logs for:');
      console.log('  1. Webhook received');
      console.log('  2. Purchase confirmation email sent');
      console.log('  3. Receipt generation queued');
      console.log('  4. Receipt PDF generated and emailed');
    } else {
      console.log('\nPayment status:', paymentIntent.status);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
