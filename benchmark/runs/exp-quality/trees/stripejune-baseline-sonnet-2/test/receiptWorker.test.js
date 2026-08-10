const test = require('node:test');
const assert = require('node:assert/strict');
const { processReceiptJob } = require('../src/jobs/receiptWorker');
const receiptPdf = require('../src/services/receiptPdf');
const emailService = require('../src/services/emailService');

function fakeJob(data, overrides = {}) {
  return { id: 'job_1', data, attemptsMade: 1, ...overrides };
}

test('processReceiptJob generates a PDF and emails it for a valid order', async (t) => {
  const order = {
    eventId: 'evt_1',
    objectId: 'cs_1',
    customerEmail: 'buyer@example.com',
    customerName: 'Buyer',
    amountTotal: 1500,
    currency: 'usd',
    createdAt: new Date().toISOString(),
    lineItems: [],
  };

  const fakePdfBuffer = Buffer.from('%PDF-fake');
  const originalGenerate = receiptPdf.generateReceiptPdf;
  const originalSend = emailService.sendReceiptEmail;

  let generateCalledWith = null;
  let sendCalledWith = null;
  receiptPdf.generateReceiptPdf = async (o) => {
    generateCalledWith = o;
    return fakePdfBuffer;
  };
  emailService.sendReceiptEmail = async (o, buf) => {
    sendCalledWith = { order: o, buf };
  };
  t.after(() => {
    receiptPdf.generateReceiptPdf = originalGenerate;
    emailService.sendReceiptEmail = originalSend;
  });

  const result = await processReceiptJob(fakeJob(order));

  assert.deepEqual(result, { sent: true });
  assert.equal(generateCalledWith.objectId, 'cs_1');
  assert.equal(sendCalledWith.order.objectId, 'cs_1');
  assert.equal(sendCalledWith.buf, fakePdfBuffer);
});

test('processReceiptJob skips jobs with no customer email instead of throwing', async () => {
  const order = {
    eventId: 'evt_2',
    objectId: 'cs_2',
    customerEmail: null,
    lineItems: [],
  };

  const result = await processReceiptJob(fakeJob(order));

  assert.deepEqual(result, { skipped: true });
});
