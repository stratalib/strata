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

const { generateReceiptPdf } = require('../src/services/pdfReceipt');

test('generateReceiptPdf produces a non-empty PDF buffer', async () => {
  const buffer = await generateReceiptPdf({
    orderId: 'order_123',
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    amount: 4999,
    currency: 'usd',
    paidAt: new Date().toISOString(),
    items: [{ description: 'Widget', amount: 4999 }],
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  // PDF files start with the "%PDF-" magic bytes.
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('generateReceiptPdf falls back to a single line item when none provided', async () => {
  const buffer = await generateReceiptPdf({
    orderId: 'order_456',
    customerName: null,
    customerEmail: 'noname@example.com',
    amount: 1000,
    currency: 'usd',
    paidAt: new Date().toISOString(),
    items: [],
  });

  assert.ok(buffer.length > 0);
});
