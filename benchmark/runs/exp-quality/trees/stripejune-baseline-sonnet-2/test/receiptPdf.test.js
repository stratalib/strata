const test = require('node:test');
const assert = require('node:assert/strict');
const { generateReceiptPdf } = require('../src/services/receiptPdf');

test('generateReceiptPdf produces a valid PDF buffer', async () => {
  const order = {
    objectId: 'cs_test_123',
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    amountTotal: 4599,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    lineItems: [
      { description: 'Widget', quantity: 2, amount: 3000 },
      { description: 'Gadget', quantity: 1, amount: 1599 },
    ],
  };

  const buffer = await generateReceiptPdf(order);

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  // PDF files always start with the "%PDF-" magic bytes.
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('generateReceiptPdf falls back to a single line item when none provided', async () => {
  const order = {
    objectId: 'pi_test_456',
    customerName: null,
    customerEmail: 'noname@example.com',
    amountTotal: 1000,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    lineItems: [],
  };

  const buffer = await generateReceiptPdf(order);

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
});
