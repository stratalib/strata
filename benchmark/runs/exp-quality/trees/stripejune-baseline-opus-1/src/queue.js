'use strict';

const { Queue } = require('bullmq');
const { config } = require('./config');

// BullMQ needs a Redis connection. `maxRetriesPerRequest: null` is required by
// BullMQ for its blocking commands.
const connection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
};

const RECEIPT_QUEUE = 'receipts';

// Lazily create the Queue so simply requiring this module (e.g. in a unit test
// that never enqueues) does not open a Redis connection.
let receiptQueue = null;

function getReceiptQueue() {
  if (!receiptQueue) {
    receiptQueue = new Queue(RECEIPT_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retry the whole PDF-generate-and-email job a few times with
        // exponential backoff before giving up — SMTP hiccups are transient.
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }
  return receiptQueue;
}

// Enqueue a receipt job. We key the job by order id so a duplicate enqueue for
// the same order collapses to one job (belt-and-suspenders alongside webhook
// idempotency).
async function enqueueReceiptJob(order) {
  const queue = getReceiptQueue();
  return queue.add(
    'generate-receipt',
    { orderId: order.id },
    { jobId: `receipt:${order.id}` }
  );
}

async function closeQueue() {
  if (receiptQueue) {
    await receiptQueue.close();
    receiptQueue = null;
  }
}

module.exports = {
  connection,
  RECEIPT_QUEUE,
  getReceiptQueue,
  enqueueReceiptJob,
  closeQueue,
};
