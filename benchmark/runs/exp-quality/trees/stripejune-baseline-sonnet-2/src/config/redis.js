const IORedis = require('ioredis');
const { env } = require('./env');

function createRedisConnection() {
  return new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
  });
}

module.exports = { createRedisConnection };
