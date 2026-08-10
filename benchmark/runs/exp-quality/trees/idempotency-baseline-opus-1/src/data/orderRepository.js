'use strict';
// Order data access. Like productRepository, the rest of the app only touches orders through this
// module — routes never reach into the store directly, so the backing store can be swapped later
// (e.g. for a real Prisma-backed table) without rippling outward.
//
// This store also owns idempotency. A client that retries the same order request sends the same
// idempotency key; we key completed orders by it so a retry returns the original order instead of
// creating a second one. In a real database this would be a UNIQUE column on the key; here we get
// the same guarantee from Node's single-threaded execution (see reserveKey below).

let nextId = 1;
const orders = [];

// idempotency key -> { status: 'pending', promise } | { status: 'done', order }
const byKey = new Map();

async function insert(record) {
  const order = {
    id: nextId++,
    status: 'CONFIRMED',
    createdAt: new Date(),
    ...record,
  };
  orders.push(order);
  return order;
}

async function findById(id) {
  return orders.find(o => o.id === id) ?? null;
}

async function findAll() {
  return orders;
}

// Atomically claim an idempotency key for the current request.
//
// This runs entirely synchronously — no awaits between the Map read and the Map write — so in a
// single-threaded Node process no other request can interleave. That makes check-and-reserve atomic
// and closes the race where two concurrent retries both pass the "have I seen this key?" check and
// each create an order.
//
// Returns one of:
//   { outcome: 'reserved', settle }  -> caller owns the key; must call settle(order) or release()
//   { outcome: 'replay', order }     -> key already completed; caller should return this order
//   { outcome: 'inflight', promise } -> another request holds the key; await it for the result
function reserveKey(key) {
  const existing = byKey.get(key);
  if (existing) {
    if (existing.status === 'done') return { outcome: 'replay', order: existing.order };
    return { outcome: 'inflight', promise: existing.promise };
  }

  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // A pending in-flight request never surfaces as an unhandled rejection to any waiter that only
  // arrives after a failure; swallow here and let waiters observe the settled value explicitly.
  promise.catch(() => {});

  byKey.set(key, { status: 'pending', promise });

  const settle = order => {
    byKey.set(key, { status: 'done', order });
    resolveFn(order);
    return order;
  };

  // Release the key on failure so a genuine retry after an error can succeed rather than being
  // permanently wedged behind a dead reservation.
  const release = err => {
    byKey.delete(key);
    rejectFn(err);
  };

  return { outcome: 'reserved', settle, release };
}

module.exports = { insert, findById, findAll, reserveKey };
