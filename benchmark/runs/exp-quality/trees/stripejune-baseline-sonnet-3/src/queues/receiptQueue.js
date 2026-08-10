const { Queue } = require('bullmq');
const { createConnection } = require('../lib/redis');

const QUEUE_NAME = 'receipt-generation';

let queue;

// Lazy singleton, same reasoning as the mailer: importing this module shouldn't
// open a Redis connection until something actually needs the queue.
function getReceiptQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: createConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      },
    });
  }
  return queue;
}

async function enqueueReceiptJob(payload) {
  const q = getReceiptQueue();
  // jobId = event/order id makes the enqueue itself idempotent: BullMQ silently
  // no-ops if a job with this id already exists, so a duplicate webhook delivery
  // can't queue the same receipt twice.
  return q.add('generate-receipt', payload, { jobId: payload.orderId });
}

module.exports = { QUEUE_NAME, getReceiptQueue, enqueueReceiptJob };
