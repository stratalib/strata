'use strict';

const IORedis = require('ioredis');
const config = require('../config');

/**
 * Shared ioredis connection factory for BullMQ.
 *
 * BullMQ opens blocking connections (BRPOPLPUSH etc.). ioredis will throw on a
 * blocking command unless `maxRetriesPerRequest` is null, which is why config
 * pins it to null. We hand BullMQ a *factory* rather than a single shared
 * client because BullMQ's Queue and Worker each want their own connection and
 * will duplicate/manage lifecycle themselves.
 */
function createConnection() {
  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
  });
}

module.exports = { createConnection };
