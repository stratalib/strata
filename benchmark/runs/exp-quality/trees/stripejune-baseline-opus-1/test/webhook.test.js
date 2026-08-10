'use strict';

// Must be set before config.js is required (it reads env at load time).
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../src/app');
const mailer = require('../src/mailer');
const store = require('../src/store');
const orders = require('../src/orders');
const { makeFakeTransport, makeCheckoutEvent, signPayload } = require('./helpers');

const WEBHOOK_SECRET = 'whsec_test_secret';

// Start the app on an ephemeral port and return {url, close}.
function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Minimal POST helper that sends a raw string body.
function postRaw(url, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method: 'POST', headers },
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

test.beforeEach(() => {
  store._reset();
  const fake = makeFakeTransport();
  mailer.setTransport(fake);
  // Stub enqueue so no Redis is needed; record calls on the transport object.
  fake.enqueued = [];
  orders.setEnqueue(async (order) => {
    fake.enqueued.push(order);
    return { id: `job-${order.id}` };
  });
  test._fake = fake;
});

test.afterEach(() => {
  mailer.resetTransport();
  orders.setEnqueue(null);
});

test('valid signature: processes checkout, sends confirmation, enqueues receipt', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const event = makeCheckoutEvent();
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, WEBHOOK_SECRET);

    const res = await postRaw(srv.url, '/webhooks/stripe', raw, {
      'Content-Type': 'application/json',
      'Stripe-Signature': sig,
    });

    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.received, true);
    assert.strictEqual(parsed.result.status, 'processed');

    // Confirmation email sent to the customer.
    assert.strictEqual(test._fake.sent.length, 1);
    assert.strictEqual(test._fake.sent[0].to, 'buyer@example.com');
    assert.match(test._fake.sent[0].subject, /confirmed/i);

    // Receipt job enqueued.
    assert.strictEqual(test._fake.enqueued.length, 1);
    assert.strictEqual(test._fake.enqueued[0].id, 'cs_test_123');

    // Order persisted.
    assert.ok(store.getOrder('cs_test_123'));
  } finally {
    await srv.close();
  }
});

test('invalid signature: rejected with 400, no side effects', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const event = makeCheckoutEvent();
    const raw = JSON.stringify(event);

    const res = await postRaw(srv.url, '/webhooks/stripe', raw, {
      'Content-Type': 'application/json',
      'Stripe-Signature': 't=1,v1=deadbeef', // bogus
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(test._fake.sent.length, 0);
    assert.strictEqual(test._fake.enqueued.length, 0);
  } finally {
    await srv.close();
  }
});

test('missing signature header: rejected with 400', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const raw = JSON.stringify(makeCheckoutEvent());
    const res = await postRaw(srv.url, '/webhooks/stripe', raw, {
      'Content-Type': 'application/json',
    });
    assert.strictEqual(res.status, 400);
  } finally {
    await srv.close();
  }
});

test('tampered body with valid-looking signature is rejected', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const event = makeCheckoutEvent();
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, WEBHOOK_SECRET);

    // Sign the original but send a modified body — verification must fail.
    const tampered = raw.replace('4200', '999999');

    const res = await postRaw(srv.url, '/webhooks/stripe', tampered, {
      'Content-Type': 'application/json',
      'Stripe-Signature': sig,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(test._fake.sent.length, 0);
  } finally {
    await srv.close();
  }
});

test('duplicate event id is processed only once (idempotency)', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const event = makeCheckoutEvent({ id: 'evt_dupe_1' });
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, WEBHOOK_SECRET);
    const headers = {
      'Content-Type': 'application/json',
      'Stripe-Signature': sig,
    };

    const first = await postRaw(srv.url, '/webhooks/stripe', raw, headers);
    const second = await postRaw(srv.url, '/webhooks/stripe', raw, headers);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(JSON.parse(first.body).result.status, 'processed');
    assert.strictEqual(JSON.parse(second.body).result.status, 'duplicate');

    // Exactly one confirmation email and one enqueue despite two deliveries.
    assert.strictEqual(test._fake.sent.length, 1);
    assert.strictEqual(test._fake.enqueued.length, 1);
  } finally {
    await srv.close();
  }
});

test('unpaid session is acknowledged but not fulfilled', async () => {
  const app = createApp();
  const srv = await startServer(app);
  try {
    const event = makeCheckoutEvent({
      id: 'evt_unpaid',
      session: { payment_status: 'unpaid' },
    });
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, WEBHOOK_SECRET);

    const res = await postRaw(srv.url, '/webhooks/stripe', raw, {
      'Content-Type': 'application/json',
      'Stripe-Signature': sig,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).result.status, 'unpaid');
    assert.strictEqual(test._fake.sent.length, 0);
    assert.strictEqual(test._fake.enqueued.length, 0);
  } finally {
    await srv.close();
  }
});
