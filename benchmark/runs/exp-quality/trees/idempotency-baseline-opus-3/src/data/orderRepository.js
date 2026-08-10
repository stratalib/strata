'use strict';
// Order data access. Like productRepository, the rest of the app only ever touches orders through this
// module — routes never reach into the store directly, so the backing store can be swapped without
// rippling outward.
//
// Idempotency: a client that retries the same order (same idempotency key) must NOT get a second order.
// We keep a Map from idempotency key -> orderId. On a repeat key we return the original order instead of
// creating a new one. A Map (not an array) because we look up by key on every order request, and an
// array would rescan every past order each time.

let nextId = 1;
const orders = [];

// key -> { orderId, requestFingerprint }. Reserving a key is synchronous and atomic within a single
// create call, which closes the window where two near-simultaneous retries could both slip through
// before either has finished writing.
const idempotencyKeys = new Map();

function totalCents(items) {
  // Money in integer cents so we never accumulate floating-point drift across line items.
  return items.reduce((sum, it) => sum + Math.round(it.unitPriceCents) * it.quantity, 0);
}

// A stable string describing the "meaningful" content of an order request, so we can detect the abuse
// case where the same idempotency key is reused for a genuinely different order.
function fingerprint(order) {
  const items = order.items
    .map(it => `${it.sku}:${it.quantity}:${it.unitPriceCents}`)
    .sort()
    .join('|');
  return `${order.customerId}#${items}`;
}

function findById(id) {
  return orders.find(o => o.id === id) ?? null;
}

function findByIdempotencyKey(key) {
  const entry = idempotencyKeys.get(key);
  if (!entry) return null;
  return findById(entry.orderId);
}

// Returns { order, created }. `created` is false when an existing order was returned for a repeat key.
// Throws an Error with code 'IDEMPOTENCY_KEY_REUSED' if the same key is sent with a different body.
function create({ customerId, items, idempotencyKey }) {
  const draft = { customerId, items };
  const fp = fingerprint(draft);

  if (idempotencyKey) {
    const existing = idempotencyKeys.get(idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fp) {
        const err = new Error('Idempotency key reused with a different request body');
        err.code = 'IDEMPOTENCY_KEY_REUSED';
        throw err;
      }
      return { order: findById(existing.orderId), created: false };
    }
  }

  const now = new Date();
  const order = {
    id: nextId++,
    customerId,
    items: items.map(it => ({ ...it })),
    totalCents: totalCents(items),
    status: 'CONFIRMED',
    idempotencyKey: idempotencyKey ?? null,
    createdAt: now,
    updatedAt: now,
  };
  orders.push(order);

  // Reserve the key only after the order exists, but synchronously in this same tick — no await between
  // the get() above and this set(), so concurrent retries can't both create.
  if (idempotencyKey) {
    idempotencyKeys.set(idempotencyKey, { orderId: order.id, requestFingerprint: fp });
  }

  return { order, created: true };
}

// Test/support helper — lets tests start from a clean slate.
function _reset() {
  nextId = 1;
  orders.length = 0;
  idempotencyKeys.clear();
}

module.exports = { create, findById, findByIdempotencyKey, _reset };
