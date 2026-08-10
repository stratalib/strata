'use strict';

const { Worker } = require('bullmq');
const { createConnection } = require('./redis');
const { RECEIPT_QUEUE_NAME } = require('./queue');
const { generateReceiptPdf } = require('./receipt');
const { sendReceiptEmail } = require('./mailer');

// The job processor: turn an order into a PDF and email it. Exported on its own
// so it can be unit-tested without spinning up a real BullMQ worker or Redis.
async function processReceiptJob(job) {
  const order = job.data;
  const pdf = await generateReceiptPdf(order);
  await sendReceiptEmail(order, pdf);
  return { emailedTo: order.customerEmail, bytes: pdf.length };
}

function startWorker() {
  const worker = new Worker(RECEIPT_QUEUE_NAME, processReceiptJob, {
    connection: createConnection(),
    concurrency: 5, // process a handful of receipts at once
  });

  worker.on('completed', (job, result) => {
    // eslint-disable-next-line no-console
    console.log(`Receipt job ${job.id} done: emailed ${result.emailedTo} (${result.bytes} bytes)`);
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`Receipt job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });

  // eslint-disable-next-line no-console
  console.log(`Receipt worker started, listening on queue "${RECEIPT_QUEUE_NAME}"`);
  return worker;
}

if (require.main === module) {
  startWorker();
}

module.exports = { processReceiptJob, startWorker };
