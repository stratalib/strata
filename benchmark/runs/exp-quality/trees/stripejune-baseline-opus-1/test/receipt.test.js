'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { generateReceiptPdf } = require('../src/receipt');

const baseOrder = {
  id: 'cs_test_pdf',
  customerEmail: 'buyer@example.com',
  customerName: 'Jane Buyer',
  amountTotal: 4200,
  currency: 'usd',
  paymentIntentId: 'pi_test_pdf',
  paidAt: Date.now(),
  lineItems: [
    { description: 'Widget Pro', quantity: 2, amount: 4200 },
  ],
};

test('generateReceiptPdf returns a non-empty PDF buffer', async () => {
  const pdf = await generateReceiptPdf(baseOrder);
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 500, 'PDF should have real content');
  // Every PDF starts with the %PDF magic marker.
  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  // And ends with the EOF marker.
  assert.match(pdf.subarray(-8).toString(), /%%EOF/);
});

test('generateReceiptPdf works without line items (falls back to summary)', async () => {
  const order = Object.assign({}, baseOrder, { lineItems: null });
  const pdf = await generateReceiptPdf(order);
  assert.ok(Buffer.isBuffer(pdf));
  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
});

test('generateReceiptPdf works without a customer name', async () => {
  const order = Object.assign({}, baseOrder, { customerName: null });
  const pdf = await generateReceiptPdf(order);
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 500);
});
