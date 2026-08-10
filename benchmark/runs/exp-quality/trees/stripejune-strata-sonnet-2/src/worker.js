'use strict';

require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisConnection } = require('./redis');
const { getMailer } = require('./mailer');
const { generateReceiptPdf } = require('./receiptPdf');
const { RECEIPT_QUEUE_NAME } = require('./queue');

/** @param {import('bullmq').Job} job */
async function processReceiptJob(job) {
  const { eventId, receiptNumber, purchasedAt, customerName, customerEmail, currency,
    lineItems, totalAmount, paymentMethodLabel } = job.data;

  const pdfBuffer = await generateReceiptPdf({
    receiptNumber,
    purchasedAt: new Date(purchasedAt),
    customerName,
    customerEmail,
    currency,
    lineItems,
    totalAmount,
    paymentMethodLabel,
  });

  const mailer = getMailer();
  const result = await mailer.send({
    // Same key every retry of the same job: a job that succeeds at sending but crashes before
    // BullMQ records completion gets re-run, and this stops the re-run from emailing twice.
    idempotencyKey: `receipt-email:${eventId}`,
    to: customerEmail,
    subject: `Your receipt — #${receiptNumber}`,
    text: `Hi${customerName ? ' ' + customerName : ''},\n\n`
      + `Thanks for your purchase. Your receipt (#${receiptNumber}) is attached as a PDF.\n\n`
      + `If you have any questions, just reply to this email.`,
    attachments: [
      {
        filename: `receipt-${receiptNumber}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  if (!result.ok) {
    // Throwing fails the BullMQ job so it retries per the queue's backoff policy — the mailer
    // already retried internally, so this only fires once that's been exhausted too.
    throw new Error(`receipt email delivery failed: ${result.error && result.error.message}`);
  }

  return { mailId: result.id, attempts: result.attempts };
}

function startReceiptWorker() {
  const worker = new Worker(RECEIPT_QUEUE_NAME, processReceiptJob, {
    connection: getRedisConnection(),
    concurrency: Number(process.env.RECEIPT_WORKER_CONCURRENCY || 5),
  });

  worker.on('completed', (job) => {
    console.log(`[receipt-worker] sent receipt for event ${job.data.eventId} (job ${job.id})`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[receipt-worker] job ${job && job.id} failed: ${err && err.message}`);
  });

  return worker;
}

if (require.main === module) {
  const worker = startReceiptWorker();
  console.log('[receipt-worker] listening for jobs on queue "receipts"');

  const shutdown = async () => {
    console.log('[receipt-worker] shutting down...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { startReceiptWorker, processReceiptJob };
