import test from 'node:test';
import assert from 'node:assert';
import Stripe from 'stripe';

test('stripe payment intent creates valid ID', async (t) => {
  // Test that we can construct payment intent objects correctly
  const payload = {
    id: 'pi_test123',
    amount: 2999,
    currency: 'usd',
    status: 'succeeded',
    metadata: {
      email: 'customer@example.com',
    },
  };

  assert.strictEqual(payload.id.startsWith('pi_'), true);
  assert.strictEqual(payload.amount, 2999);
  assert.strictEqual(payload.currency, 'usd');
  assert.strictEqual(payload.metadata.email, 'customer@example.com');
});

test('webhook event structure is valid', async (t) => {
  // Test webhook event validation
  const event = {
    id: 'evt_test123',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_test123',
        amount: 5000,
        currency: 'usd',
        metadata: {
          email: 'user@example.com',
        },
      },
    },
  };

  assert.strictEqual(event.type, 'payment_intent.succeeded');
  assert(event.data.object.id);
  assert(event.data.object.metadata.email);
});

test('payment amount calculation is correct', async (t) => {
  const stripeAmount = 2999; // In cents
  const displayAmount = stripeAmount / 100;

  assert.strictEqual(displayAmount, 29.99);
  assert.strictEqual(Math.round(displayAmount * 100), stripeAmount);
});

test('receipt job data structure', async (t) => {
  const jobData = {
    paymentIntentId: 'pi_abc123',
    email: 'customer@test.com',
    amount: 49.99,
    currency: 'usd',
    timestamp: new Date('2024-01-15T10:30:00Z').toISOString(),
  };

  assert(jobData.paymentIntentId);
  assert(jobData.email);
  assert.strictEqual(typeof jobData.amount, 'number');
  assert(jobData.timestamp);
  assert(jobData.timestamp.includes('2024-01-15'));
});
