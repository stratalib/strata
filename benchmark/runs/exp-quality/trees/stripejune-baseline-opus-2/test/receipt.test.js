'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { generateReceiptPdf } = require('../src/receipt');
const { formatAmount } = require('../src/mailer');

const order = {
  orderId: 'cs_test_123',
  paymentIntentId: 'pi_test_1',
  amountTotal: 4200,
  currency: 'usd',
  customerEmail: 'buyer@example.com',
  customerName: 'Jane Buyer',
  paidAt: 1700000000000,
  items: [
    { description: 'Pro plan (annual)', quantity: 1, amount: 3600 },
    { description: 'Priority support', quantity: 1, amount: 600 },
  ],
};

test('generateReceiptPdf returns a valid non-trivial PDF buffer', async () => {
  const pdf = await generateReceiptPdf(order);
  assert.ok(Buffer.isBuffer(pdf), 'returns a Buffer');
  assert.ok(pdf.length > 800, `pdf should be non-trivial, got ${pdf.length} bytes`);
  // PDF magic number.
  assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  // Proper EOF marker means the stream was finalised.
  assert.ok(pdf.subarray(-8).toString('latin1').includes('%%EOF'));
});

test('generateReceiptPdf works with no explicit line items (falls back to single line)', async () => {
  const minimal = { orderId: 'o1', amountTotal: 999, currency: 'usd', customerEmail: 'a@b.com' };
  const pdf = await generateReceiptPdf(minimal);
  assert.ok(pdf.length > 800);
  assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('formatAmount handles 2-decimal currencies', () => {
  assert.strictEqual(formatAmount(4200, 'usd'), '$42.00');
  assert.strictEqual(formatAmount(100, 'usd'), '$1.00');
});

test('formatAmount handles zero-decimal currencies (JPY)', () => {
  // 4200 yen is 4200, not 42.00.
  assert.strictEqual(formatAmount(4200, 'jpy'), '¥4,200');
});

test('formatAmount falls back gracefully on unknown currency', () => {
  // For an unrecognised code we don't care about the exact layout (ICU may
  // render "ZZZ 42.00" or "42.00 ZZZ" depending on Node's bundled data); we
  // only require that both the amount and the uppercased code survive.
  const out = formatAmount(4200, 'zzz');
  assert.match(out, /42\.00/);
  assert.match(out, /ZZZ/);
});
