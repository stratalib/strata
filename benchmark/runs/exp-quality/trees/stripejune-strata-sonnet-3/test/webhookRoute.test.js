'use strict';
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { createStripeWebhook, createWebhookEventLog } = require('strata-composed');

// Exercises the same middleware server.js mounts, wired to a mock onEvent — this is what proves
// the route accepts a genuinely signed request end to end without requiring a live Stripe account
// or Redis (purchaseHandler's real dependencies are covered separately, with mocks, in
// purchaseHandler.test.js).
function signPayload(payload, secret, timestamp) {
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('Stripe webhook route', () => {
  const secret = 'whsec_test_secret';
  let onEvent;
  let app;

  beforeEach(() => {
    onEvent = jest.fn().mockResolvedValue(undefined);
    app = express();
    app.use(createStripeWebhook({
      secret,
      path: '/webhooks/stripe',
      eventLog: createWebhookEventLog(),
      onEvent,
    }));
    app.use(express.json());
    app.get('/health', (_req, res) => res.json({ ok: true }));
  });

  test('accepts a correctly signed event and calls onEvent asynchronously', async () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };
    const payload = JSON.stringify(event);
    const header = signPayload(payload, secret, Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // onEvent runs after the response via setImmediate — flush the microtask/macrotask queue.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].id).toBe('evt_1');
  });

  test('rejects a forged signature with 400 and does not call onEvent', async () => {
    const event = { id: 'evt_2', type: 'checkout.session.completed', data: { object: {} } };
    const payload = JSON.stringify(event);
    const header = signPayload(payload, 'wrong_secret', Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('other routes still work normally (JSON body parser intact)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
