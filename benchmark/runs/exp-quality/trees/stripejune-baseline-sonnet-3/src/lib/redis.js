const IORedis = require('ioredis');
const { env } = require('../config/env');
const logger = require('./logger');

// BullMQ requires this to be null on any connection it manages (blocking commands
// would otherwise get retried by ioredis in a way that breaks BullMQ's own retry logic).
function createConnection() {
  const connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    // Cap backoff at 5s instead of ioredis's default unbounded growth, so a real
    // outage keeps retrying at a steady, log-friendly interval instead of drifting
    // toward multi-minute gaps.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  let lastErrorLoggedAt = 0;
  connection.on('error', (err) => {
    // ioredis emits 'error' on every failed reconnect attempt; throttle logging
    // to once per 10s per connection so an outage doesn't flood the log.
    const now = Date.now();
    if (now - lastErrorLoggedAt > 10000) {
      logger.error('Redis connection error', { error: err.message });
      lastErrorLoggedAt = now;
    }
  });

  return connection;
}

module.exports = { createConnection };
