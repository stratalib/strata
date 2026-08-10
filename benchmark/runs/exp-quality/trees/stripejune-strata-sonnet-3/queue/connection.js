'use strict';
const IORedis = require('ioredis');

// BullMQ requires maxRetriesPerRequest: null on the connection it's handed — with a finite retry
// count ioredis gives up on blocking commands (BRPOPLPUSH etc.) that BullMQ relies on to wait for
// jobs, and the worker starts throwing instead of blocking. This is a BullMQ-documented requirement,
// not a style choice.
function createConnection() {
  return new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
}

module.exports = { createConnection };
