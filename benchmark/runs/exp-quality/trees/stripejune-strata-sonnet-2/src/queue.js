'use strict';

const { Queue } = require('bullmq');
const { getRedisConnection } = require('./redis');

const RECEIPT_QUEUE_NAME = 'receipts';

let receiptQueue = null;

function getReceiptQueue() {
  if (receiptQueue) return receiptQueue;
  receiptQueue = new Queue(RECEIPT_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
      // Failed jobs stick around so a human can inspect/retry rather than silently vanishing —
      // this queue emails customers a legal-ish document, so a lost job is a support ticket.
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  return receiptQueue;
}

/** One job per Stripe event id: if the webhook handler is ever invoked twice for the same
 *  event, BullMQ refuses the duplicate job id instead of emailing the receipt twice. */
async function enqueueReceiptJob(payload) {
  const queue = getReceiptQueue();
  return queue.add('generate-and-send-receipt', payload, {
    jobId: `receipt:${payload.eventId}`,
  });
}

module.exports = { RECEIPT_QUEUE_NAME, getReceiptQueue, enqueueReceiptJob };
