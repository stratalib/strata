'use strict';

// Ensure test config before anything reads it.
process.env.NODE_ENV = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

const nodemailerMock = require('nodemailer-mock');
const mailer = require('../src/services/mailer');
const idempotency = require('../src/lib/idempotency');

/** Install the nodemailer mock transport into the mailer and reset its state. */
function useMockMailer() {
  const transport = nodemailerMock.createTransport({});
  mailer.setTransport(transport);
  nodemailerMock.mock.reset();
  return nodemailerMock.mock;
}

/**
 * A minimal in-memory stand-in for the Redis client used by the idempotency
 * guard: implements just SET ... NX EX and DEL. Lets us test dedupe behavior
 * without a running Redis, while still exercising the real claimEvent logic.
 */
function createFakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, ...args) {
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
  };
}

/** Install a fresh fake Redis into the idempotency guard; returns it. */
function useFakeIdempotency() {
  const fake = createFakeRedis();
  idempotency._setConnection(fake);
  return fake;
}

module.exports = { useMockMailer, useFakeIdempotency, createFakeRedis, nodemailerMock };
