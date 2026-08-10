'use strict';
const crypto = require('crypto');

// Test helper: creates a valid Stripe webhook signature
function createStripeSignature(secret, timestamp, payload) {
  const signedContent = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// Example: craft a checkout.session.completed event
const testEvent = {
  id: 'evt_1test',
  type: 'checkout.session.completed',
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: 'cs_test_abc123',
      customer_email: 'customer@example.com',
      customer_details: {
        email: 'customer@example.com',
      },
      amount_total: 9999, // $99.99 in cents
      metadata: {
        description: 'Test Product',
      },
    },
  },
};

const payload = JSON.stringify(testEvent);
const timestamp = Math.floor(Date.now() / 1000);
const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test123456';
const signature = createStripeSignature(secret, timestamp, payload);

console.log('Test webhook payload:');
console.log('POST /webhooks/stripe');
console.log('Headers:');
console.log(`  stripe-signature: ${signature}`);
console.log('Body:');
console.log(payload);
console.log('\nUsage:');
console.log(`curl -X POST http://localhost:3000/webhooks/stripe \\
  -H "Content-Type: application/json" \\
  -H "stripe-signature: ${signature}" \\
  -d '${payload}'`);
