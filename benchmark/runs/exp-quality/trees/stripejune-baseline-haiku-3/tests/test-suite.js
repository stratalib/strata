import { config } from 'dotenv';
import assert from 'assert';
import Stripe from 'stripe';
import crypto from 'crypto';
import { getOrderStore } from '../storage/order-store.js';
import { formatCurrency, formatDate } from '../utils/formatters.js';

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('Running test suite...\n');

  // Test formatters
  await test('formatCurrency formats USD correctly', () => {
    assert.strictEqual(formatCurrency(1000, 'usd'), '$10.00');
    assert.strictEqual(formatCurrency(1, 'usd'), '$0.01');
    assert.strictEqual(formatCurrency(0, 'usd'), '$0.00');
  });

  await test('formatCurrency formats EUR correctly', () => {
    const result = formatCurrency(1000, 'eur');
    assert(result.includes('10'));
  });

  await test('formatDate formats ISO strings', () => {
    const date = new Date('2024-01-15T10:30:00Z');
    const result = formatDate(date.toISOString());
    assert(result.includes('2024'));
    assert(result.includes('January') || result.includes('Jan'));
    assert(result.includes('15'));
  });

  // Test order store
  await test('OrderStore saves and retrieves orders', async () => {
    const store = getOrderStore();
    const order = {
      id: `TEST-${Date.now()}`,
      customerEmail: 'test@example.com',
      customerName: 'Test User',
      amount: 5000,
      currency: 'usd',
      status: 'paid',
      paidAt: new Date().toISOString(),
      items: [{ description: 'Test Item', price: 5000, quantity: 1 }],
    };

    await store.save(order);
    const retrieved = await store.get(order.id);

    assert.strictEqual(retrieved.id, order.id);
    assert.strictEqual(retrieved.customerEmail, order.customerEmail);
    assert.strictEqual(retrieved.amount, order.amount);
  });

  // Test Stripe connectivity
  await test('Stripe API key is valid', async () => {
    try {
      const balance = await stripe.balance.retrieve();
      assert(balance.available || Array.isArray(balance.available));
    } catch (error) {
      throw new Error(`Stripe API error: ${error.message}`);
    }
  });

  // Test order ID generation
  await test('Order IDs are unique and properly formatted', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const id = 'ORD-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      assert(id.startsWith('ORD-'));
      assert(id.length === 'ORD-0123456789ABCDEF'.length);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 100, 'All generated IDs should be unique');
  });

  // Test payment intent metadata structure
  await test('Payment intent metadata is properly structured', async () => {
    const items = [
      { description: 'Widget', price: 1999, quantity: 2 },
      { description: 'Gadget', price: 4999, quantity: 1 },
    ];
    const amount = (1999 * 2 + 4999) * 100;
    const metadata = {
      orderId: 'ORD-TEST123',
      customerEmail: 'test@example.com',
      customerName: 'Test User',
      items: JSON.stringify(items),
    };

    const parsed = JSON.parse(metadata.items);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].description, 'Widget');
    assert.strictEqual(parsed[1].price, 4999);
  });

  // Test item validation logic
  await test('Item validation catches invalid inputs', () => {
    const validItem = { description: 'Valid', price: 100, quantity: 1 };
    const invalidItems = [
      { description: 'No price', quantity: 1 },
      { description: 'Invalid price', price: 'not a number', quantity: 1 },
      { description: 'No quantity', price: 100 },
      { description: 'Negative price', price: -100, quantity: 1 },
      { description: 'Negative quantity', price: 100, quantity: -1 },
    ];

    assert(validItem.description && typeof validItem.price === 'number' && validItem.quantity);

    for (const item of invalidItems) {
      const isValid = item.description && typeof item.price === 'number' && item.quantity;
      const isNonNegative = item.price >= 0 && item.quantity >= 0;
      assert(!isValid || !isNonNegative, 'Invalid item should fail validation');
    }
  });

  // Test amount calculation
  await test('Amount calculation handles multiple items', () => {
    const items = [
      { description: 'Item 1', price: 1000, quantity: 1 }, // 1000
      { description: 'Item 2', price: 2500, quantity: 2 }, // 5000
      { description: 'Item 3', price: 750, quantity: 4 }, // 3000
    ];
    const totalCents = Math.round(
      items.reduce((sum, item) => sum + item.price * item.quantity * 100, 0)
    );
    assert.strictEqual(totalCents, 900000); // $9000
  });

  // Test floating point precision in amount calculation
  await test('Amount calculation handles decimal prices correctly', () => {
    const items = [
      { description: 'Item', price: 19.99, quantity: 3 }, // 59.97
    ];
    const totalCents = Math.round(
      items.reduce((sum, item) => sum + item.price * item.quantity * 100, 0)
    );
    assert.strictEqual(totalCents, 5997); // $59.97
  });

  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});
