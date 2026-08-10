import { config } from 'dotenv';
import Stripe from 'stripe';
import crypto from 'crypto';

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function testWebhookSignatureVerification() {
  console.log('Testing Webhook Signature Verification\n');

  // Create a sample event
  const event = {
    id: 'evt_' + crypto.randomBytes(12).toString('hex'),
    object: 'event',
    api_version: '2023-08-16',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'pi_test123',
        object: 'payment_intent',
        status: 'succeeded',
        metadata: {
          orderId: 'ORD-TEST',
          customerEmail: 'test@example.com',
        },
      },
    },
    type: 'payment_intent.succeeded',
  };

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠ STRIPE_WEBHOOK_SECRET not set, skipping signature verification test');
    console.warn('  Set this in .env to test webhook handling\n');
    return;
  }

  // Simulate webhook signature generation
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${JSON.stringify(event)}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const signedHeader = `t=${timestamp},v1=${signature}`;

  console.log('Generated webhook signature header:', signedHeader.substring(0, 30) + '...');

  try {
    // This is how Stripe verifies it on the server
    const verified = stripe.webhooks.constructEvent(payload, signedHeader, secret);
    console.log('✓ Webhook signature verified successfully');
    console.log('  Event ID:', verified.id);
    console.log('  Event type:', verified.type);
  } catch (error) {
    console.error('✗ Webhook signature verification failed:', error.message);
    process.exit(1);
  }

  // Test with tampered signature
  console.log('\nTesting tampered signature detection...');
  const tamperedSignature = `t=${timestamp},v1=invalid${signature.substring(6)}`;
  try {
    stripe.webhooks.constructEvent(payload, tamperedSignature, secret);
    console.error('✗ Tampered signature was not detected!');
    process.exit(1);
  } catch (error) {
    console.log('✓ Tampered signature correctly rejected');
  }

  // Test with old timestamp
  console.log('\nTesting timestamp validation...');
  const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds old (default tolerance is 300)
  const oldPayload = `${oldTimestamp}.${JSON.stringify(event)}`;
  const oldSignature = crypto.createHmac('sha256', secret).update(oldPayload).digest('hex');
  const oldHeader = `t=${oldTimestamp},v1=${oldSignature}`;

  try {
    stripe.webhooks.constructEvent(oldPayload, oldHeader, secret);
    console.warn('⚠ Old timestamp was accepted (tolerance may be configured)');
  } catch (error) {
    console.log('✓ Old timestamp correctly rejected:', error.message.substring(0, 60) + '...');
  }

  console.log('\n✓ Webhook signature verification tests passed');
}

testWebhookSignatureVerification().catch((error) => {
  console.error('Test error:', error);
  process.exit(1);
});
