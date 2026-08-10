'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/server');
const productRepo = require('../src/data/productRepository');

let server;
let base;
let validSku;

before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // Grab a real, active SKU from the seeded catalog so orders reference something that exists.
  const products = await productRepo.findAll();
  validSku = products.find(p => p.active).sku;
});

after(() => server.close());

// Minimal request helper. Returns { status, body }.
function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          let parsed = raw;
          try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function validOrder() {
  return { customerEmail: 'buyer@example.com', items: [{ sku: validSku, quantity: 2 }] };
}

test('creates an order on first request', async () => {
  const res = await request('POST', '/orders', { headers: { 'Idempotency-Key': 'k-create-1' }, body: validOrder() });
  assert.equal(res.status, 201);
  assert.ok(Number.isInteger(res.body.id));
  assert.equal(res.body.status, 'CONFIRMED');
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].quantity, 2);
  assert.ok(res.body.total > 0);
});

test('a retry with the same idempotency key does not create a second order', async () => {
  const key = 'k-retry-seq';
  const first = await request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() });
  const second = await request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200); // replay
  assert.equal(second.body.id, first.body.id); // same order, not a new one
});

test('concurrent retries with the same key create exactly one order', async () => {
  const key = 'k-retry-concurrent';
  const [a, b, c] = await Promise.all([
    request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() }),
    request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() }),
    request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() }),
  ]);
  const ids = [a, b, c].map(r => r.body.id);
  assert.equal(new Set(ids).size, 1, `expected one order id, got ${JSON.stringify(ids)}`);
  const created = [a, b, c].filter(r => r.status === 201).length;
  assert.equal(created, 1, 'exactly one request should have created the order');
});

test('different idempotency keys create different orders', async () => {
  const first = await request('POST', '/orders', { headers: { 'Idempotency-Key': 'k-distinct-a' }, body: validOrder() });
  const second = await request('POST', '/orders', { headers: { 'Idempotency-Key': 'k-distinct-b' }, body: validOrder() });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
});

test('rejects a request with no idempotency key', async () => {
  const res = await request('POST', '/orders', { body: validOrder() });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Idempotency-Key/);
});

test('rejects an invalid email', async () => {
  const res = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': 'k-bademail' },
    body: { customerEmail: 'not-an-email', items: [{ sku: validSku, quantity: 1 }] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some(d => /customerEmail/.test(d)));
});

test('rejects empty items', async () => {
  const res = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': 'k-noitems' },
    body: { customerEmail: 'buyer@example.com', items: [] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some(d => /items/.test(d)));
});

test('rejects a nonexistent sku', async () => {
  const res = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': 'k-badsku' },
    body: { customerEmail: 'buyer@example.com', items: [{ sku: 'SKU-DOES-NOT-EXIST', quantity: 1 }] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some(d => /does not exist/.test(d)));
});

test('rejects a non-positive quantity', async () => {
  const res = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': 'k-badqty' },
    body: { customerEmail: 'buyer@example.com', items: [{ sku: validSku, quantity: 0 }] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some(d => /quantity/.test(d)));
});

test('rejects malformed JSON with a clean 400', async () => {
  const res = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': 'k-badjson' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid JSON/);
});

test('after a validation failure, a corrected retry with the same key succeeds', async () => {
  const key = 'k-fix-then-retry';
  const bad = await request('POST', '/orders', {
    headers: { 'Idempotency-Key': key },
    body: { customerEmail: 'buyer@example.com', items: [{ sku: validSku, quantity: 0 }] },
  });
  assert.equal(bad.status, 400);
  const good = await request('POST', '/orders', { headers: { 'Idempotency-Key': key }, body: validOrder() });
  assert.equal(good.status, 201); // key was released after the failed attempt, so this creates the order
});

test('fetches a created order by id', async () => {
  const created = await request('POST', '/orders', { headers: { 'Idempotency-Key': 'k-fetch' }, body: validOrder() });
  const fetched = await request('GET', `/orders/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, created.body.id);
});
