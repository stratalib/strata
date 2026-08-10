'use strict';

const IORedis = require('ioredis');

// BullMQ requires this exact option — without it, ioredis gives up retrying after its default
// attempt limit and BullMQ's blocking commands (used to wait for jobs) throw instead of reconnecting.
let connection = null;

function getRedisConnection() {
  if (connection) return connection;
  connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  return connection;
}

module.exports = { getRedisConnection };
