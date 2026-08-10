import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { stripe } from '../src/config/stripe.js';

// Mock test for Stripe webhook signature verification
test('Stripe webhook signature verification', async (t) => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'payment_intent.succeeded', id: 'evt_test' });

  const timestamp = Math.floor(Date.now() / 1000);
  const testSignature = `t=${timestamp},v1=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')}`;

  await t.test('should verify valid signature', () => {
    try {
      const event = stripe.webhooks.constructEvent(payload, testSignature, secret);
      assert.equal(event.type, 'payment_intent.succeeded');
    } catch (error) {
      assert.fail(`Should not throw: ${error.message}`);
    }
  });

  await t.test('should reject invalid signature', () => {
    const invalidSig = 't=invalid,v1=invalid';
    assert.throws(
      () => stripe.webhooks.constructEvent(payload, invalidSig, secret),
      /No signatures found/i
    );
  });
});
