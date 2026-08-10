'use strict';
const { Queue, Worker } = require('bullmq');
const PDFDocument = require('pdfkit');

function createReceiptQueue(opts) {
  const {
    redis,
    mailer,
    onReceipt = async () => {},
  } = opts;

  // Check if Redis is available; fall back to in-memory queue for testing
  const isInMemory = !redis || !redis.isOpen;
  let queue = null;
  let worker = null;

  const processReceipt = async (job) => {
    const { sessionId, email, amount, description } = job.data;

    // Generate PDF in memory
    const pdf = new PDFDocument();
    const chunks = [];

    pdf.on('data', (chunk) => chunks.push(chunk));

    pdf.fontSize(20).text('Receipt', { align: 'center' });
    pdf.fontSize(12).text(`\nOrder ID: ${sessionId}`, { align: 'left' });
    pdf.text(`Email: ${email}`, { align: 'left' });
    pdf.text(`Amount: $${(amount / 100).toFixed(2)}`, { align: 'left' });
    if (description) {
      pdf.text(`Description: ${description}`, { align: 'left' });
    }
    pdf.text(`\nDate: ${new Date().toISOString().split('T')[0]}`, { align: 'left' });
    pdf.end();

    return new Promise((resolve, reject) => {
      pdf.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);

        try {
          await mailer.send({
            to: email,
            subject: `Receipt for order ${sessionId}`,
            text: `Your receipt for ${description || 'your purchase'} is attached.`,
            html: `<p>Your receipt for <strong>${description || 'your purchase'}</strong> is attached.</p>`,
            attachments: [
              {
                filename: `receipt-${sessionId}.pdf`,
                content: pdfBuffer,
              },
            ],
          });

          await onReceipt({ sessionId, email, success: true });
          resolve();
        } catch (err) {
          await onReceipt({ sessionId, email, success: false, error: err.message });
          throw err;
        }
      });

      pdf.on('error', reject);
    });
  };

  if (isInMemory) {
    // In-memory queue for testing when Redis is unavailable
    const jobs = {};
    queue = {
      add: async (name, data, opts) => {
        const jobId = 'job-' + Math.random().toString(36).slice(2);
        const job = { id: jobId, data, opts };
        jobs[jobId] = job;
        // Process immediately in-memory
        processReceipt(job).catch(err => {
          console.error(`[receipt-queue] job ${jobId} failed:`, err.message);
        });
        return job;
      },
      close: async () => {},
    };
  } else {
    // Real BullMQ queue backed by Redis
    queue = new Queue('receipts', { connection: redis });
    worker = new Worker('receipts', processReceipt, { connection: redis });

    worker.on('failed', (job, err) => {
      console.error(`[receipt-queue] job ${job.id} failed:`, err.message);
    });

    worker.on('completed', (job) => {
      console.log(`[receipt-queue] job ${job.id} completed`);
    });
  }

  return {
    queue,
    worker,
    addReceipt: async (sessionId, email, amount, description) => {
      return queue.add('receipt', { sessionId, email, amount, description }, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });
    },
    close: async () => {
      if (worker) await worker.close();
      if (queue) await queue.close();
    },
  };
}

module.exports = { createReceiptQueue };
