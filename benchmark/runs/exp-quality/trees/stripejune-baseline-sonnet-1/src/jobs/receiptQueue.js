const { Queue } = require('bullmq');
const { createRedisConnection } = require('../lib/redisConnection');

const QUEUE_NAME = 'receipt-generation';

let queue;

function getReceiptQueue() {
  if (queue) return queue;
  queue = new Queue(QUEUE_NAME, { connection: createRedisConnection() });
  return queue;
}

async function enqueueReceiptJob(orderId) {
  const q = getReceiptQueue();
  return q.add(
    'generate-receipt',
    { orderId },
    {
      jobId: `receipt-${orderId}`, // dedupe: re-delivered Stripe events won't double-enqueue
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    }
  );
}

module.exports = { QUEUE_NAME, getReceiptQueue, enqueueReceiptJob };
