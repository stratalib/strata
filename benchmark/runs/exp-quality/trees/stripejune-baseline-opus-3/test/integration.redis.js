'use strict';

/**
 * Real end-to-end integration check (requires a running Redis). Not part of the
 * `node --test` unit suite because it needs infrastructure. Run manually:
 *   NODE_ENV=test node test/integration.redis.js
 *
 * It enqueues a receipt job through the real BullMQ Queue, runs the real
 * Worker, and verifies a PDF receipt email is produced end to end (email is
 * mocked so no real SMTP is needed).
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const nodemailerMock = require('nodemailer-mock');
const mailer = require('../src/services/mailer');
const { createConnection } = require('../src/lib/redis');
const { enqueueReceiptJob, getQueue } = require('../src/jobs/queue');
const { startWorker } = require('../src/worker');

/**
 * Guard: BullMQ requires a real Redis with Lua scripting (EVAL). Some CI/dev
 * environments run a mock Redis that answers PING but rejects scripts. Detect
 * that up front and skip with a clear message instead of failing obscurely.
 */
async function assertRealRedis() {
  const c = createConnection();
  try {
    await c.eval('return 1', 0);
  } catch (err) {
    if (/does not execute scripts|unknown command .*EVAL/i.test(err.message)) {
      console.log('SKIP: connected Redis does not support Lua scripting (mock Redis); BullMQ requires real Redis.');
      await c.quit();
      process.exit(0);
    }
    throw err;
  }
  await c.quit();
}

async function main() {
  await assertRealRedis();

  // Mock email transport so we don't need real SMTP.
  mailer.setTransport(nodemailerMock.createTransport({}));
  nodemailerMock.mock.reset();

  const worker = startWorker();
  const uniqueId = `evt_integ_${Date.now()}`;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job did not complete within 15s')), 15000);
    worker.on('completed', (job, result) => {
      clearTimeout(timer);
      resolve(result);
    });
    worker.on('failed', (job, err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  await enqueueReceiptJob(
    {
      orderId: 'ord_integration',
      amount: 7500,
      currency: 'usd',
      customerEmail: 'integration@example.com',
      customerName: 'Integration Tester',
      paidAt: Date.now(),
    },
    uniqueId
  );

  const result = await done;
  assert.equal(result.orderId, 'ord_integration');
  assert.ok(result.pdfBytes > 1000, 'expected a real PDF');

  const sent = nodemailerMock.mock.getSentMail();
  assert.equal(sent.length, 1, 'exactly one receipt email');
  assert.equal(sent[0].to, 'integration@example.com');
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
  const content = Buffer.isBuffer(sent[0].attachments[0].content)
    ? sent[0].attachments[0].content
    : Buffer.from(sent[0].attachments[0].content);
  assert.equal(content.slice(0, 5).toString(), '%PDF-');

  console.log('INTEGRATION OK: job processed, PDF receipt emailed end-to-end');

  await worker.close();
  await getQueue().close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('INTEGRATION FAILED:', err.message);
    process.exit(1);
  }
);
