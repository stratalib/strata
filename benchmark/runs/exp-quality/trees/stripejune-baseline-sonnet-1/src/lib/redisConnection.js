const IORedis = require('ioredis');
const { config } = require('./config');

function createRedisConnection() {
  return new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
  });
}

module.exports = { createRedisConnection };
