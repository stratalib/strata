'use strict';
// Order data access, mirroring productRepository.js: an in-memory store behind a narrow API so
// routes never touch it directly.
//
// Idempotency: `reserve(key)` and `resolve(key, ...)` split claiming a key from recording its
// outcome. `reserve` runs with no `await` before it mutates `pending`, so two requests racing on
// the same key can never both win the reservation — the second always sees the first's entry.
// That in-process lock is what a DB unique constraint on idempotencyKey would give in production;
// this store just does it with a Map instead.

let nextOrderId = 1;
const ordersByKey = new Map(); // idempotencyKey -> order
const pending = new Set(); // idempotencyKeys currently being processed by an in-flight request

function reserve(key) {
  if (ordersByKey.has(key)) {
    return { status: 'already-completed', order: ordersByKey.get(key) };
  }
  if (pending.has(key)) {
    return { status: 'in-flight' };
  }
  pending.add(key);
  return { status: 'reserved' };
}

function release(key) {
  pending.delete(key);
}

function create(key, { customerId, items }) {
  const totalPrice = Math.round(
    items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0) * 100
  ) / 100;

  const order = {
    id: nextOrderId++,
    idempotencyKey: key,
    status: 'CREATED',
    customerId,
    items: items.map((it, i) => ({ id: i + 1, sku: it.sku, quantity: it.quantity, unitPrice: it.unitPrice })),
    totalPrice,
    createdAt: new Date(),
  };

  ordersByKey.set(key, order);
  pending.delete(key);
  return order;
}

function findByKey(key) {
  return ordersByKey.get(key) ?? null;
}

function _reset() {
  nextOrderId = 1;
  ordersByKey.clear();
  pending.clear();
}

module.exports = { reserve, release, create, findByKey, _reset };
