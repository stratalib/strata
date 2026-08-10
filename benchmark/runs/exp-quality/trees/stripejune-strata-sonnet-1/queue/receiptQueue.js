'use strict';
const { Queue } = require('bullmq');
const { connection, RECEIPT_QUEUE_NAME } = require('../config/queue');

const receiptQueue = new Queue(RECEIPT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    // Bounded history, same reasoning as the mailer's outbox: an unbounded completed/failed list is a
    // slow memory leak in Redis that only shows up after weeks of uptime.
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

/**
 * @param {{orderId: string, email: string, customerName?: string, amount: number, currency: string,
 *   items?: Array<{description: string, amount: number}>, purchasedAt: string}} payload
 */
async function enqueueReceipt(payload) {
  // Job id = order id -> BullMQ deduplicates automatically if the same order is enqueued twice
  // (e.g. a Stripe webhook redelivery that slipped past the event-log dedupe some other way).
  return receiptQueue.add('generate-receipt', payload, { jobId: `receipt:${payload.orderId}` });
}

module.exports = { receiptQueue, enqueueReceipt };
