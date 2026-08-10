'use strict';
/**
 * Payment processing demo.
 * Shows how to trigger a complete payment flow:
 * 1. Verify a Stripe webhook signature
 * 2. Send a purchase confirmation email
 * 3. Generate a PDF receipt (with mock data, no queue needed)
 *
 * Usage: node examples/payment-demo.js
 */

const crypto = require('crypto');
const { generateReceipt } = require('../lib/receipt-generator');
const { createCheckoutSessionEvent, createTestSignature } = require('../lib/test-helpers');

async function main() {
  console.log('=== Payment Processing Demo ===\n');

  // 1. Create a mock Stripe event
  console.log('1. Creating a mock Stripe checkout event...');
  const event = createCheckoutSessionEvent({
    customer_email: 'buyer@example.com',
    amount_total: 9999, // $99.99
    currency: 'usd',
    metadata: {
      items: JSON.stringify([
        { name: 'Widget A', quantity: 2, amount: 4999 },
        { name: 'Widget B', quantity: 1, amount: 5000 },
      ]),
    },
  });
  console.log(`   ✓ Event ID: ${event.id}`);
  console.log(`   ✓ Session ID: ${event.data.object.id}`);
  console.log(`   ✓ Amount: $${(event.data.object.amount_total / 100).toFixed(2)}`);
  console.log(`   ✓ Customer: ${event.data.object.customer_email}\n`);

  // 2. Create a valid signature
  console.log('2. Creating a valid Stripe signature...');
  const whSecret = 'whsec_test_secret_for_demo';
  const rawBody = JSON.stringify(event);
  const { header: signatureHeader } = createTestSignature(rawBody, whSecret);
  console.log(`   ✓ Signature header: ${signatureHeader.slice(0, 30)}...\n`);

  // 3. Show what a webhook request would look like
  console.log('3. Webhook request that would be sent to /webhooks/stripe:');
  console.log(`   POST /webhooks/stripe`);
  console.log(`   Content-Type: application/json`);
  console.log(`   Stripe-Signature: ${signatureHeader}`);
  console.log(`   Body: ${rawBody.slice(0, 100)}...\n`);

  // 4. Demonstrate PDF receipt generation
  console.log('4. Generating a PDF receipt...');
  try {
    const pdfBuffer = await generateReceipt({
      orderNumber: event.data.object.id.slice(0, 8).toUpperCase(),
      email: event.data.object.customer_email,
      amount: event.data.object.amount_total,
      currency: event.data.object.currency,
      items: JSON.parse(event.data.object.metadata.items),
      timestamp: Date.now(),
    });
    console.log(`   ✓ PDF generated: ${pdfBuffer.length} bytes\n`);
  } catch (err) {
    console.error(`   ✗ PDF generation failed: ${err.message}\n`);
  }

  // 5. Show the complete flow
  console.log('5. Complete payment flow (when running server + Redis):');
  console.log('   a. Webhook arrives at POST /webhooks/stripe');
  console.log('   b. Server verifies the Stripe signature');
  console.log('   c. Server returns 200 OK immediately (Stripe stops waiting)');
  console.log('   d. Server sends purchase confirmation email to customer');
  console.log('   e. Server enqueues a receipt job to BullMQ');
  console.log('   f. Background worker generates PDF receipt');
  console.log('   g. Background worker sends email with PDF attachment');
  console.log('   h. Customer receives both confirmation and detailed receipt\n');

  console.log('6. To test with a running server:');
  console.log('   - Start Redis: redis-server');
  console.log('   - Start the app: STRIPE_WEBHOOK_SECRET=whsec_test_secret node server.js');
  console.log('   - Send a webhook: See test/payment-flow.test.js\n');
}

main().catch(console.error);
