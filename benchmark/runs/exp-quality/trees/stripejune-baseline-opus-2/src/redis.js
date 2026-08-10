'use strict';

const IORedis = require('ioredis');
const { config } = require('./config');

// A single shared Redis connection factory. BullMQ needs blocking commands
// (BRPOPLPUSH etc.), and ioredis by default gives up on a command after a few
// retries — which breaks those blocking calls. `maxRetriesPerRequest: null`
// tells ioredis to keep the command pending across reconnects, which is exactly
// what BullMQ requires. This is documented, not folklore.
function createConnection() {
  const opts = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };

  if (config.redis.url) {
    return new IORedis(config.redis.url, opts);
  }

  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    ...opts,
  });
}

module.exports = { createConnection };
