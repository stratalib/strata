import { Queue } from 'bullmq';
import { createClient } from 'redis';

// Parse Redis URL from environment
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const redisOptions = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379'),
  password: redisUrl.password || undefined,
  db: redisUrl.pathname ? parseInt(redisUrl.pathname.slice(1)) : 0,
};

let connection;
try {
  connection = createClient(redisOptions);
  await connection.connect();
} catch (err) {
  console.warn('Redis connection failed (queue will retry):', err.message);
}

export const receiptQueue = new Queue('receipts', {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

receiptQueue.on('error', (err) => {
  if (
    err.code === 'ECONNREFUSED' ||
    err.message.includes('connection refused')
  ) {
    // Suppress connection errors as queue retries automatically
  } else {
    console.error('Queue error:', err.message);
  }
});

export async function closeQueues() {
  await receiptQueue.close();
  if (connection) {
    await connection.quit();
  }
}
