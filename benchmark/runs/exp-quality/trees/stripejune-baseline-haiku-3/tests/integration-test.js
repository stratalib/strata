import { config } from 'dotenv';
import { getOrderStore } from '../storage/order-store.js';
import { formatCurrency } from '../utils/formatters.js';
import { generateReceiptPDF } from '../queue/pdf-generator.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let testCount = 0;
let passCount = 0;

async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`✓ ${name}`);
    passCount++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
  }
}

async function runTests() {
  console.log('Running Integration Tests\n');

  // Test 1: Order storage and retrieval
  await test('Save and retrieve order from storage', async () => {
    const store = getOrderStore();
    const testId = `INT-${Date.now()}`;
    const order = {
      id: testId,
      paymentIntentId: 'pi_test_123',
      chargeId: 'ch_test_456',
      customerEmail: 'test@example.com',
      customerName: 'Test Customer',
      amount: 10000,
      currency: 'usd',
      status: 'paid',
      paidAt: new Date().toISOString(),
      items: [
        { description: 'Test Item', price: 10000, quantity: 1 },
      ],
      receiptUrl: null,
    };

    await store.save(order);
    const retrieved = await store.get(testId);

    if (!retrieved || retrieved.id !== testId) {
      throw new Error('Order not retrieved correctly');
    }
  });

  // Test 2: Currency formatting
  await test('Format various currencies correctly', () => {
    const testCases = [
      { cents: 10000, currency: 'usd', expected: '$100.00' },
      { cents: 1, currency: 'usd', expected: '$0.01' },
      { cents: 0, currency: 'usd', expected: '$0.00' },
    ];

    for (const { cents, currency, expected } of testCases) {
      const result = formatCurrency(cents, currency);
      if (result !== expected) {
        throw new Error(`Expected ${expected}, got ${result}`);
      }
    }
  });

  // Test 3: PDF generation
  await test('Generate receipt PDF successfully', async () => {
    const receiptDir = path.join(__dirname, '..', 'test-receipts');
    process.env.PDF_RECEIPT_DIR = receiptDir;

    const testOrder = {
      id: `PDF-${Date.now()}`,
      paymentIntentId: 'pi_test_pdf',
      customerEmail: 'pdf@example.com',
      customerName: 'PDF Test',
      amount: 5000,
      currency: 'usd',
      paidAt: new Date().toISOString(),
      items: [
        { description: 'Widget', price: 3000, quantity: 1 },
        { description: 'Service', price: 2000, quantity: 1 },
      ],
    };

    const pdfPath = await generateReceiptPDF(testOrder);

    // Verify PDF exists
    try {
      await fs.access(pdfPath);
    } catch {
      throw new Error('PDF file was not created');
    }

    // Clean up
    try {
      await fs.unlink(pdfPath);
      await fs.rmdir(receiptDir);
    } catch {
      // Cleanup is optional
    }
  });

  // Test 4: Item calculation with multiple items
  await test('Calculate order total correctly with multiple items', () => {
    const items = [
      { description: 'Item 1', price: 1999, quantity: 2 },
      { description: 'Item 2', price: 5000, quantity: 1 },
      { description: 'Item 3', price: 750, quantity: 4 },
    ];

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const expected = 1999 * 2 + 5000 * 1 + 750 * 4;

    if (total !== expected) {
      throw new Error(`Expected ${expected}, got ${total}`);
    }
  });

  // Test 5: Order metadata serialization
  await test('Serialize and deserialize order metadata', () => {
    const items = [
      { description: 'Product A', price: 2999, quantity: 1 },
      { description: 'Product B', price: 1999, quantity: 2 },
    ];

    const serialized = JSON.stringify(items);
    const deserialized = JSON.parse(serialized);

    if (deserialized.length !== items.length) {
      throw new Error('Metadata not serialized correctly');
    }

    if (deserialized[0].description !== items[0].description) {
      throw new Error('Metadata not deserialized correctly');
    }
  });

  // Test 6: Email mock mode (when SMTP not configured)
  await test('Email service handles missing configuration gracefully', async () => {
    const originalHost = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;

    const { sendPurchaseConfirmation } = await import('../services/email.js');

    try {
      await sendPurchaseConfirmation({
        email: 'test@example.com',
        name: 'Test',
        orderId: 'ORD-123',
        amount: 5000,
        currency: 'usd',
        items: [],
      });
    } catch (error) {
      if (!error.message.includes('MOCK')) {
        throw new Error('Email service should handle missing config gracefully');
      }
    }

    if (originalHost) {
      process.env.SMTP_HOST = originalHost;
    }
  });

  // Test 7: Timestamp validation
  await test('ISO timestamp formatting', () => {
    const now = new Date();
    const iso = now.toISOString();

    // Verify ISO format
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) {
      throw new Error('Invalid ISO timestamp format');
    }

    // Verify it can be parsed
    const parsed = new Date(iso);
    if (isNaN(parsed.getTime())) {
      throw new Error('ISO timestamp cannot be parsed');
    }
  });

  console.log(`\n${passCount}/${testCount} tests passed`);

  if (passCount === testCount) {
    console.log('✓ All integration tests passed');
    process.exit(0);
  } else {
    console.log(`✗ ${testCount - passCount} test(s) failed`);
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});
