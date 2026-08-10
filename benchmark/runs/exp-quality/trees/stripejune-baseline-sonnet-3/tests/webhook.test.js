const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.SMTP_HOST = process.env.SMTP_HOST || 'localhost';
process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
process.env.SMTP_USER = process.env.SMTP_USER || 'user';
process.env.SMTP_PASS = process.env.SMTP_PASS || 'pass';
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'billing@example.com';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const Stripe = require('stripe');
const mailer = require('../src/lib/mailer');
const receiptQueue = require('../src/queues/receiptQueue');
const { createApp } = require('../src/app');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Minimal fake Redis: only implements the SET NX behavior claimEvent() relies on,
// so tests don't need a live Redis server just to exercise the HTTP layer.
function createFakeRedis() {
  const store = new Set();
  return {
    async set(key, value, exFlag, ttl, nxFlag) {
      if (nxFlag === 'NX' && store.has(key)) {
        return null;
      }
      store.add(key);
      return 'OK';
    },
  };
}

function buildCheckoutCompletedPayload(overrides = {}) {
  return {
    id: overrides.id || `evt_${Math.random().toString(36).slice(2)}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: overrides.sessionId || `cs_test_${Math.random().toString(36).slice(2)}`,
        amount_total: 4999,
        currency: 'usd',
        customer_details: {
          email: 'customer@example.com',
          name: 'Ada Lovelace',
        },
        ...overrides.sessionFields,
      },
    },
  };
}

function signPayload(payload) {
  const payloadString = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  return { payloadString, header };
}

test('rejects requests with an invalid Stripe signature', async () => {
  const app = createApp(createFakeRedis());
  const payload = buildCheckoutCompletedPayload();
  const payloadString = JSON.stringify(payload);

  const res = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'invalid_signature')
    .send(payloadString);

  assert.equal(res.status, 400);
});

test('accepts a validly signed checkout.session.completed event, sends confirmation, and enqueues a receipt job', async (t) => {
  const sentEmails = [];
  const enqueuedJobs = [];

  t.mock.method(mailer, 'sendMail', async (opts) => {
    sentEmails.push(opts);
    return { messageId: 'fake-message-id' };
  });
  t.mock.method(receiptQueue, 'enqueueReceiptJob', async (payload) => {
    enqueuedJobs.push(payload);
    return { id: payload.orderId };
  });

  const app = createApp(createFakeRedis());
  const payload = buildCheckoutCompletedPayload();
  const { payloadString, header } = signPayload(payload);

  const res = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(payloadString);

  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);

  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'customer@example.com');
  assert.match(sentEmails[0].subject, /\$49\.99/);

  assert.equal(enqueuedJobs.length, 1);
  assert.equal(enqueuedJobs[0].customerEmail, 'customer@example.com');
  assert.equal(enqueuedJobs[0].amount, 4999);
});

test('a duplicate delivery of the same event id is ignored (idempotency)', async (t) => {
  const sentEmails = [];
  const enqueuedJobs = [];

  t.mock.method(mailer, 'sendMail', async (opts) => {
    sentEmails.push(opts);
    return { messageId: 'fake-message-id' };
  });
  t.mock.method(receiptQueue, 'enqueueReceiptJob', async (payload) => {
    enqueuedJobs.push(payload);
    return { id: payload.orderId };
  });

  const fakeRedis = createFakeRedis();
  const app = createApp(fakeRedis);
  const eventId = 'evt_fixed_id_for_dup_test';
  const payload = buildCheckoutCompletedPayload({ id: eventId });
  const { payloadString, header } = signPayload(payload);

  const first = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(payloadString);

  const second = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(payloadString);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  assert.equal(sentEmails.length, 1, 'confirmation email should only be sent once');
  assert.equal(enqueuedJobs.length, 1, 'receipt job should only be enqueued once');
});

test('ignores checkout session with no customer email without erroring', async (t) => {
  const sentEmails = [];
  t.mock.method(mailer, 'sendMail', async (opts) => {
    sentEmails.push(opts);
    return { messageId: 'fake-message-id' };
  });
  t.mock.method(receiptQueue, 'enqueueReceiptJob', async () => ({}));

  const app = createApp(createFakeRedis());
  const payload = buildCheckoutCompletedPayload({
    sessionFields: { customer_details: null },
  });
  const { payloadString, header } = signPayload(payload);

  const res = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(payloadString);

  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 0);
});
