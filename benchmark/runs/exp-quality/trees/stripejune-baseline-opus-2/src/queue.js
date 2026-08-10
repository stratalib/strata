'use strict';

const { Queue } = require('bullmq');
const { createConnection } = require('./redis');

const RECEIPT_QUEUE_NAME = 'receipts';

// Default options applied to every receipt job. Exported so tests can assert on
// them and so both producer and consumer agree on behaviour.
const defaultJobOptions = {
  attempts: 5, // retry a failed PDF/email step a few times before giving up
  backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s, ...
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // keep a day of history
  removeOnFail: false, // keep failed jobs so we can inspect / requeue them
};

let queue;

// Lazily construct the queue so that simply requiring this module (e.g. in a
// unit test for the receipt PDF) doesn't open a Redis connection.
function getReceiptQueue() {
  if (!queue) {
    queue = new Queue(RECEIPT_QUEUE_NAME, {
      connection: createConnection(),
      defaultJobOptions,
    });
  }
  return queue;
}

// Enqueue a receipt job. We key the job by the Stripe event id so that if
// Stripe delivers the same event twice, BullMQ deduplicates it (a job with an
// existing jobId is ignored). This is the second layer of idempotency; the
// webhook handler is the first.
async function enqueueReceipt(payload, jobId) {
  const q = getReceiptQueue();
  return q.add('generate-receipt', payload, { jobId });
}

module.exports = {
  RECEIPT_QUEUE_NAME,
  defaultJobOptions,
  getReceiptQueue,
  enqueueReceipt,
};
