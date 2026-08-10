'use strict';
const { generateReceiptPdf, formatMoney } = require('../lib/receiptPdf');

describe('formatMoney', () => {
  test('formats cents as currency', () => {
    expect(formatMoney(1999, 'usd')).toBe('$19.99');
  });

  test('falls back gracefully on bad currency code', () => {
    expect(formatMoney(1000, 'not-a-currency')).toMatch(/10\.00/);
  });
});

describe('generateReceiptPdf', () => {
  test('resolves a non-empty PDF buffer with the %PDF header', async () => {
    const buffer = await generateReceiptPdf({
      receiptNumber: 'R-TEST123',
      sessionId: 'cs_test_abc123',
      customerEmail: 'buyer@example.com',
      customerName: 'Ada Lovelace',
      currency: 'usd',
      amountTotal: 2500,
      lineItems: [
        { description: 'Widget', quantity: 2, amountTotal: 2000 },
        { description: 'Shipping', quantity: 1, amountTotal: 500 },
      ],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('falls back to a single summary line when lineItems is empty', async () => {
    const buffer = await generateReceiptPdf({
      receiptNumber: 'R-TEST456',
      sessionId: 'cs_test_def456',
      customerEmail: 'buyer2@example.com',
      currency: 'eur',
      amountTotal: 1000,
      lineItems: [],
      createdAt: new Date(),
    });
    expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
