'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { validateOrderBody } = require('../validation/orderValidation');
const productRepository = require('../data/productRepository');

// productRepository.seed() lazily creates its rows on first call; call it up front so tests know a
// real SKU to reference.
const [firstProduct] = productRepository.seed();

const app = require('../server');

function withServer(fn) {
  return async () => {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function postOrder(baseUrl, body, rawBody) {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('validateOrderBody: rejects missing fields', () => {
  const errors = validateOrderBody({});
  assert.ok(errors.some(e => e.includes('idempotencyKey')));
  assert.ok(errors.some(e => e.includes('customerEmail')));
  assert.ok(errors.some(e => e.includes('items')));
});

test('validateOrderBody: rejects malformed email', () => {
  const errors = validateOrderBody({
    idempotencyKey: 'k1',
    customerEmail: 'not-an-email',
    items: [{ sku: 'SKU-00001', quantity: 1 }],
  });
  assert.ok(errors.some(e => e.includes('customerEmail')));
});

test('validateOrderBody: rejects non-positive / non-integer quantity', () => {
  const errors1 = validateOrderBody({
    idempotencyKey: 'k1',
    customerEmail: 'a@b.com',
    items: [{ sku: 'SKU-00001', quantity: 0 }],
  });
  assert.ok(errors1.some(e => e.includes('quantity')));

  const errors2 = validateOrderBody({
    idempotencyKey: 'k1',
    customerEmail: 'a@b.com',
    items: [{ sku: 'SKU-00001', quantity: 1.5 }],
  });
  assert.ok(errors2.some(e => e.includes('quantity')));
});

test('validateOrderBody: rejects empty items array', () => {
  const errors = validateOrderBody({
    idempotencyKey: 'k1',
    customerEmail: 'a@b.com',
    items: [],
  });
  assert.ok(errors.some(e => e.includes('items')));
});

test('validateOrderBody: accepts a well-formed body', () => {
  const errors = validateOrderBody({
    idempotencyKey: 'k1',
    customerEmail: 'a@b.com',
    items: [{ sku: 'SKU-00001', quantity: 2 }],
  });
  assert.deepEqual(errors, []);
});

test('POST /orders: rejects invalid body with 400 and does not create an order', withServer(async (baseUrl) => {
  const { status, json } = await postOrder(baseUrl, { idempotencyKey: 'bad-1' });
  assert.equal(status, 400);
  assert.equal(json.error, 'validation_failed');
}));

test('POST /orders: rejects malformed JSON with 400, not a crash', withServer(async (baseUrl) => {
  const { status, json } = await postOrder(baseUrl, null, '{not json');
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_json');
}));

test('POST /orders: rejects a sku that does not exist in the catalog', withServer(async (baseUrl) => {
  const { status, json } = await postOrder(baseUrl, {
    idempotencyKey: 'bad-sku-1',
    customerEmail: 'a@b.com',
    items: [{ sku: 'NOPE-DOES-NOT-EXIST', quantity: 1 }],
  });
  assert.equal(status, 400);
  assert.ok(json.details.some(d => d.includes('does not match any product')));
}));

test('POST /orders: creates an order and returns 201', withServer(async (baseUrl) => {
  const { status, json } = await postOrder(baseUrl, {
    idempotencyKey: 'order-1',
    customerEmail: 'buyer@example.com',
    items: [{ sku: firstProduct.sku, quantity: 3 }],
  });
  assert.equal(status, 201);
  assert.equal(json.replayed, false);
  assert.equal(json.customerEmail, 'buyer@example.com');
  assert.ok(json.id);
}));

test('POST /orders: retrying the same idempotencyKey does not create a second order', withServer(async (baseUrl) => {
  const body = {
    idempotencyKey: 'order-retry-1',
    customerEmail: 'buyer@example.com',
    items: [{ sku: firstProduct.sku, quantity: 1 }],
  };

  const first = await postOrder(baseUrl, body);
  assert.equal(first.status, 201);

  const second = await postOrder(baseUrl, body);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.json.id, first.json.id);

  // A differently-shaped retry (e.g. client retried with a slightly different payload but the same
  // key) still returns the ORIGINAL order rather than the new items — the key is authoritative.
  const third = await postOrder(baseUrl, { ...body, items: [{ sku: firstProduct.sku, quantity: 99 }] });
  assert.equal(third.status, 200);
  assert.equal(third.json.id, first.json.id);
  assert.equal(third.json.items[0].quantity, 1);
}));

test('POST /orders: concurrent retries with the same key still produce exactly one order', withServer(async (baseUrl) => {
  const body = {
    idempotencyKey: 'order-concurrent-1',
    customerEmail: 'buyer@example.com',
    items: [{ sku: firstProduct.sku, quantity: 1 }],
  };

  const results = await Promise.all([
    postOrder(baseUrl, body),
    postOrder(baseUrl, body),
    postOrder(baseUrl, body),
    postOrder(baseUrl, body),
    postOrder(baseUrl, body),
  ]);

  const ids = new Set(results.map(r => r.json.id));
  assert.equal(ids.size, 1, 'all concurrent retries must resolve to the same order id');

  const createdCount = results.filter(r => r.status === 201).length;
  assert.equal(createdCount, 1, 'exactly one of the concurrent requests should report creation');
}));

test('POST /orders: different idempotencyKeys create different orders', withServer(async (baseUrl) => {
  const makeBody = key => ({
    idempotencyKey: key,
    customerEmail: 'buyer@example.com',
    items: [{ sku: firstProduct.sku, quantity: 1 }],
  });

  const a = await postOrder(baseUrl, makeBody('order-distinct-a'));
  const b = await postOrder(baseUrl, makeBody('order-distinct-b'));

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.json.id, b.json.id);
}));
