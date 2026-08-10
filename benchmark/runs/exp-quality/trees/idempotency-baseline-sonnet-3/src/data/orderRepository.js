'use strict';
// Order data access. Same shape as productRepository.js: routes never touch the store directly.
//
// Idempotency: orders are deduplicated on `idempotencyKey`. The key -> order mapping is kept in a
// separate index so a retry with the same key returns the original order instead of inserting a new
// row, even if the two requests race each other (see insertIfAbsent).

let nextId = 1;
const rows = [];
const byIdempotencyKey = new Map(); // idempotencyKey -> order

async function findAll() {
  return rows;
}

async function findById(id) {
  return rows.find(r => r.id === id) ?? null;
}

async function findByIdempotencyKey(key) {
  return byIdempotencyKey.get(key) ?? null;
}

// Inserts a new order unless one already exists for this idempotencyKey, in which case the existing
// order is returned instead and `created` is false. The check-then-insert happens synchronously
// (no `await` in between), so two "concurrent" requests in Node's single-threaded event loop can't
// interleave between the lookup and the write — that's what makes this race-safe without a DB-level
// unique constraint.
async function insertIfAbsent(key, data) {
  const existing = byIdempotencyKey.get(key);
  if (existing) {
    return { order: existing, created: false };
  }

  const row = {
    id: nextId++,
    idempotencyKey: key,
    status: 'CREATED',
    createdAt: new Date(),
    ...data,
  };
  rows.push(row);
  byIdempotencyKey.set(key, row);
  return { order: row, created: true };
}

module.exports = { findAll, findById, findByIdempotencyKey, insertIfAbsent };
