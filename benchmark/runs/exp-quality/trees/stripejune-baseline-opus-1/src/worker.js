'use strict';

const { Worker } = require('bullmq');
const { connection, RECEIPT_QUEUE } = require('./queue');
const store = require('./store');
const mailer = require('./mailer');
const { generateReceiptPdf } = require('./receipt');

// The receipt worker. Runs as its OWN process (`npm run worker`), pulling jobs
// from Redis. This is where the slow work lives — generating a PDF and sending
// the receipt email — kept off the webhook's request path.

// Exported so it can be unit-tested directly with a fake job, without Redis.
async function processReceiptJob(job) {
  const { orderId } = job.data;
  const order = store.getOrder(orderId);

  // Defensive: if the order isn't in the store (e.g. worker restarted with an
  // in-memory store, or job data is stale) there's nothing we can do. Throwing
  // would just burn retries, so we log and treat it as a no-op success.
  if (!order) {
    console.warn(`Receipt job ${job.id}: order ${orderId} not found; skipping.`);
    return { skipped: true, reason: 'order_not_found' };
  }

  const pdf = await generateReceiptPdf(order);
  await mailer.sendReceiptEmail(order, pdf);
  return { sent: true, orderId };
}

function startWorker() {
  const worker = new Worker(RECEIPT_QUEUE, processReceiptJob, {
    connection,
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    console.log(`Receipt job ${job.id} completed.`);
  });
  worker.on('failed', (job, err) => {
    console.error(`Receipt job ${job && job.id} failed:`, err.message);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, closing worker...`);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('Receipt worker started.');
  return worker;
}

// Only auto-start when run directly (node src/worker.js), not when required by
// a test.
if (require.main === module) {
  startWorker();
}

module.exports = { processReceiptJob, startWorker };
