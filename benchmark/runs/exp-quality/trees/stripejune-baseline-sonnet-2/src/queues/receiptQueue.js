const { Queue } = require('bullmq');
const { createRedisConnection } = require('../config/redis');

const QUEUE_NAME = 'receipt-generation';

let queue = null;

// A Queue is just a producer handle -- lazily creating one connection and
// reusing it avoids opening a new Redis connection per webhook request.
function getReceiptQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, { connection: createRedisConnection() });
  }
  return queue;
}

async function enqueueReceiptJob(order) {
  const q = getReceiptQueue();
  return q.add('generate-receipt', order, {
    jobId: order.eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },
    removeOnFail: false,
  });
}

module.exports = { QUEUE_NAME, getReceiptQueue, enqueueReceiptJob };
