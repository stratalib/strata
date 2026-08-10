'use strict';
const { startReceiptWorker } = require('./queue/receiptWorker');

const worker = startReceiptWorker();
console.log('[receipt-worker] listening for jobs');

// BullMQ workers hold a Redis connection open; without an explicit close on shutdown, a
// docker stop / process manager restart leaves the connection dangling until the OS reaps it.
async function shutdown(signal) {
  console.log(`[receipt-worker] received ${signal}, closing...`);
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
