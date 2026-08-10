'use strict';

// Tracks which Stripe event ids we've already handled so a redelivered event
// doesn't trigger a second confirmation email / receipt.
//
// Two implementations:
//   - RedisIdempotencyStore: correct across multiple web instances, because the
//     record lives in shared Redis. This is what you want in production.
//   - MemoryIdempotencyStore: fine for a single instance, tests, and local dev.
//
// Both use "mark and check" semantics via markIfNew(): it atomically records the
// id and returns true only the first time. That avoids a check-then-set race
// where two concurrent redeliveries both read "not seen" and both proceed.

class MemoryIdempotencyStore {
  constructor() {
    this.seen = new Map(); // id -> expiry timestamp (ms)
    this.ttlMs = 1000 * 60 * 60 * 24; // 24h, matching Stripe's retry window
  }

  async markIfNew(id) {
    this._sweep();
    if (this.seen.has(id)) return false;
    this.seen.set(id, Date.now() + this.ttlMs);
    return true;
  }

  _sweep() {
    const now = Date.now();
    for (const [id, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(id);
    }
  }
}

class RedisIdempotencyStore {
  constructor(connection) {
    this.redis = connection;
    this.ttlSeconds = 60 * 60 * 24; // 24h
    this.prefix = 'stripe:evt:';
  }

  async markIfNew(id) {
    // SET key value NX EX ttl -> returns 'OK' if the key was set (i.e. first
    // time we've seen this event), null if it already existed. One round trip,
    // atomic, no race.
    const res = await this.redis.set(this.prefix + id, '1', 'EX', this.ttlSeconds, 'NX');
    return res === 'OK';
  }
}

module.exports = { MemoryIdempotencyStore, RedisIdempotencyStore };
