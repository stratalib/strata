'use strict';

process.env.NODE_ENV = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_123';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Stripe = require('stripe');

const { buildApp } = require('../src/server');
const { MemoryIdempotencyStore } = require('../src/idempotency');

// A real Stripe client — we use it to generate genuine signatures so the test
// exercises the actual verification path, not a mock of it.
const stripe = new Stripe('sk_test_dummy');

// Spin the express app on an ephemeral port and return a helper to POST raw
// bodies with arbitrary headers (so we can send good and bad signatures).
function withServer(deps, fn) {
  const app = buildApp(deps);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        const result = await fn(port);
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
    server.on('error', reject);
  });
}

function post(port, path, { body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    id: overrides.id || 'evt_test_1',
    type: overrides.type || 'checkout.session.completed',
    data: {
      object: overrides.object || {
        id: 'cs_test_123',
        payment_status: 'paid',
        amount_total: 4200,
        currency: 'usd',
        customer_details: { email: 'buyer@example.com', name: 'Jane Buyer' },
        payment_intent: 'pi_test_1',
        created: 1700000000,
      },
    },
  });
}

function signed(payload, secret = 'whsec_test_secret_123') {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return header;
}

function makeDeps() {
  const sent = [];
  const enqueued = [];
  return {
    deps: {
      stripe,
      idempotency: new MemoryIdempotencyStore(),
      sendConfirmationEmail: async (order) => sent.push(order),
      enqueueReceipt: async (order, jobId) => enqueued.push({ order, jobId }),
    },
    sent,
    enqueued,
  };
}

// buildApp expects sendConfirmationEmail + enqueueReceipt on the injected deps,
// but server.buildApp closes over the module-level ones. So we test the router
// factory directly through a tiny app instead.
const express = require('express');
const { createWebhookRouter } = require('../src/webhook');

function buildTestApp(deps) {
  const app = express();
  app.use('/webhook', express.raw({ type: 'application/json' }), createWebhookRouter(deps));
  return app;
}

function withRouter(deps, fn) {
  const app = buildTestApp({ logger: { info() {}, warn() {}, error() {} }, ...deps });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        resolve(await fn(port));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
    server.on('error', reject);
  });
}

test('valid signature -> 200, sends confirmation, enqueues receipt', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent();
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', {
      body: payload,
      headers: { 'stripe-signature': signed(payload) },
    });
    assert.strictEqual(res.status, 200);
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].customerEmail, 'buyer@example.com');
  assert.strictEqual(sent[0].amountTotal, 4200);
  assert.strictEqual(enqueued.length, 1);
  assert.strictEqual(enqueued[0].jobId, 'receipt:evt_test_1');
});

test('invalid signature -> 400, no email, no enqueue', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent();
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', {
      body: payload,
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    });
    assert.strictEqual(res.status, 400);
  });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(enqueued.length, 0);
});

test('tampered body with old signature -> 400', async () => {
  const { deps, sent } = makeDeps();
  const payload = makeEvent();
  const sig = signed(payload);
  const tampered = makeEvent({ object: { id: 'cs_test_123', payment_status: 'paid', amount_total: 999999, currency: 'usd', customer_details: { email: 'attacker@example.com' } } });
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', { body: tampered, headers: { 'stripe-signature': sig } });
    assert.strictEqual(res.status, 400);
  });
  assert.strictEqual(sent.length, 0);
});

test('missing signature header -> 400', async () => {
  const { deps } = makeDeps();
  const payload = makeEvent();
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', { body: payload, headers: {} });
    assert.strictEqual(res.status, 400);
  });
});

test('duplicate event id -> processed once (idempotent)', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent({ id: 'evt_dup' });
  const sig = signed(payload);
  await withRouter(deps, async (port) => {
    const r1 = await post(port, '/webhook', { body: payload, headers: { 'stripe-signature': sig } });
    const r2 = await post(port, '/webhook', { body: payload, headers: { 'stripe-signature': sig } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.match(r2.body, /duplicate/);
  });
  assert.strictEqual(sent.length, 1, 'confirmation email sent exactly once');
  assert.strictEqual(enqueued.length, 1, 'receipt enqueued exactly once');
});

test('unpaid checkout session -> acknowledged but skipped', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent({
    object: { id: 'cs_unpaid', payment_status: 'unpaid', amount_total: 100, currency: 'usd', customer_details: { email: 'x@y.com' } },
  });
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', { body: payload, headers: { 'stripe-signature': signed(payload) } });
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /unpaid/);
  });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(enqueued.length, 0);
});

test('unhandled event type -> 200 ignored, no side effects', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent({ id: 'evt_other', type: 'customer.created', object: { id: 'cus_1' } });
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', { body: payload, headers: { 'stripe-signature': signed(payload) } });
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /ignored/);
  });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(enqueued.length, 0);
});

test('payment_intent.succeeded is handled', async () => {
  const { deps, sent, enqueued } = makeDeps();
  const payload = makeEvent({
    id: 'evt_pi',
    type: 'payment_intent.succeeded',
    object: { id: 'pi_9', amount: 5000, amount_received: 5000, currency: 'eur', receipt_email: 'pi@example.com', created: 1700000000 },
  });
  await withRouter(deps, async (port) => {
    const res = await post(port, '/webhook', { body: payload, headers: { 'stripe-signature': signed(payload) } });
    assert.strictEqual(res.status, 200);
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].customerEmail, 'pi@example.com');
  assert.strictEqual(sent[0].currency, 'eur');
});

// Keep buildApp referenced so a regression that breaks it is caught at import.
test('buildApp mounts /healthz', async () => {
  const app = buildApp({ stripe, idempotency: new MemoryIdempotencyStore() });
  await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
        assert.strictEqual(res.statusCode, 200);
        server.close();
        resolve();
      }).on('error', reject);
    });
  });
});
