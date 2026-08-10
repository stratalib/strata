'use strict';
require('dotenv').config();
const { createReceiptWorker } = require('./queue/receiptWorker');

const worker = createReceiptWorker();
console.log('[receipt-worker] listening for jobs');

async function shutdown(signal) {
  console.log(`[receipt-worker] received ${signal}, shutting down`);
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
