'use strict';

const { Queue } = require('bullmq');
const { createConnection } = require('../lib/redis');
const logger = require('../lib/logger');

/**
 * The receipt queue. A "job" here is: generate the PDF receipt and email it.
 * We keep the Queue (producer) separate from the Worker (consumer, in
 * worker.js) so the web process can enqueue without also running job handlers.
 */

const RECEIPT_QUEUE_NAME = 'receipts';
const RECEIPT_JOB = 'generate-and-send-receipt';

let queue = null;

function getQueue() {
  if (queue) return queue;
  queue = new Queue(RECEIPT_QUEUE_NAME, {
    connection: createConnection(),
    defaultJobOptions: {
      // Retry transient failures (SMTP hiccup, Redis blip) with backoff.
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      // Keep the queue from growing unbounded; keep a window for debugging.
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return queue;
}

/**
 * Enqueue a receipt job. `dedupeId` (Stripe's event id) becomes the BullMQ
 * jobId — BullMQ refuses to create a second job with an id that already exists,
 * so a redelivered Stripe webhook can't produce a duplicate receipt. This is
 * our idempotency guarantee and it lives at the enqueue boundary on purpose.
 */
async function enqueueReceiptJob(data, dedupeId) {
  const job = await getQueue().add(RECEIPT_JOB, data, {
    jobId: dedupeId,
  });
  logger.info('receipt job enqueued', { jobId: job.id, orderId: data.orderId });
  return job;
}

module.exports = {
  RECEIPT_QUEUE_NAME,
  RECEIPT_JOB,
  getQueue,
  enqueueReceiptJob,
};
