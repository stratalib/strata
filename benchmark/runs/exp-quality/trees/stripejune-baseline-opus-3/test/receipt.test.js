'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers'); // sets NODE_ENV=test
const { generateReceiptPdf } = require('../src/services/receipt');

test('generateReceiptPdf produces a valid non-trivial PDF buffer', async () => {
  const buf = await generateReceiptPdf({
    orderId: 'ord_abc',
    amount: 4999,
    currency: 'usd',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    paidAt: Date.parse('2026-08-03T10:00:00Z'),
    lineItems: [
      { description: 'Pro plan', amount: 3999, currency: 'usd' },
      { description: 'Add-on', amount: 1000, currency: 'usd' },
    ],
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  // A real one-page receipt is comfortably over 1KB; guards against an empty doc.
  assert.ok(buf.length > 1000, `expected >1KB, got ${buf.length}`);
});

test('generateReceiptPdf works with no line items (summary fallback)', async () => {
  const buf = await generateReceiptPdf({
    orderId: 'ord_xyz',
    amount: 500,
    currency: 'usd',
    customerName: 'John',
    customerEmail: 'john@example.com',
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 800);
});

test('generateReceiptPdf tolerates missing optional fields', async () => {
  const buf = await generateReceiptPdf({
    orderId: 'ord_min',
    amount: 100,
    currency: 'usd',
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
});
