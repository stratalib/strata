const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { config } = require('../config/env');
const { RECEIPT_QUEUE_NAME, connection } = require('../jobs/queue');
const orders = require('../db/orders');
const { generateReceiptPdf } = require('../services/receiptPdf');
const { sendReceiptEmail } = require('../services/mailer');

const receiptsDir = path.resolve(config.receipts.dir);
fs.mkdirSync(receiptsDir, { recursive: true });

async function processReceiptJob(job) {
  const { orderId } = job.data;
  const order = orders.getById(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found; cannot generate receipt`);
  }

  const pdfBuffer = await generateReceiptPdf(order);
  const fileName = `receipt-${order.id}.pdf`;
  fs.writeFileSync(path.join(receiptsDir, fileName), pdfBuffer);

  await sendReceiptEmail(order, pdfBuffer, fileName);
  orders.markReceiptSent(order.id);

  return { orderId: order.id, fileName };
}

function startReceiptWorker() {
  const worker = new Worker(RECEIPT_QUEUE_NAME, processReceiptJob, {
    connection,
    concurrency: 5,
  });

  worker.on('completed', (job, result) => {
    console.log(`[receipt-worker] job ${job.id} completed`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[receipt-worker] job ${job && job.id} failed:`, err.message);
  });

  return worker;
}

if (require.main === module) {
  const worker = startReceiptWorker();
  console.log('[receipt-worker] listening for jobs on', RECEIPT_QUEUE_NAME);

  const shutdown = async () => {
    console.log('[receipt-worker] shutting down...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startReceiptWorker, processReceiptJob };
