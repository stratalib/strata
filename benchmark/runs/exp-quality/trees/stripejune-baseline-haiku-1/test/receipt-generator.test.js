import test from 'node:test';
import assert from 'node:assert';
import { generateReceiptPDF } from '../lib/receipt-generator.js';

test('receipt generator produces valid PDF', async (t) => {
  const pdfBuffer = await generateReceiptPDF({
    paymentIntentId: 'pi_test123',
    amount: 99.99,
    currency: 'usd',
    timestamp: new Date().toISOString(),
  });

  assert(Buffer.isBuffer(pdfBuffer), 'Should return a buffer');
  assert(pdfBuffer.length > 0, 'PDF buffer should not be empty');

  // PDF files start with %PDF magic bytes
  const pdfHeader = pdfBuffer.toString('ascii', 0, 4);
  assert.strictEqual(pdfHeader, '%PDF', 'Should be valid PDF file');
});

test('receipt generator handles different currencies', async (t) => {
  const currencies = ['usd', 'eur', 'gbp', 'jpy'];

  for (const currency of currencies) {
    const pdfBuffer = await generateReceiptPDF({
      paymentIntentId: `pi_${currency}`,
      amount: 100,
      currency,
      timestamp: new Date().toISOString(),
    });

    assert(Buffer.isBuffer(pdfBuffer), `Should generate PDF for ${currency}`);
    assert(pdfBuffer.length > 0, `PDF for ${currency} should not be empty`);
  }
});
