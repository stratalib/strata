const { Worker } = require('bullmq');
const { QUEUE_NAME } = require('../jobs/receiptQueue');
const { createRedisConnection } = require('../lib/redisConnection');
const { getOrder, upsertOrder } = require('../services/orderStore');
const { generateReceiptPdf } = require('../services/receiptPdf');
const { sendReceiptEmail } = require('../services/emailService');
const fs = require('fs');
const path = require('path');
const { config } = require('../lib/config');

async function processReceiptJob(job) {
  const { orderId } = job.data;
  const order = getOrder(orderId);

  if (!order) {
    // Nothing to do — don't retry forever on a job that can never succeed.
    throw new Error(`Unknown order for receipt job: ${orderId}`);
  }

  const pdfBuffer = await generateReceiptPdf(order);

  fs.mkdirSync(config.receiptsDir, { recursive: true });
  const filePath = path.join(config.receiptsDir, `receipt-${order.id}.pdf`);
  fs.writeFileSync(filePath, pdfBuffer);

  await sendReceiptEmail(order, pdfBuffer);

  upsertOrder({ id: order.id, receiptGeneratedAt: new Date().toISOString(), receiptPath: filePath });

  return { orderId: order.id, filePath };
}

function startReceiptWorker() {
  const worker = new Worker(QUEUE_NAME, processReceiptJob, {
    connection: createRedisConnection(),
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    console.log(`[receiptWorker] completed job ${job.id} for order ${job.data.orderId}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[receiptWorker] job ${job?.id} failed for order ${job?.data?.orderId}:`, err.message);
  });

  return worker;
}

if (require.main === module) {
  const worker = startReceiptWorker();
  console.log('[receiptWorker] listening for receipt jobs');

  const shutdown = async () => {
    console.log('[receiptWorker] shutting down...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startReceiptWorker, processReceiptJob };
