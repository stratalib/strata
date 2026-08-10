'use strict';

class MockRedisClient {
  constructor() {
    this.data = new Map();
    this.connected = true;
  }

  async get(key) {
    return this.data.get(key) || null;
  }

  async set(key, value, options) {
    this.data.set(key, value);
    return 'OK';
  }

  async del(key) {
    return this.data.delete(key) ? 1 : 0;
  }

  async quit() {
    this.connected = false;
  }

  on(event, handler) {
    // noop for testing
  }
}

function createMockRedis() {
  return new MockRedisClient();
}

module.exports = { createMockRedis, MockRedisClient };
