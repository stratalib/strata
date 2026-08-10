'use strict';
const { Worker } = require('bullmq');
const { generateReceipt } = require('./receipt');

function createReceiptWorker(redisConnection, mailer) {
  const worker = new Worker('receipt-generation', async (job) => {
    const { sessionId, email, amount, items } = job.data;

    // Generate the PDF receipt
    const pdfBuffer = await generateReceipt({
      orderId: sessionId,
      date: new Date().toLocaleDateString(),
      email,
      items,
      totalAmount: amount,
    });

    // Send email with attachment
    await mailer.send({
      to: email,
      subject: 'Your Receipt',
      template: 'receipt',
      data: {
        orderId: sessionId,
        amount: (amount / 100).toFixed(2),
      },
      attachments: [
        {
          filename: `receipt-${sessionId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    return { sent: true, sessionId };
  }, { connection: redisConnection });

  worker.on('failed', (job, err) => {
    console.error(`Receipt job ${job.id} failed:`, err.message);
  });

  worker.on('completed', (job) => {
    console.log(`Receipt job ${job.id} completed`);
  });

  return worker;
}

module.exports = { createReceiptWorker };
