const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_NAME } = require('../queues/receiptQueue');
// Referenced via the module object (not destructured) so tests can
// monkey-patch these functions and have the substitution take effect here.
const receiptPdf = require('../services/receiptPdf');
const emailService = require('../services/emailService');

async function processReceiptJob(job) {
  const order = job.data;

  if (!order.customerEmail) {
    // Should not happen -- the webhook handler skips enqueueing when there's
    // no email -- but a job is a durable record, so guard it defensively too.
    console.warn(`[worker] job ${job.id} has no customer email, skipping`);
    return { skipped: true };
  }

  const pdfBuffer = await receiptPdf.generateReceiptPdf(order);
  await emailService.sendReceiptEmail(order, pdfBuffer);

  return { sent: true };
}

function startReceiptWorker() {
  const worker = new Worker(QUEUE_NAME, processReceiptJob, {
    connection: createRedisConnection(),
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  return worker;
}

if (require.main === module) {
  const worker = startReceiptWorker();

  const shutdown = async () => {
    console.log('[worker] shutting down...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startReceiptWorker, processReceiptJob };
