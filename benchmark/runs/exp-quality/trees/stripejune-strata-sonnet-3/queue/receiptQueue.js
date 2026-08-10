'use strict';
const { Queue } = require('bullmq');
const { createConnection } = require('./connection');

const QUEUE_NAME = 'receipt-generation';

let queue;
function getReceiptQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: createConnection(),
      defaultJobOptions: {
        attempts: 5,
        // Exponential backoff: SMTP/Stripe hiccups are transient, and a fixed retry delay either
        // hammers a struggling downstream (too short) or leaves customers waiting an hour for a
        // receipt on a blip that resolved in seconds (too long).
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

/**
 * Enqueue receipt generation for a completed checkout session.
 * jobId = sessionId makes this idempotent at the queue level: BullMQ refuses to add a second job
 * with the same id while one exists, so a Stripe redelivery that slips past the webhook's own
 * dedupe (or a manual retry) still can't queue the same receipt twice.
 */
async function enqueueReceipt(payload) {
  const q = getReceiptQueue();
  return q.add(QUEUE_NAME, payload, { jobId: payload.sessionId });
}

module.exports = { QUEUE_NAME, getReceiptQueue, enqueueReceipt };
