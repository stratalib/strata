'use strict';
/**
 * Send a webhook to a running payment server.
 *
 * Usage:
 *   node test/send-webhook.js [--url http://localhost:3000] [--secret whsec_...]
 */

const { createCheckoutSessionEvent, createTestSignature } = require('../lib/test-helpers');

async function sendWebhook(options = {}) {
  const baseUrl = options.url || process.argv[process.argv.indexOf('--url') + 1] || 'http://localhost:3000';
  const secret = options.secret || process.argv[process.argv.indexOf('--secret') + 1] || 'whsec_test_secret';

  const event = createCheckoutSessionEvent({
    customer_email: 'test@example.com',
    amount_total: 4999, // $49.99
    currency: 'usd',
    metadata: {
      items: JSON.stringify([
        { name: 'Test Product', quantity: 1, amount: 4999 },
      ]),
    },
  });

  const rawBody = JSON.stringify(event);
  const { header } = createTestSignature(rawBody, secret);

  console.log(`Sending webhook to ${baseUrl}/webhooks/stripe`);
  console.log(`Event: ${event.type} (${event.id})`);
  console.log(`Amount: $${(event.data.object.amount_total / 100).toFixed(2)}`);
  console.log(`Email: ${event.data.object.customer_email}`);
  console.log('');

  try {
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': header,
      },
      body: rawBody,
    });

    if (response.status === 200) {
      console.log('✓ Webhook accepted (200 OK)');
      const body = await response.json();
      console.log(`  Response: ${JSON.stringify(body)}`);
      console.log('\nThe server should now:');
      console.log('  1. Send a purchase confirmation email');
      console.log('  2. Queue a PDF receipt job (if Redis is running)');
    } else {
      console.error(`✗ Webhook rejected (${response.status})`);
      const body = await response.json();
      console.error(`  Response: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`✗ Failed to send webhook: ${err.message}`);
  }
}

sendWebhook().catch(console.error);
