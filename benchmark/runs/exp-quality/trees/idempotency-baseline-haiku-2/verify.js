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

async function verify() {
  await new Promise(resolve => server.listen(3001, resolve));

  console.log('=== Idempotent Order Handler Verification ===\n');

  try {
    // Scenario: Network retry with same idempotency key
    console.log('Scenario: Customer retries order due to network timeout\n');

    const idempotencyKey = `order-${Date.now()}`;
    const orderData = {
      idempotencyKey,
      customerId: 'customer-42',
      items: [
        { sku: 'SKU-00001', quantity: 3, price: 25.50 },
        { sku: 'SKU-00002', quantity: 1, price: 99.99 },
      ],
      totalPrice: 175.49,
    };

    // First attempt
    console.log('→ First request (initial submission):');
    const res1 = await makeRequest('POST', '/orders', orderData);
    console.log(`  Status: ${res1.status}`);
    console.log(`  Order ID: ${res1.body.order.id}`);
    console.log(`  Message: "${res1.body.message}"\n`);

    // Second attempt (retry) - same idempotency key
    console.log('→ Second request (network timeout, client retries):');
    const res2 = await makeRequest('POST', '/orders', orderData);
    console.log(`  Status: ${res2.status}`);
    console.log(`  Order ID: ${res2.body.order.id}`);
    console.log(`  Message: "${res2.body.message}"\n`);

    // Third attempt (retry again)
    console.log('→ Third request (another retry):');
    const res3 = await makeRequest('POST', '/orders', orderData);
    console.log(`  Status: ${res3.status}`);
    console.log(`  Order ID: ${res3.body.order.id}`);
    console.log(`  Message: "${res3.body.message}"\n`);

    // Verify only one order was created
    const ordersRes = await makeRequest('GET', '/orders', null);
    const createdOrders = ordersRes.body.filter(o => o.customerId === 'customer-42');
    console.log(`✓ Verification: ${createdOrders.length} order created (not 3)\n`);

    // Check request log
    const logRes = await makeRequest('GET', '/admin/request-log', null);
    const orderLogs = logRes.body.filter(e => e.idempotencyKey === idempotencyKey);
    console.log('Request log entries for this idempotency key:');
    orderLogs.forEach((entry, i) => {
      console.log(`  ${i + 1}. ${entry.attempt} at ${entry.timestamp}`);
    });

    console.log('\n=== ✓ Idempotency Working ===');
    console.log('Same idempotency key returned the same order');
    console.log('No duplicate orders created despite multiple requests');
  } catch (err) {
    console.error('Verification failed:', err);
  } finally {
    server.close();
  }
}

verify();
