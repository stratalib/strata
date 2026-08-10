'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/server');
const orderRepo = require('../src/data/orderRepository');
const productRepo = require('../src/data/productRepository');

let server;
let baseUrl;

before(async () => {
  // Bind to port 0 so the OS hands us a free port — no clashes if something's already on 3000.
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

beforeEach(async () => {
  orderRepo._reset();
  // seed() only populates once; product stock is shared across tests and isn't reset. Pin the SKUs
  // these tests rely on to known, generous levels so assertions don't depend on random seed values
  // or on decrements bleeding across tests.
  productRepo.seed();
  (await productRepo.findBySku('SKU-00002')).quantity = 500;
  (await productRepo.findBySku('SKU-00003')).quantity = 500;
});

async function post(path, { body, headers } = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// A known-good product from the seed data. Seed marks every 7th product (i=0,7,...) inactive, so
// SKU-00001 (i=0) is inactive — use SKU-00002 (i=1), which is active with a non-zero price.
const goodItem = () => ({ sku: 'SKU-00002', quantity: 1 });
const goodBody = () => ({ customerEmail: 'buyer@example.com', items: [goodItem()] });

test('creates an order on a valid request', async () => {
  const res = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': 'k-create' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.order.customerEmail, 'buyer@example.com');
  assert.equal(res.body.order.items.length, 1);
  assert.equal(res.body.order.status, 'CONFIRMED');
  assert.ok(res.body.order.total > 0);
});

test('a retried request with the same Idempotency-Key does NOT create a second order', async () => {
  const key = 'retry-key-123';
  const first = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': key } });
  const second = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': key } });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  // Same response replayed — same order id — and only one order exists in the store.
  assert.equal(second.body.order.id, first.body.order.id);
  const all = await orderRepo.findAll();
  assert.equal(all.length, 1);
});

test('different Idempotency-Keys create distinct orders even with identical bodies', async () => {
  const a = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': 'key-a' } });
  const b = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': 'key-b' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.order.id, b.body.order.id);
  const all = await orderRepo.findAll();
  assert.equal(all.length, 2);
});

test('concurrent retries with the same key create exactly one order', async () => {
  const key = 'concurrent-key';
  const body = goodBody();
  // Fire several at once. Whichever wins claims the key; the rest either replay or get 409 — but the
  // store must end with exactly one order.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post('/orders', { body, headers: { 'Idempotency-Key': key } })
    )
  );
  const created = results.filter(r => r.status === 201);
  assert.ok(created.length >= 1);
  // Every 201 refers to the same single order.
  const ids = new Set(created.map(r => r.body.order.id));
  assert.equal(ids.size, 1);
  const all = await orderRepo.findAll();
  assert.equal(all.length, 1);
});

test('rejects a request with no Idempotency-Key', async () => {
  const res = await post('/orders', { body: goodBody() });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Idempotency-Key/);
});

test('rejects a body missing customerEmail and items', async () => {
  const res = await post('/orders', { body: {}, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation failed');
  assert.ok(res.body.details.some(d => /customerEmail/.test(d)));
  assert.ok(res.body.details.some(d => /items/.test(d)));
});

test('rejects invalid email and non-integer quantity', async () => {
  const res = await post('/orders', {
    body: { customerEmail: 'not-an-email', items: [{ sku: 'SKU-00001', quantity: 2.5 }] },
    headers: { 'Idempotency-Key': 'k2' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.some(d => /customerEmail/.test(d)));
  assert.ok(res.body.details.some(d => /quantity/.test(d)));
});

test('retrying an invalid request replays the same 400 (does not later succeed)', async () => {
  const key = 'bad-then-same';
  const first = await post('/orders', { body: {}, headers: { 'Idempotency-Key': key } });
  const second = await post('/orders', { body: {}, headers: { 'Idempotency-Key': key } });
  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
  assert.deepEqual(second.body, first.body);
});

test('rejects an unknown sku with 422', async () => {
  const res = await post('/orders', {
    body: { customerEmail: 'buyer@example.com', items: [{ sku: 'NOPE-000', quantity: 1 }] },
    headers: { 'Idempotency-Key': 'k3' },
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /unknown or unavailable/);
});

test('rejects insufficient stock with 409 and does not decrement', async () => {
  const product = await productRepo.findBySku('SKU-00002');
  const before = product.quantity;
  const res = await post('/orders', {
    body: { customerEmail: 'buyer@example.com', items: [{ sku: 'SKU-00002', quantity: before + 1000 }] },
    headers: { 'Idempotency-Key': 'k4' },
  });
  assert.equal(res.status, 409);
  const after = (await productRepo.findBySku('SKU-00002')).quantity;
  assert.equal(after, before); // stock untouched
});

test('decrements stock on a successful order', async () => {
  // Seed quantities are random, so pin a known level first to keep the assertion deterministic.
  const product = await productRepo.findBySku('SKU-00003');
  product.quantity = 50;
  const res = await post('/orders', {
    body: { customerEmail: 'buyer@example.com', items: [{ sku: 'SKU-00003', quantity: 2 }] },
    headers: { 'Idempotency-Key': 'k5' },
  });
  assert.equal(res.status, 201);
  const after = (await productRepo.findBySku('SKU-00003')).quantity;
  assert.equal(after, 48);
});

test('rejects malformed JSON with a clean 400', async () => {
  const res = await post('/orders', {
    body: '{ this is not json',
    headers: { 'Idempotency-Key': 'k6' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid JSON/);
});

test('GET /orders/:id returns a created order and 404 for unknown', async () => {
  const created = await post('/orders', { body: goodBody(), headers: { 'Idempotency-Key': 'k7' } });
  const id = created.body.order.id;
  const found = await fetch(`${baseUrl}/orders/${id}`).then(r => r.json());
  assert.equal(found.order.id, id);
  const missing = await fetch(`${baseUrl}/orders/999999`);
  assert.equal(missing.status, 404);
});
