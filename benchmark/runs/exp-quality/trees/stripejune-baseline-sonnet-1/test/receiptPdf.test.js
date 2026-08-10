const test = require('node:test');
const assert = require('node:assert/strict');

const { generateReceiptPdf } = require('../src/services/receiptPdf');

test('generateReceiptPdf produces a well-formed PDF buffer', async () => {
  const order = {
    id: 'order_pdf_1',
    customerEmail: 'buyer@example.com',
    amountTotal: 12345,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    productName: 'Widget Pro',
  };

  const buffer = await generateReceiptPdf(order);

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 500, 'PDF should have non-trivial content');
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(buffer.subarray(-6).toString('ascii').trim().slice(-5), '%%EOF');
});

test('generateReceiptPdf handles multi-item orders', async () => {
  const order = {
    id: 'order_pdf_2',
    customerEmail: 'buyer2@example.com',
    amountTotal: 9000,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    items: [
      { description: 'Item A', quantity: 2, unitAmount: 2000 },
      { description: 'Item B', quantity: 1, unitAmount: 5000 },
    ],
  };

  const buffer = await generateReceiptPdf(order);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});
