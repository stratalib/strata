const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATA_DIR = path.join(__dirname, '.tmp-data-worker');
process.env.RECEIPTS_DIR = path.join(__dirname, '.tmp-receipts-worker');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
fs.rmSync(process.env.RECEIPTS_DIR, { recursive: true, force: true });

const receiptEmailCalls = [];
require.cache[require.resolve('../src/services/emailService')] = {
  id: require.resolve('../src/services/emailService'),
  filename: require.resolve('../src/services/emailService'),
  loaded: true,
  exports: {
    sendOrderConfirmationEmail: async () => {},
    sendReceiptEmail: async (order, pdfBuffer) => {
      receiptEmailCalls.push({ order, pdfBuffer });
    },
    formatAmount: (amount, currency) => `${(amount / 100).toFixed(2)} ${currency || 'usd'}`,
  },
};

const { processReceiptJob } = require('../src/workers/receiptWorker');
const { upsertOrder, getOrder } = require('../src/services/orderStore');

test('processReceiptJob generates a PDF, writes it to disk, and emails it', async () => {
  upsertOrder({
    id: 'order_worker_1',
    customerEmail: 'worker@example.com',
    amountTotal: 5500,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    productName: 'Test Product',
  });

  receiptEmailCalls.length = 0;
  const result = await processReceiptJob({ data: { orderId: 'order_worker_1' } });

  assert.equal(result.orderId, 'order_worker_1');
  assert.ok(fs.existsSync(result.filePath));

  const written = fs.readFileSync(result.filePath);
  assert.equal(written.subarray(0, 5).toString('ascii'), '%PDF-');

  assert.equal(receiptEmailCalls.length, 1);
  assert.equal(receiptEmailCalls[0].order.id, 'order_worker_1');
  assert.ok(Buffer.isBuffer(receiptEmailCalls[0].pdfBuffer));

  const updated = getOrder('order_worker_1');
  assert.ok(updated.receiptGeneratedAt);
  assert.ok(updated.receiptPath);
});

test('processReceiptJob throws for unknown order (so BullMQ marks it failed, not silently dropped)', async () => {
  await assert.rejects(
    () => processReceiptJob({ data: { orderId: 'does_not_exist' } }),
    /Unknown order/
  );
});
