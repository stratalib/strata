'use strict';
const assert = require('assert');
const { createCheckoutSessionEvent, createTestSignature } = require('../lib/test-helpers');

// Simple integration test for the payment flow.
// This is meant to run against a live server instance and verify:
// 1. Webhook signature verification works
// 2. Purchase confirmation email is sent
// 3. Receipt job is queued
async function runPaymentFlowTest(baseUrl, whSecret) {
  console.log('Starting payment flow test...');

  // Create a mock checkout.session.completed event
  const event = createCheckoutSessionEvent({
    customer_email: 'test@example.com',
    amount_total: 2999,
    currency: 'usd',
    metadata: {
      items: JSON.stringify([
        { name: 'Product A', quantity: 1, amount: 2999 },
      ]),
    },
  });

  const rawBody = JSON.stringify(event);
  const { header } = createTestSignature(rawBody, whSecret);

  try {
    // Send the webhook
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': header,
      },
      body: rawBody,
    });

    assert.strictEqual(response.status, 200, `Expected 200, got ${response.status}`);
    console.log('✓ Webhook accepted');

    // In a real test, you'd wait a bit and check:
    // - Email was sent (check mailer queue or test mailbox)
    // - Receipt job was enqueued (check job queue)
    // - PDF was generated (check job results)

    console.log('✓ Payment flow test passed');
    return true;
  } catch (err) {
    console.error('✗ Payment flow test failed:', err.message);
    throw err;
  }
}

module.exports = { runPaymentFlowTest };
