'use strict';
const { Queue, Worker } = require('bullmq');
const redis = require('redis');
const { generateReceipt } = require('./receipt-generator');

// Create Redis client for BullMQ. Used for both enqueueing jobs and worker processing.
function createRedisClient(opts = {}) {
  return redis.createClient({
    socket: {
      host: opts.host || process.env.REDIS_HOST || 'localhost',
      port: opts.port || Number(process.env.REDIS_PORT || 6379),
    },
    database: opts.db || Number(process.env.REDIS_DB || 0),
    ...opts,
  });
}

// Initialize the receipt generation queue. Callers will use queue.add() to enqueue jobs.
function createReceiptQueue(opts = {}) {
  const connection = opts.connection || createRedisClient(opts);
  return new Queue('receipts', { connection });
}

// Start a worker that processes receipt jobs. Calls the mailer to send the PDF attachment.
async function startReceiptWorker(mailer, opts = {}) {
  const connection = opts.connection || createRedisClient(opts);

  const worker = new Worker(
    'receipts',
    async (job) => {
      const { sessionId, email, orderData } = job.data;

      // Generate the PDF in memory
      const pdfBuffer = await generateReceipt({
        orderNumber: sessionId.slice(0, 8).toUpperCase(),
        email,
        amount: orderData.amount,
        currency: orderData.currency,
        items: orderData.items || [],
        timestamp: Date.now(),
      });

      // Send email with PDF attachment
      const result = await mailer.send({
        to: email,
        subject: `Receipt for Order #${sessionId.slice(0, 8).toUpperCase()}`,
        html: `<p>Thank you for your purchase!</p><p>Your receipt is attached.</p>`,
        attachments: [
          {
            filename: `receipt-${sessionId}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });

      if (!result.ok) {
        throw new Error(`Failed to send receipt email: ${result.error?.message || 'unknown error'}`);
      }

      return { success: true, sessionId };
    },
    {
      connection,
      // Process one job at a time. Increase for parallel processing.
      concurrency: 1,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[receipt-worker] completed job ${job.id}: ${job.data.sessionId}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[receipt-worker] failed job ${job.id}: ${err.message}`);
  });

  return worker;
}

module.exports = {
  createRedisClient,
  createReceiptQueue,
  startReceiptWorker,
};
