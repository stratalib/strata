'use strict';
const { Worker } = require('bullmq');
const { createConnection } = require('./connection');
const { QUEUE_NAME } = require('./receiptQueue');
const { generateReceiptPdf } = require('../lib/receiptPdf');
const { mailer } = require('../lib/mailer');
const orderStore = require('../lib/orderStore');

/**
 * Build and start the receipt worker. Exported as a factory (not started at require-time) so tests
 * can create a worker against an isolated connection/queue name without also starting the one this
 * process would run in production.
 */
function createReceiptWorker(opts) {
  const options = opts || {};
  const concurrency = Number(process.env.RECEIPT_WORKER_CONCURRENCY || 5);

  const worker = new Worker(
    options.queueName || QUEUE_NAME,
    async (job) => {
      const { sessionId, customerEmail, customerName, currency, amountTotal, lineItems } = job.data;

      const pdfBuffer = await generateReceiptPdf({
        receiptNumber: `R-${sessionId.slice(-12).toUpperCase()}`,
        sessionId,
        customerEmail,
        customerName,
        currency,
        amountTotal,
        lineItems,
        createdAt: new Date(),
      });

      const result = await mailer.send({
        to: customerEmail,
        idempotencyKey: `receipt:${sessionId}`,
        subject: 'Your receipt',
        text: `Hi${customerName ? ' ' + customerName : ''},\n\nThank you for your purchase. Your receipt is attached.\n`,
        html: `<p>Hi${customerName ? ' ' + customerName : ''},</p><p>Thank you for your purchase. Your receipt is attached.</p>`,
        attachments: [
          {
            filename: `receipt-${sessionId}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });

      if (!result.ok) {
        // Thrown, not swallowed: this is what tells BullMQ to retry the job under its own backoff.
        // The mailer already retried internally (see lib/mailer.js) before ever returning !ok, so
        // this only fires once mail delivery is truly exhausted.
        throw new Error(`receipt email delivery failed for session ${sessionId}: ${result.error && result.error.message}`);
      }

      orderStore.markReceiptSent(sessionId, null);
      return { emailId: result.id, attempts: result.attempts };
    },
    {
      connection: options.connection || createConnection(),
      concurrency,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[receipt-worker] job ${job && job.id} failed: ${err && err.message}`);
  });
  worker.on('completed', (job) => {
    console.log(`[receipt-worker] job ${job.id} completed`);
  });

  return worker;
}

module.exports = { createReceiptWorker };
