'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const mailer = require('../src/mailer');
const { processReceiptJob } = require('../src/worker');
const { makeFakeTransport } = require('./helpers');

const order = {
  id: 'cs_worker_1',
  customerEmail: 'buyer@example.com',
  customerName: 'Jane Buyer',
  amountTotal: 4200,
  currency: 'usd',
  paymentIntentId: 'pi_worker_1',
  paidAt: Date.now(),
  lineItems: [{ description: 'Widget Pro', quantity: 1, amount: 4200 }],
};

test.beforeEach(() => {
  store._reset();
  mailer.setTransport(makeFakeTransport());
});
test.afterEach(() => mailer.resetTransport());

test('processReceiptJob generates a PDF and emails the receipt', async () => {
  store.saveOrder(order);
  const fake = makeFakeTransport();
  mailer.setTransport(fake);

  const result = await processReceiptJob({ id: 'job1', data: { orderId: order.id } });

  assert.deepStrictEqual(result, { sent: true, orderId: 'cs_worker_1' });
  assert.strictEqual(fake.sent.length, 1);
  const msg = fake.sent[0];
  assert.match(msg.subject, /receipt/i);
  assert.strictEqual(msg.attachments.length, 1);
  // The attachment is a real PDF produced by the job.
  assert.strictEqual(msg.attachments[0].content.subarray(0, 4).toString(), '%PDF');
});

test('processReceiptJob skips gracefully when the order is missing', async () => {
  const fake = makeFakeTransport();
  mailer.setTransport(fake);

  const result = await processReceiptJob({ id: 'job2', data: { orderId: 'nope' } });

  assert.deepStrictEqual(result, { skipped: true, reason: 'order_not_found' });
  assert.strictEqual(fake.sent.length, 0);
});
