import 'dotenv/config';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createTestPayment() {
  const email = 'test@example.com';
  const amount = 2999; // $29.99

  console.log(`Creating test payment intent for ${email}...`);

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: { email },
      description: 'Manual test payment',
    });

    console.log(`\nPayment Intent Created:`);
    console.log(`  ID: ${intent.id}`);
    console.log(`  Amount: $${(amount / 100).toFixed(2)}`);
    console.log(`  Status: ${intent.status}`);
    console.log(`  Client Secret: ${intent.client_secret}`);
    console.log(
      `\nTo test the webhook, send a payment_intent.succeeded event with ID: ${intent.id}`
    );

    // Instructions for testing
    console.log(`\nWebhook Testing:
1. In Stripe Dashboard, go to Developers > Webhooks
2. Find your endpoint (http://your-server/webhooks/stripe)
3. Use the "Send test webhook" button
4. Select "payment_intent.succeeded" event type
5. Or use stripe CLI: stripe trigger payment_intent.succeeded`);

    return intent;
  } catch (err) {
    console.error('Failed to create payment intent:', err.message);
    process.exit(1);
  }
}

createTestPayment();
