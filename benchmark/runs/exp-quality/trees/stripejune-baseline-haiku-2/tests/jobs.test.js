import { test } from 'node:test';
import assert from 'node:assert';

test('Receipt job queue', async (t) => {
  await t.test('should have enqueueReceiptJob function', async () => {
    const { enqueueReceiptJob } = await import('../src/jobs/receiptJob.js');
    assert(typeof enqueueReceiptJob === 'function', 'enqueueReceiptJob should be a function');
  });

  await t.test('should have createReceiptQueue function', async () => {
    const { createReceiptQueue } = await import('../src/jobs/receiptJob.js');
    assert(typeof createReceiptQueue === 'function', 'createReceiptQueue should be a function');
  });

  await t.test('should have startReceiptWorker function', async () => {
    const { startReceiptWorker } = await import('../src/jobs/receiptJob.js');
    assert(typeof startReceiptWorker === 'function', 'startReceiptWorker should be a function');
  });
});
