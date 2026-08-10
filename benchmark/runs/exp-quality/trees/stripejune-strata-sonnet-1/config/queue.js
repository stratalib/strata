'use strict';
const env = require('./env');

// BullMQ requires this exact option on the ioredis connection it opens internally — without it,
// BullMQ's blocking commands (used by the worker to wait for jobs) throw immediately.
const connection = {
  url: env.redis.url,
  maxRetriesPerRequest: null,
};

const RECEIPT_QUEUE_NAME = 'receipts';

module.exports = { connection, RECEIPT_QUEUE_NAME };
