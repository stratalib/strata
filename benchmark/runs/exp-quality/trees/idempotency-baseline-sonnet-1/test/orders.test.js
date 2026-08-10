'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const orderRepository = require('../src/data/orderRepository');

let server;
let baseUrl;

before(() => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  orderRepository._reset();
});

function validBody(overrides = {}) {
  return {
    customerId: 'cust-1',
    items: [{ sku: 'SKU-00001', quantity: 2, unitPrice: 9.99 }],
    ...overrides,
  };
}

test('rejects a request with no idempotency key', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody()),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Idempotency-Key/);
});

test('rejects invalid bodies with details on what is wrong', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-invalid' },
    body: JSON.stringify({ customerId: '', items: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'validation failed');
  assert.ok(body.details.some(d => d.includes('customerId')));
  assert.ok(body.details.some(d => d.includes('items')));
});

test('rejects malformed item fields', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-bad-item' },
    body: JSON.stringify(validBody({ items: [{ sku: '', quantity: -1, unitPrice: 0 }] })),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.details.some(d => d.includes('items[0].sku')));
  assert.ok(body.details.some(d => d.includes('items[0].quantity')));
  assert.ok(body.details.some(d => d.includes('items[0].unitPrice')));
});

test('rejects malformed JSON body', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-malformed' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
});

test('creates an order on first request', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-create-1' },
    body: JSON.stringify(validBody()),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.replayed, false);
  assert.equal(body.order.status, 'CREATED');
  assert.equal(body.order.totalPrice, 19.98);
});

test('retrying the same idempotency key returns the original order, not a new one', async () => {
  const key = 'key-retry-1';
  const first = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(validBody()),
  });
  const firstBody = await first.json();
  assert.equal(first.status, 201);

  const second = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(validBody({ customerId: 'someone-else' })),
  });
  const secondBody = await second.json();

  assert.equal(second.status, 200);
  assert.equal(secondBody.replayed, true);
  assert.equal(secondBody.order.id, firstBody.order.id);
  assert.equal(secondBody.order.customerId, 'cust-1');
});

test('two concurrent requests with the same key create exactly one order', async () => {
  // Express (no awaits inside the handler before the reservation is claimed) processes these on
  // the same event-loop turn, so this never actually hits the true race window - it exercises the
  // "replay" path instead of "in-flight". The unit test below hits reserve() directly to prove the
  // in-flight branch. What both tests defend is the same invariant: exactly one order per key.
  const key = 'key-concurrent-1';
  const send = () =>
    fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(validBody()),
    });

  const [r1, r2] = await Promise.all([send(), send()]);
  const statuses = [r1.status, r2.status].sort();

  assert.deepEqual(statuses, [200, 201]);

  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.equal(b1.order.id, b2.order.id);

  const getRes = await fetch(`${baseUrl}/orders/${key}`);
  assert.equal(getRes.status, 200);
});

test('reserve() rejects a second claim while the first is still in flight', () => {
  const key = 'key-reserve-race';
  const first = orderRepository.reserve(key);
  const second = orderRepository.reserve(key);

  assert.equal(first.status, 'reserved');
  assert.equal(second.status, 'in-flight');

  orderRepository.create(key, validBody());
  const third = orderRepository.reserve(key);
  assert.equal(third.status, 'already-completed');
});

test('different idempotency keys create different orders', async () => {
  const r1 = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-a' },
    body: JSON.stringify(validBody()),
  });
  const r2 = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-b' },
    body: JSON.stringify(validBody()),
  });
  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.notEqual(b1.order.id, b2.order.id);
});

test('accepts idempotency key from body when header is absent', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody({ idempotencyKey: 'key-in-body' })),
  });
  assert.equal(res.status, 201);
});
