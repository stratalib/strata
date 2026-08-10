const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
process.env.SMTP_HOST = process.env.SMTP_HOST || 'localhost';
process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
process.env.SMTP_USER = process.env.SMTP_USER || 'user';
process.env.SMTP_PASS = process.env.SMTP_PASS || 'pass';
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'billing@example.com';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const { purchaseConfirmationEmail, receiptEmail, formatAmount } = require('../src/services/emailTemplates');

test('formatAmount converts cents to a formatted currency string', () => {
  assert.equal(formatAmount(4999, 'usd'), '$49.99');
  assert.equal(formatAmount(100, 'usd'), '$1.00');
});

test('purchaseConfirmationEmail includes amount and order id', () => {
  const { subject, text, html } = purchaseConfirmationEmail({
    customerName: 'Ada',
    amount: 2000,
    currency: 'usd',
    orderId: 'order_abc',
  });

  assert.match(subject, /\$20\.00/);
  assert.match(text, /order_abc/);
  assert.match(text, /Ada/);
  assert.match(html, /order_abc/);
});

test('purchaseConfirmationEmail handles missing customer name', () => {
  const { text } = purchaseConfirmationEmail({
    customerName: null,
    amount: 500,
    currency: 'usd',
    orderId: 'order_xyz',
  });

  assert.match(text, /Hi there/);
});

test('receiptEmail includes order id in subject', () => {
  const { subject } = receiptEmail({
    customerName: 'Ada',
    amount: 2000,
    currency: 'usd',
    orderId: 'order_abc',
  });

  assert.match(subject, /order_abc/);
});
