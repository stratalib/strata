'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const mailer = require('../src/mailer');
const { makeFakeTransport } = require('./helpers');

const order = {
  id: 'cs_test_abc',
  customerEmail: 'buyer@example.com',
  customerName: 'Jane Buyer',
  amountTotal: 4200,
  currency: 'usd',
  paymentIntentId: 'pi_test_abc',
};

test.afterEach(() => mailer.resetTransport());

test('formatMoney renders minor units as major with currency', () => {
  assert.strictEqual(mailer.formatMoney(4200, 'usd'), '42.00 USD');
  assert.strictEqual(mailer.formatMoney(99, 'eur'), '0.99 EUR');
  assert.strictEqual(mailer.formatMoney(0, 'gbp'), '0.00 GBP');
});

test('sendConfirmationEmail sends a no-attachment email to the customer', async () => {
  const fake = makeFakeTransport();
  mailer.setTransport(fake);

  await mailer.sendConfirmationEmail(order);

  assert.strictEqual(fake.sent.length, 1);
  const msg = fake.sent[0];
  assert.strictEqual(msg.to, 'buyer@example.com');
  assert.match(msg.subject, /confirmed/i);
  assert.match(msg.text, /42\.00 USD/);
  assert.match(msg.text, /cs_test_abc/);
  assert.ok(!msg.attachments, 'confirmation email should have no attachment');
});

test('sendReceiptEmail attaches the PDF buffer', async () => {
  const fake = makeFakeTransport();
  mailer.setTransport(fake);

  const pdf = Buffer.from('%PDF-1.4 fake');
  await mailer.sendReceiptEmail(order, pdf);

  assert.strictEqual(fake.sent.length, 1);
  const msg = fake.sent[0];
  assert.strictEqual(msg.to, 'buyer@example.com');
  assert.ok(Array.isArray(msg.attachments) && msg.attachments.length === 1);
  assert.strictEqual(msg.attachments[0].filename, 'receipt-cs_test_abc.pdf');
  assert.strictEqual(msg.attachments[0].contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(msg.attachments[0].content));
});
