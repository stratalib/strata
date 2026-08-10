'use strict';
const { Worker } = require('bullmq');
const { connection, RECEIPT_QUEUE_NAME } = require('../config/queue');
const { mailer } = require('../config/mailer');
const { renderReceiptPdf } = require('../services/pdfReceipt');
const env = require('../config/env');

async function processReceiptJob(job) {
  const purchase = job.data;
  const pdfBuffer = await renderReceiptPdf(purchase);

  const result = await mailer.send({
    idempotencyKey: `receipt:${purchase.orderId}`,
    to: purchase.email,
    subject: `Your receipt for order ${purchase.orderId}`,
    text:
      `Hi${purchase.customerName ? ' ' + purchase.customerName : ''},\n\n` +
      `Please find your PDF receipt attached for order ${purchase.orderId}.\n\n` +
      `${env.company.name}\n${env.company.supportEmail}`,
    attachments: [
      {
        filename: `receipt-${purchase.orderId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  if (!result.ok) {
    // Throwing hands this back to BullMQ's own retry/backoff (configured on the queue's
    // defaultJobOptions), which is a separate retry layer from the mailer's internal SMTP retries.
    // This one covers "the worker process died" or "SMTP was down for the mailer's whole attempt
    // budget", not transient SMTP hiccups.
    throw new Error(`receipt email delivery failed for order ${purchase.orderId}: ${result.error?.message}`);
  }

  return { emailId: result.id };
}

function startReceiptWorker() {
  const worker = new Worker(RECEIPT_QUEUE_NAME, processReceiptJob, {
    connection,
    concurrency: Number(process.env.RECEIPT_WORKER_CONCURRENCY || 5),
  });

  worker.on('completed', (job) => {
    console.log(`[receipt-worker] sent receipt for order ${job.data.orderId}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[receipt-worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  return worker;
}

module.exports = { startReceiptWorker, processReceiptJob };
