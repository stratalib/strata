'use strict';

const { Worker } = require('bullmq');
const { createConnection } = require('./lib/redis');
const { RECEIPT_QUEUE_NAME } = require('./jobs/queue');
const { processReceiptJob } = require('./jobs/receiptProcessor');
const logger = require('./lib/logger');

/**
 * Background worker process. Run separately from the web server:
 *   npm run worker
 *
 * It pulls receipt jobs off Redis and runs them. Keeping it in its own process
 * means slow PDF/email work never competes with webhook responsiveness, and it
 * can be scaled independently (run N workers).
 */

function startWorker() {
  const worker = new Worker(
    RECEIPT_QUEUE_NAME,
    async (job) => processReceiptJob(job.data),
    {
      connection: createConnection(),
      concurrency: 5,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('job completed', { jobId: job.id, ...result });
  });

  worker.on('failed', (job, err) => {
    logger.error('job failed', {
      jobId: job ? job.id : undefined,
      attemptsMade: job ? job.attemptsMade : undefined,
      error: err ? err.message : String(err),
    });
  });

  worker.on('error', (err) => {
    logger.error('worker error', { error: err.message });
  });

  logger.info('receipt worker started', { queue: RECEIPT_QUEUE_NAME });

  const shutdown = async (signal) => {
    logger.info('worker shutting down', { signal });
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return worker;
}

// Start only when run directly, not when required by a test.
if (require.main === module) {
  startWorker();
}

module.exports = { startWorker };
