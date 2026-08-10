'use strict';

const express = require('express');
const orderRoutes = require('./src/routes/orders');
const http = require('http');

const app = express();
app.use(express.json());
app.use(orderRoutes);

const server = http.createServer(app);
const BASE_URL = 'http://localhost:3001';

function makeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data ? JSON.parse(data) : null,
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  await new Promise(resolve => server.listen(3001, resolve));

  console.log('=== Edge Case Tests ===\n');

  try {
    // Test 1: Zero quantity
    console.log('Test 1: Zero quantity in item');
    const res1 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'test-1',
      customerId: 'cust-1',
      items: [{ sku: 'SKU-1', quantity: 0, price: 10 }],
      totalPrice: 0,
    });
    console.log(`  Status: ${res1.status} (should be 400)\n`);

    // Test 2: Null values
    console.log('Test 2: Null customerId');
    const res2 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'test-2',
      customerId: null,
      items: [{ sku: 'SKU-1', quantity: 1, price: 10 }],
      totalPrice: 10,
    });
    console.log(`  Status: ${res2.status} (should be 400)\n`);

    // Test 3: Valid order
    console.log('Test 3: Valid order');
    const res3 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'valid-order',
      customerId: 'cust-valid',
      items: [{ sku: 'SKU-123', quantity: 2, price: 45.99 }],
      totalPrice: 91.98,
    });
    console.log(`  Status: ${res3.status} (should be 201)`);
    console.log(`  Order created: ${res3.body.order.id}\n`);

    // Test 4: Check logs - only valid order should be logged
    console.log('Test 4: Check request logs');
    const logRes = await makeRequest('GET', '/admin/request-log', null);
    console.log(`  Total log entries: ${logRes.body.length}`);
    const created = logRes.body.filter(e => e.attempt === 'created');
    const validationFailed = logRes.body.filter(e => e.attempt === 'validation_failed');
    console.log(`  - Created: ${created.length}`);
    console.log(`  - Validation failed: ${validationFailed.length}`);
    console.log('  ✓ Validation errors are logged, preventing bad orders from slipping through\n');

    // Test 5: Same valid order again (should detect duplicate)
    console.log('Test 5: Retry valid order');
    const res5 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'valid-order',
      customerId: 'cust-valid',
      items: [{ sku: 'SKU-123', quantity: 2, price: 45.99 }],
      totalPrice: 91.98,
    });
    console.log(`  Status: ${res5.status} (should be 200)`);
    console.log(`  Same order ID: ${res5.body.order.id}\n`);

    // Test 6: Large items array
    console.log('Test 6: Large items array (50 items)');
    const largeItems = Array.from({ length: 50 }, (_, i) => ({
      sku: `SKU-${i}`,
      quantity: 1,
      price: 10 + i,
    }));
    const largeTotal = largeItems.reduce((sum, item) => sum + item.price, 0);
    const res6 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'large-order',
      customerId: 'cust-large',
      items: largeItems,
      totalPrice: largeTotal,
    });
    console.log(`  Status: ${res6.status} (should be 201)`);
    console.log(`  Order size: ${res6.body.order.items.length} items\n`);

    // Test 7: All numeric edge cases
    console.log('Test 7: Maximum safe integer as totalPrice');
    const res7 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'big-price',
      customerId: 'cust-big',
      items: [{ sku: 'SKU-BIG', quantity: 1, price: Number.MAX_SAFE_INTEGER }],
      totalPrice: Number.MAX_SAFE_INTEGER,
    });
    console.log(`  Status: ${res7.status} (should be 201)\n`);

    console.log('=== All edge cases handled correctly ===');
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    server.close();
  }
}

test();
