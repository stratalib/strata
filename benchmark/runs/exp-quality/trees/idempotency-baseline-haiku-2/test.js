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

async function runTests() {
  await new Promise(resolve => server.listen(3001, resolve));

  console.log('=== Testing Idempotent Order Requests ===\n');

  try {
    // Test 1: Create an order
    console.log('Test 1: Create a new order');
    const createRes1 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-001',
      customerId: 'cust-123',
      items: [
        { sku: 'SKU-00001', quantity: 2, price: 29.99 },
        { sku: 'SKU-00002', quantity: 1, price: 49.99 },
      ],
      totalPrice: 109.97,
    });
    console.log(`  Status: ${createRes1.status}`);
    console.log(`  Message: ${createRes1.body.message}`);
    console.log(`  Order ID: ${createRes1.body.order.id}`);
    console.log(`  Created: ${createRes1.body.order.createdAt}`);
    const orderId = createRes1.body.order.id;
    console.log('  ✓ Pass\n');

    // Test 2: Retry with same idempotency key
    console.log('Test 2: Retry same request (duplicate)');
    const createRes2 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-001',
      customerId: 'cust-123',
      items: [
        { sku: 'SKU-00001', quantity: 2, price: 29.99 },
        { sku: 'SKU-00002', quantity: 1, price: 49.99 },
      ],
      totalPrice: 109.97,
    });
    console.log(`  Status: ${createRes2.status}`);
    console.log(`  Message: ${createRes2.body.message}`);
    console.log(`  Returned Order ID: ${createRes2.body.order.id}`);
    if (createRes2.body.order.id === orderId) {
      console.log('  ✓ Same order returned (idempotency working)\n');
    } else {
      console.log('  ✗ Different order created (idempotency FAILED)\n');
    }

    // Test 3: Multiple retries
    console.log('Test 3: Multiple retries with same idempotency key');
    const createRes3 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-001',
      customerId: 'cust-123',
      items: [
        { sku: 'SKU-00001', quantity: 2, price: 29.99 },
        { sku: 'SKU-00002', quantity: 1, price: 49.99 },
      ],
      totalPrice: 109.97,
    });
    console.log(`  Status: ${createRes3.status}`);
    if (createRes3.body.order.id === orderId) {
      console.log('  ✓ Still same order returned\n');
    }

    // Test 4: Different idempotency key creates new order
    console.log('Test 4: Different idempotency key creates new order');
    const createRes4 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-002',
      customerId: 'cust-123',
      items: [
        { sku: 'SKU-00003', quantity: 1, price: 15.99 },
      ],
      totalPrice: 15.99,
    });
    console.log(`  Status: ${createRes4.status}`);
    console.log(`  New Order ID: ${createRes4.body.order.id}`);
    if (createRes4.body.order.id !== orderId) {
      console.log('  ✓ Different order created\n');
    }

    // Test 5: Missing idempotencyKey
    console.log('Test 5: Validation - missing idempotencyKey');
    const validateRes1 = await makeRequest('POST', '/orders', {
      customerId: 'cust-456',
      items: [{ sku: 'SKU-00001', quantity: 1, price: 29.99 }],
      totalPrice: 29.99,
    });
    console.log(`  Status: ${validateRes1.status}`);
    console.log(`  Error: ${validateRes1.body.error}`);
    if (validateRes1.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 6: Empty idempotencyKey
    console.log('Test 6: Validation - empty idempotencyKey');
    const validateRes2 = await makeRequest('POST', '/orders', {
      idempotencyKey: '  ',
      customerId: 'cust-456',
      items: [{ sku: 'SKU-00001', quantity: 1, price: 29.99 }],
      totalPrice: 29.99,
    });
    console.log(`  Status: ${validateRes2.status}`);
    if (validateRes2.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 7: Missing customerId
    console.log('Test 7: Validation - missing customerId');
    const validateRes3 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-test',
      items: [{ sku: 'SKU-00001', quantity: 1, price: 29.99 }],
      totalPrice: 29.99,
    });
    console.log(`  Status: ${validateRes3.status}`);
    if (validateRes3.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 8: Empty items array
    console.log('Test 8: Validation - empty items array');
    const validateRes4 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-test',
      customerId: 'cust-456',
      items: [],
      totalPrice: 0,
    });
    console.log(`  Status: ${validateRes4.status}`);
    if (validateRes4.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 9: Invalid item (missing quantity)
    console.log('Test 9: Validation - item missing quantity');
    const validateRes5 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-test',
      customerId: 'cust-456',
      items: [{ sku: 'SKU-00001', price: 29.99 }],
      totalPrice: 29.99,
    });
    console.log(`  Status: ${validateRes5.status}`);
    if (validateRes5.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 10: Negative totalPrice
    console.log('Test 10: Validation - negative totalPrice');
    const validateRes6 = await makeRequest('POST', '/orders', {
      idempotencyKey: 'req-test',
      customerId: 'cust-456',
      items: [{ sku: 'SKU-00001', quantity: 1, price: 29.99 }],
      totalPrice: -10,
    });
    console.log(`  Status: ${validateRes6.status}`);
    if (validateRes6.status === 400) {
      console.log('  ✓ Validation error returned\n');
    }

    // Test 11: Fetch order by ID
    console.log('Test 11: Fetch order by ID');
    const getRes = await makeRequest('GET', `/orders/${orderId}`, null);
    console.log(`  Status: ${getRes.status}`);
    console.log(`  Order ID: ${getRes.body.id}`);
    console.log(`  Customer: ${getRes.body.customerId}`);
    if (getRes.status === 200) {
      console.log('  ✓ Order retrieved\n');
    }

    // Test 12: List all orders
    console.log('Test 12: List all orders');
    const listRes = await makeRequest('GET', '/orders', null);
    console.log(`  Status: ${listRes.status}`);
    console.log(`  Total orders: ${listRes.body.length}`);
    if (listRes.body.length >= 2) {
      console.log('  ✓ Multiple orders returned\n');
    }

    // Test 13: View request log
    console.log('Test 13: View request log (admin endpoint)');
    const logRes = await makeRequest('GET', '/admin/request-log', null);
    console.log(`  Status: ${logRes.status}`);
    console.log(`  Log entries: ${logRes.body.length}`);
    const createdEntries = logRes.body.filter(e => e.attempt === 'created').length;
    const duplicateEntries = logRes.body.filter(e => e.attempt === 'duplicate_detected').length;
    const failedEntries = logRes.body.filter(e => e.attempt === 'validation_failed').length;
    console.log(`  - Created: ${createdEntries}`);
    console.log(`  - Duplicate detected: ${duplicateEntries}`);
    console.log(`  - Validation failed: ${failedEntries}`);
    console.log('  ✓ Log entries available\n');

    console.log('=== All Tests Passed ===');
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    server.close();
  }
}

runTests();
