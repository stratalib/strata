'use strict';
// Order data access. Like productRepository, the rest of the app only touches orders through this
// module — routes never reach into the store directly (see README). This keeps the in-memory store
// swappable for a real Prisma-backed store later without changing any route code.

let nextId = 1;
const orders = [];

// Idempotency records, keyed by the client-supplied Idempotency-Key. Each value remembers the
// outcome of the FIRST request that used that key so a retry can replay the exact same response
// instead of creating a second order. A Map (not an array) because we look records up by key on
// every write request — an array would scan every entry each time.
const idempotency = new Map();

async function insert(record) {
  const row = {
    id: nextId++,
    status: 'CONFIRMED',
    createdAt: new Date(),
    ...record,
  };
  orders.push(row);
  return row;
}

async function findById(id) {
  return orders.find(o => o.id === id) ?? null;
}

async function findAll() {
  return orders.slice();
}

// --- Idempotency bookkeeping -------------------------------------------------

// A record moves through two states:
//   { status: 'in-progress' }                    — a request with this key is being processed now
//   { status: 'done', statusCode, body }         — the first request finished; replay this response
//
// beginKey atomically claims a key. Because Node runs one request's synchronous code to completion
// before the next, checking-then-setting the Map here has no gap for a concurrent request to slip
// through — that's what makes this a safe "claim". It returns the existing record if the key was
// already seen, or null if this caller is the first to claim it.
function beginKey(key) {
  const existing = idempotency.get(key);
  if (existing) return existing;
  const record = { status: 'in-progress' };
  idempotency.set(key, record);
  return null;
}

function completeKey(key, statusCode, body) {
  idempotency.set(key, { status: 'done', statusCode, body });
}

// If processing fails, drop the in-progress claim so the client can legitimately retry the same key.
// We only release keys that are still in-progress — never a completed one, or a retry could sneak
// past the replay and create a duplicate.
function releaseKey(key) {
  const existing = idempotency.get(key);
  if (existing && existing.status === 'in-progress') idempotency.delete(key);
}

// Test/maintenance hook: wipe all state so each test starts clean.
function _reset() {
  nextId = 1;
  orders.length = 0;
  idempotency.clear();
}

module.exports = {
  insert,
  findById,
  findAll,
  beginKey,
  completeKey,
  releaseKey,
  _reset,
};
