import Stripe from 'stripe';
import { receiptQueue } from './queue.js';
import { sendPurchaseConfirmation } from './email.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handleWebhook(body, signature) {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  console.log(`Processing webhook event: ${event.type}`);

  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentSucceeded(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
}

async function handlePaymentSucceeded(paymentIntent) {
  const { id, amount, currency, metadata } = paymentIntent;
  const email = metadata?.email;

  if (!email) {
    console.warn('Payment succeeded but no email in metadata:', id);
    return;
  }

  console.log(`Payment succeeded: ${id} for ${email}`);

  // Send immediate purchase confirmation
  try {
    await sendPurchaseConfirmation({
      email,
      paymentIntentId: id,
      amount: amount / 100,
      currency,
    });
  } catch (err) {
    console.error('Failed to send purchase confirmation:', err.message);
  }

  // Enqueue background job for PDF receipt generation
  try {
    await receiptQueue.add('generate-receipt', {
      paymentIntentId: id,
      email,
      amount: amount / 100,
      currency,
      timestamp: new Date().toISOString(),
    });
    console.log(`Queued receipt generation for ${id}`);
  } catch (err) {
    console.error('Failed to queue receipt job:', err.message);
  }
}

async function handlePaymentFailed(paymentIntent) {
  const { id, metadata } = paymentIntent;
  const email = metadata?.email;

  if (!email) {
    console.warn('Payment failed but no email in metadata:', id);
    return;
  }

  console.log(`Payment failed: ${id} for ${email}`);

  // Could send failure notification email here if desired
}
