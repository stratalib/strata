import { Queue, Worker } from 'bullmq';
import { Redis } from 'redis';
import { generateReceiptPDF } from './pdf-generator.js';
import { sendReceiptEmail } from '../services/email.js';
import { getOrderStore } from '../storage/order-store.js';

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  db: parseInt(process.env.REDIS_DB || '0'),
};

let receiptQueue;
let receiptWorker;

export function initializeReceiptQueue() {
  if (receiptQueue) return receiptQueue;

  receiptQueue = new Queue('receipts', { connection: redisConfig });
  console.log('Receipt queue initialized');

  // Set up worker to process receipt generation jobs
  receiptWorker = new Worker(
    'receipts',
    async (job) => {
      console.log(`Processing receipt generation for order ${job.data.orderId}`);
      const pdfPath = await generateReceiptPDF(job.data);
      return { pdfPath, orderId: job.data.orderId };
    },
    { connection: redisConfig }
  );

  receiptWorker.on('completed', async (job, result) => {
    try {
      const orderStore = getOrderStore();
      const order = await orderStore.get(job.data.orderId);
      order.receiptUrl = result.pdfPath;
      await orderStore.save(order);

      await sendReceiptEmail({
        email: job.data.customerEmail,
        name: job.data.customerName,
        orderId: job.data.orderId,
        pdfPath: result.pdfPath,
      });

      console.log(`Receipt completed for order ${job.data.orderId}`);
    } catch (error) {
      console.error(`Failed to complete receipt job: ${error.message}`);
    }
  });

  receiptWorker.on('failed', (job, err) => {
    console.error(`Receipt job failed for order ${job.data.orderId}: ${err.message}`);
  });

  return receiptQueue;
}

export async function queueReceiptGeneration(order) {
  const queue = initializeReceiptQueue();
  await queue.add('generate', order, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
  });
}

export async function closeQueue() {
  if (receiptWorker) await receiptWorker.close();
  if (receiptQueue) await receiptQueue.close();
}
