const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.DATA_DIR = require('node:path').join(__dirname, '.tmp-data');
process.env.RECEIPTS_DIR = require('node:path').join(__dirname, '.tmp-receipts');

const fs = require('node:fs');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

// Stub out side-effecting modules before anything requires them.
const emailCalls = [];
require.cache[require.resolve('../src/services/emailService')] = {
  id: require.resolve('../src/services/emailService'),
  filename: require.resolve('../src/services/emailService'),
  loaded: true,
  exports: {
    sendOrderConfirmationEmail: async (order) => {
      emailCalls.push({ type: 'confirmation', order });
    },
    sendReceiptEmail: async (order) => {
      emailCalls.push({ type: 'receipt', order });
    },
    formatAmount: (amount, currency) => `${(amount / 100).toFixed(2)} ${currency || 'usd'}`,
  },
};

const queueCalls = [];
require.cache[require.resolve('../src/jobs/receiptQueue')] = {
  id: require.resolve('../src/jobs/receiptQueue'),
  filename: require.resolve('../src/jobs/receiptQueue'),
  loaded: true,
  exports: {
    enqueueReceiptJob: async (orderId) => {
      queueCalls.push(orderId);
    },
  },
};

const stripe = require('../src/lib/stripeClient');
const { createApp } = require('../src/app');
const { getOrder } = require('../src/services/orderStore');

function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function postRaw(server, path, rawBody, headers) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
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

function buildCheckoutCompletedEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: overrides.sessionId || 'cs_test_1',
        customer_details: { email: 'buyer@example.com' },
        amount_total: 4999,
        currency: 'usd',
        payment_status: 'paid',
      },
    },
  };
}

test('rejects webhook with invalid signature', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const payload = JSON.stringify(buildCheckoutCompletedEvent());
  const res = await postRaw(server, '/webhooks/stripe', payload, {
    'Content-Type': 'application/json',
    'Stripe-Signature': 't=123,v1=deadbeef',
  });

  assert.equal(res.status, 400);
  assert.match(res.body, /Webhook Error/);
});

test('rejects webhook with missing signature header', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const payload = JSON.stringify(buildCheckoutCompletedEvent());
  const res = await postRaw(server, '/webhooks/stripe', payload, {
    'Content-Type': 'application/json',
  });

  assert.equal(res.status, 400);
});

test('accepts a validly-signed checkout.session.completed and triggers confirmation email + receipt job', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  emailCalls.length = 0;
  queueCalls.length = 0;

  const eventObj = buildCheckoutCompletedEvent({ id: 'evt_test_2', sessionId: 'cs_test_2' });
  const payload = JSON.stringify(eventObj);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const res = await postRaw(server, '/webhooks/stripe', payload, {
    'Content-Type': 'application/json',
    'Stripe-Signature': header,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });

  const order = getOrder('cs_test_2');
  assert.ok(order, 'order should be persisted');
  assert.equal(order.customerEmail, 'buyer@example.com');
  assert.equal(order.amountTotal, 4999);

  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].type, 'confirmation');
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0], 'cs_test_2');
});

test('duplicate delivery of the same event is a no-op on the second delivery', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  emailCalls.length = 0;
  queueCalls.length = 0;

  const eventObj = buildCheckoutCompletedEvent({ id: 'evt_test_3', sessionId: 'cs_test_3' });
  const payload = JSON.stringify(eventObj);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const headers = { 'Content-Type': 'application/json', 'Stripe-Signature': header };

  const first = await postRaw(server, '/webhooks/stripe', payload, headers);
  const second = await postRaw(server, '/webhooks/stripe', payload, headers);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body), { received: true, duplicate: true });

  // Only the first delivery should have sent an email / enqueued a job.
  assert.equal(emailCalls.length, 1);
  assert.equal(queueCalls.length, 1);
});
