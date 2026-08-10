import { test } from 'node:test';
import assert from 'node:assert';
import { generateReceiptPDF } from '../src/services/receiptService.js';

test('PDF receipt generation', async (t) => {
  await t.test('should generate valid PDF buffer', async () => {
    const paymentData = {
      paymentId: 'pi_test_123',
      amount: 9999,
      customerEmail: 'test@example.com',
      status: 'succeeded',
      paymentMethod: 'card',
      description: 'Test payment',
      timestamp: new Date().toISOString(),
    };

    const pdfBuffer = await generateReceiptPDF(paymentData);

    assert(Buffer.isBuffer(pdfBuffer), 'Should return a Buffer');
    assert(pdfBuffer.length > 0, 'Buffer should not be empty');
    // PDF files start with %PDF
    assert(pdfBuffer.toString('ascii', 0, 4) === '%PDF', 'Should be valid PDF');
  });

  await t.test('should handle missing optional fields', async () => {
    const paymentData = {
      paymentId: 'pi_test_456',
      amount: 5000,
      customerEmail: 'test@example.com',
      status: 'succeeded',
      paymentMethod: 'card',
      description: '',
      timestamp: new Date().toISOString(),
    };

    const pdfBuffer = await generateReceiptPDF(paymentData);
    assert(Buffer.isBuffer(pdfBuffer), 'Should return a Buffer');
    assert(pdfBuffer.length > 0, 'Buffer should not be empty');
  });
});
