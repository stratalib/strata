const { Queue } = require('bullmq');
const { config } = require('../config/env');

const RECEIPT_QUEUE_NAME = 'receipt-generation';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
};

let receiptQueue;

function getReceiptQueue() {
  if (!receiptQueue) {
    receiptQueue = new Queue(RECEIPT_QUEUE_NAME, { connection });
  }
  return receiptQueue;
}

async function enqueueReceiptJob(orderId) {
  const queue = getReceiptQueue();
  return queue.add(
    'generate-receipt',
    { orderId },
    {
      jobId: `receipt-${orderId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 },
    }
  );
}

module.exports = { RECEIPT_QUEUE_NAME, connection, getReceiptQueue, enqueueReceiptJob };
