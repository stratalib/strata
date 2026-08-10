import 'dotenv/config';
import { Worker } from 'bullmq';
import { generateReceiptPDF } from './lib/receipt-generator.js';
import { sendReceiptEmail } from './lib/email.js';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const redisOptions = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379'),
  password: redisUrl.password || undefined,
  db: redisUrl.pathname ? parseInt(redisUrl.pathname.slice(1)) : 0,
};

const worker = new Worker('receipts', processJob, {
  connection: redisOptions,
  concurrency: 5,
});

async function processJob(job) {
  const { paymentIntentId, email, amount, currency, timestamp } = job.data;

  console.log(`Processing receipt job for ${paymentIntentId}...`);

  try {
    // Generate PDF receipt
    const pdfBuffer = await generateReceiptPDF({
      paymentIntentId,
      amount,
      currency,
      timestamp,
    });

    // Send receipt via email
    const filename = `receipt-${paymentIntentId}.pdf`;
    await sendReceiptEmail({
      email,
      filename,
      pdfBuffer,
    });

    console.log(`Receipt job completed for ${paymentIntentId}`);
    return { success: true, paymentIntentId };
  } catch (err) {
    console.error(`Receipt job failed for ${paymentIntentId}:`, err.message);
    throw err;
  }
}

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed: ${err.message}`);
});

worker.on('error', (err) => {
  console.error('Worker error:', err);
});

console.log('Receipt processing worker started. Listening for jobs...');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
});
