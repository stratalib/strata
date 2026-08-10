'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { MemoryIdempotencyStore, RedisIdempotencyStore } = require('../src/idempotency');

test('MemoryIdempotencyStore: markIfNew is true once, false after', async () => {
  const store = new MemoryIdempotencyStore();
  assert.strictEqual(await store.markIfNew('evt_1'), true);
  assert.strictEqual(await store.markIfNew('evt_1'), false);
  assert.strictEqual(await store.markIfNew('evt_2'), true);
});

test('MemoryIdempotencyStore: expired entries are sweepable', async () => {
  const store = new MemoryIdempotencyStore();
  store.ttlMs = -1; // force immediate expiry
  assert.strictEqual(await store.markIfNew('evt_x'), true);
  // With a negative ttl the entry is already expired, so the next call sweeps
  // it and treats the id as new again.
  assert.strictEqual(await store.markIfNew('evt_x'), true);
});

test('RedisIdempotencyStore: uses SET NX EX and interprets the reply', async () => {
  const calls = [];
  const fakeRedis = {
    async set(...args) {
      calls.push(args);
      // First call: key didn't exist -> 'OK'. Second: exists -> null.
      return calls.length === 1 ? 'OK' : null;
    },
  };
  const store = new RedisIdempotencyStore(fakeRedis);
  assert.strictEqual(await store.markIfNew('evt_1'), true);
  assert.strictEqual(await store.markIfNew('evt_1'), false);

  // Verify the command shape: SET <prefixed key> '1' EX <ttl> NX
  assert.deepStrictEqual(calls[0], ['stripe:evt:evt_1', '1', 'EX', 60 * 60 * 24, 'NX']);
});
