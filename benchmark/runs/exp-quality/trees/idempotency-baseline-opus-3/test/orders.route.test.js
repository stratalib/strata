'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/server');
const orderRepository = require('../src/data/orderRepository');

const validOrder = () => ({
  customerId: 'cust-42',
  items: [
    { sku: 'SKU-00001', quantity: 2, unitPriceCents: 1500 },
    { sku: 'SKU-00002', quantity: 1, unitPriceCents: 999 },
  ],
});

beforeEach(() => orderRepository._reset());

test('creates an order and computes the total in cents', async () => {
  const res = await request(app).post('/orders').send(validOrder());
  assert.equal(res.status, 201);
  assert.equal(res.body.totalCents, 2 * 1500 + 1 * 999);
  assert.equal(res.body.status, 'CONFIRMED');
  assert.ok(res.body.id);
});

test('rejects an invalid body with 400 and field details', async () => {
  const res = await request(app).post('/orders').send({ items: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ValidationError');
  assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0);
});

test('rejects malformed JSON with a clean 400', async () => {
  const res = await request(app)
    .post('/orders')
    .set('Content-Type', 'application/json')
    .send('{ this is not json ');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('a retry with the same Idempotency-Key does NOT create a second order', async () => {
  const key = 'idem-key-abc';
  const body = validOrder();

  const first = await request(app).post('/orders').set('Idempotency-Key', key).send(body);
  assert.equal(first.status, 201); // created

  const retry = await request(app).post('/orders').set('Idempotency-Key', key).send(body);
  assert.equal(retry.status, 200); // replayed, not created
  assert.equal(retry.body.id, first.body.id, 'retry must return the SAME order id');

  // And there is genuinely only one order in the store.
  assert.ok(orderRepository.findById(first.body.id));
  assert.equal(orderRepository.findById(first.body.id + 1), null);
});

test('same key + different body is rejected with 422 (not a silent duplicate)', async () => {
  const key = 'idem-key-conflict';
  await request(app).post('/orders').set('Idempotency-Key', key).send(validOrder());

  const changed = validOrder();
  changed.items[0].quantity = 99;
  const res = await request(app).post('/orders').set('Idempotency-Key', key).send(changed);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'IdempotencyKeyReused');
});

test('no idempotency key means each request is its own order', async () => {
  const a = await request(app).post('/orders').send(validOrder());
  const b = await request(app).post('/orders').send(validOrder());
  assert.notEqual(a.body.id, b.body.id);
});

test('concurrent retries with the same key still produce exactly one order', async () => {
  const key = 'idem-key-race';
  const body = validOrder();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(app).post('/orders').set('Idempotency-Key', key).send(body)
    )
  );
  const ids = new Set(responses.map(r => r.body.id));
  assert.equal(ids.size, 1, 'all concurrent retries must resolve to one order id');
  const created = responses.filter(r => r.status === 201);
  assert.equal(created.length, 1, 'exactly one response should be a 201 create');
});

test('GET /orders/:id returns a created order and 404 for a missing one', async () => {
  const created = await request(app).post('/orders').send(validOrder());
  const found = await request(app).get(`/orders/${created.body.id}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.id, created.body.id);

  const missing = await request(app).get('/orders/999999');
  assert.equal(missing.status, 404);
});
