const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Stripe = require('stripe');

process.env.NODE_ENV = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const { createApp } = require('../src/app');
const orderStore = require('../src/db/orderStore');

// The webhook handler enqueues a BullMQ job and sends an email as
// side effects. Neither Redis nor a real SMTP server exist in this test
// environment, so both are stubbed at the module level -- the thing under
// test here is signature verification + idempotency + response codes, not
// delivery, which is covered separately by the queue/email unit tests.
const receiptQueue = require('../src/queues/receiptQueue');
const emailService = require('../src/services/emailService');

const stripeForSigning = Stripe('sk_test_x');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function signPayload(payload) {
  const payloadString = JSON.stringify(payload);
  const header = stripeForSigning.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret: WEBHOOK_SECRET,
  });
  return { payloadString, header };
}

function makeCheckoutEvent(overrides = {}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_${Math.random().toString(36).slice(2)}`,
        amount_total: 2500,
        currency: 'usd',
        customer_details: { email: 'buyer@example.com', name: 'Test Buyer' },
        line_items: { data: [] },
        ...overrides,
      },
    },
  };
}

async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port };
}

async function postWebhook(port, payloadString, signatureHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/webhooks/stripe',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadString),
          ...(signatureHeader ? { 'stripe-signature': signatureHeader } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(payloadString);
    req.end();
  });
}

test('webhook: rejects a request with an invalid signature', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const event = makeCheckoutEvent();
  const { payloadString } = signPayload(event);

  const res = await postWebhook(port, payloadString, 't=1,v1=deadbeef');

  assert.equal(res.status, 400);
  assert.match(res.body, /Webhook Error/);
});

test('webhook: rejects a request with no signature header', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const event = makeCheckoutEvent();
  const { payloadString } = signPayload(event);

  const res = await postWebhook(port, payloadString, null);

  assert.equal(res.status, 400);
});

test('webhook: accepts a validly signed checkout.session.completed event', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const originalEnqueue = receiptQueue.enqueueReceiptJob;
  const originalSendConfirmation = emailService.sendConfirmationEmail;
  let enqueued = null;
  let emailed = null;
  receiptQueue.enqueueReceiptJob = async (order) => {
    enqueued = order;
  };
  emailService.sendConfirmationEmail = async (order) => {
    emailed = order;
  };
  t.after(() => {
    receiptQueue.enqueueReceiptJob = originalEnqueue;
    emailService.sendConfirmationEmail = originalSendConfirmation;
  });

  const event = makeCheckoutEvent();
  const { payloadString, header } = signPayload(event);

  const res = await postWebhook(port, payloadString, header);

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.received, true);
  assert.ok(enqueued, 'expected receipt job to be enqueued');
  assert.equal(enqueued.customerEmail, 'buyer@example.com');
  assert.ok(emailed, 'expected confirmation email to be sent');
});

test('webhook: is idempotent for a redelivered event id', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  let callCount = 0;
  const originalEnqueue = receiptQueue.enqueueReceiptJob;
  const originalSendConfirmation = emailService.sendConfirmationEmail;
  receiptQueue.enqueueReceiptJob = async () => {
    callCount += 1;
  };
  emailService.sendConfirmationEmail = async () => {};
  t.after(() => {
    receiptQueue.enqueueReceiptJob = originalEnqueue;
    emailService.sendConfirmationEmail = originalSendConfirmation;
  });

  const event = makeCheckoutEvent();
  const { payloadString, header } = signPayload(event);

  const first = await postWebhook(port, payloadString, header);
  const second = await postWebhook(port, payloadString, header);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.body).duplicate, true);
  assert.equal(callCount, 1, 'job should only be enqueued once for a duplicate event');
});

test('webhook: ignores unhandled event types with a 200', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const event = makeCheckoutEvent();
  event.type = 'customer.subscription.deleted';
  const { payloadString, header } = signPayload(event);

  const res = await postWebhook(port, payloadString, header);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ignored, true);
});

test('webhook: records the order but skips side effects when no email is present', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const event = makeCheckoutEvent({ customer_details: null });
  const { payloadString, header } = signPayload(event);

  const res = await postWebhook(port, payloadString, header);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).skipped, 'no_email');
  assert.ok(orderStore.getOrder(event.id));
});
