const { Worker } = require('bullmq');
const { createConnection } = require('../lib/redis');
const { QUEUE_NAME } = require('../queues/receiptQueue');
const pdfReceipt = require('../services/pdfReceipt');
const { receiptEmail } = require('../services/emailTemplates');
const mailer = require('../lib/mailer');
const logger = require('../lib/logger');

async function processReceiptJob(job) {
  const { orderId, customerName, customerEmail, amount, currency, paidAt, items } = job.data;

  const pdfBuffer = await pdfReceipt.generateReceiptPdf({
    orderId,
    customerName,
    customerEmail,
    amount,
    currency,
    paidAt,
    items,
  });

  const { subject, text, html } = receiptEmail({ customerName, amount, currency, orderId });

  await mailer.sendMail({
    to: customerEmail,
    subject,
    text,
    html,
    attachments: [
      {
        filename: `receipt-${orderId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  logger.info('Receipt job completed', { orderId, jobId: job.id });
}

function createReceiptWorker() {
  const worker = new Worker(QUEUE_NAME, processReceiptJob, {
    connection: createConnection(),
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id, orderId: job.data.orderId });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job failed', {
      jobId: job && job.id,
      orderId: job && job.data && job.data.orderId,
      attemptsMade: job && job.attemptsMade,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', { error: err.message });
  });

  return worker;
}

module.exports = { createReceiptWorker, processReceiptJob };
