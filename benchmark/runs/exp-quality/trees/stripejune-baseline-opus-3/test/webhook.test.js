'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Stripe = require('stripe');

const { useMockMailer, useFakeIdempotency } = require('./helpers');

// Mock the queue module BEFORE the webhook route requires it, so we assert on
// enqueues without needing Redis. We do this by monkeypatching the exported
// function on the real module object (require cache is shared).
const queueModule = require('../src/jobs/queue');
const enqueued = [];
queueModule.enqueueReceiptJob = async (data, dedupeId) => {
  enqueued.push({ data, dedupeId });
  return { id: dedupeId };
};

const { createApp } = require('../src/app');

const WEBHOOK_SECRET = 'whsec_test_secret'; // must match helpers.js
const stripe = new Stripe('sk_test_dummy');

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  enqueued.length = 0;
  useMockMailer();
  useFakeIdempotency();
});

/** POST raw bytes with optional headers, return { status, body }. */
function post(path, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function signedPayload(eventObject) {
  const payload = JSON.stringify(eventObject);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, header };
}

function paymentIntentEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt_test_1',
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'pi_123',
        amount: 4999,
        amount_received: 4999,
        currency: 'usd',
        receipt_email: 'buyer@example.com',
        metadata: { orderId: 'ord_777', customerName: 'Sam Buyer' },
      },
    },
  };
}

test('rejects request with missing signature header (400)', async () => {
  const { payload } = signedPayload(paymentIntentEvent());
  const res = await post('/webhooks/stripe', payload); // no stripe-signature
  assert.equal(res.status, 400);
  assert.equal(enqueued.length, 0);
});

test('rejects a tampered payload (valid sig for different bytes) (400)', async () => {
  const { header } = signedPayload(paymentIntentEvent());
  // Sign one payload, send a different one -> signature must not verify.
  const tampered = JSON.stringify(paymentIntentEvent({ id: 'evt_tampered' }));
  const res = await post('/webhooks/stripe', tampered, { 'stripe-signature': header });
  assert.equal(res.status, 400);
  assert.equal(enqueued.length, 0);
});

test('rejects a payload signed with the wrong secret (400)', async () => {
  const payload = JSON.stringify(paymentIntentEvent());
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_the_wrong_secret',
  });
  const res = await post('/webhooks/stripe', payload, { 'stripe-signature': header });
  assert.equal(res.status, 400);
  assert.equal(enqueued.length, 0);
});

test('accepts a correctly signed payment_intent.succeeded (200) and enqueues receipt', async () => {
  const mock = useMockMailer();
  const { payload, header } = signedPayload(paymentIntentEvent());
  const res = await post('/webhooks/stripe', payload, { 'stripe-signature': header });
  assert.equal(res.status, 200);
  assert.match(res.body, /received/);

  // Confirmation email sent inline
  const sent = mock.getSentMail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@example.com');
  assert.match(sent[0].text, /\$49\.99/);

  // Receipt job enqueued, keyed on the Stripe event id (idempotency key)
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].dedupeId, 'evt_test_1');
  assert.equal(enqueued[0].data.orderId, 'ord_777');
  assert.equal(enqueued[0].data.customerEmail, 'buyer@example.com');
  assert.equal(enqueued[0].data.amount, 4999);
});

test('accepts checkout.session.completed and extracts customer details', async () => {
  const event = {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_123',
        amount_total: 12000,
        currency: 'usd',
        customer_details: { email: 'checkout@example.com', name: 'Checkout Buyer' },
        metadata: { orderId: 'ord_cs' },
      },
    },
  };
  const { payload, header } = signedPayload(event);
  const res = await post('/webhooks/stripe', payload, { 'stripe-signature': header });
  assert.equal(res.status, 200);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].data.customerEmail, 'checkout@example.com');
  assert.equal(enqueued[0].data.amount, 12000);
  assert.equal(enqueued[0].dedupeId, 'evt_checkout_1');
});

test('redelivered event is idempotent: single confirmation email and single job', async () => {
  const mock = useMockMailer();
  useFakeIdempotency();
  const { payload, header } = signedPayload(paymentIntentEvent({ id: 'evt_dupe' }));

  const first = await post('/webhooks/stripe', payload, { 'stripe-signature': header });
  const second = await post('/webhooks/stripe', payload, { 'stripe-signature': header });

  // Both deliveries acknowledge with 200 (we don't want Stripe to keep retrying)
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  // ...but the side effects happened exactly once.
  assert.equal(mock.getSentMail().length, 1, 'confirmation email should be sent once');
  assert.equal(enqueued.length, 1, 'receipt job should be enqueued once');
});

test('ignores unhandled event types with 200 and no side effects', async () => {
  const event = {
    id: 'evt_other',
    type: 'customer.created',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cus_1' } },
  };
  const { payload, header } = signedPayload(event);
  const res = await post('/webhooks/stripe', payload, { 'stripe-signature': header });
  assert.equal(res.status, 200);
  assert.equal(enqueued.length, 0);
});
