import { Worker, Queue } from 'bullmq';
import { getRedisClient } from '../config/redis.js';
import { generateReceiptPDF } from '../services/receiptService.js';
import { sendReceiptPDF } from '../services/emailService.js';

const RECEIPT_QUEUE_NAME = 'receipt-generation';

export async function createReceiptQueue() {
  const redis = await getRedisClient();
  const queue = new Queue(RECEIPT_QUEUE_NAME, { connection: redis });
  return queue;
}

export async function enqueueReceiptJob(paymentData) {
  const queue = await createReceiptQueue();
  const job = await queue.add('generate-receipt', paymentData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
  });
  return job;
}

export async function startReceiptWorker() {
  const redis = await getRedisClient();

  const worker = new Worker(RECEIPT_QUEUE_NAME, async (job) => {
    const { customerEmail, ...paymentData } = job.data;

    try {
      console.log(`Generating receipt for payment ${paymentData.paymentId}`);
      const pdfBuffer = await generateReceiptPDF(paymentData);

      console.log(`Sending receipt to ${customerEmail}`);
      await sendReceiptPDF(customerEmail, `receipt-${paymentData.paymentId}.pdf`, pdfBuffer);

      console.log(`Receipt sent successfully for ${paymentData.paymentId}`);
    } catch (error) {
      console.error(`Failed to process receipt job for ${paymentData.paymentId}:`, error);
      throw error;
    }
  }, { connection: redis });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed: ${err.message}`);
  });

  return worker;
}
