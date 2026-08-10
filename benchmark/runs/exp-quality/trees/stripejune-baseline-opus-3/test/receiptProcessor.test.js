'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { useMockMailer } = require('./helpers');
const { processReceiptJob } = require('../src/jobs/receiptProcessor');

beforeEach(() => useMockMailer());

test('processReceiptJob generates a PDF and emails it as an attachment', async () => {
  const mock = useMockMailer();
  const result = await processReceiptJob({
    orderId: 'ord_555',
    amount: 8900,
    currency: 'usd',
    customerName: 'Pat Payer',
    customerEmail: 'pat@example.com',
    paidAt: Date.now(),
  });

  assert.equal(result.orderId, 'ord_555');
  assert.ok(result.pdfBytes > 1000);

  const sent = mock.getSentMail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'pat@example.com');
  assert.match(sent[0].subject, /ord_555/);

  const attach = sent[0].attachments[0];
  assert.equal(attach.filename, 'receipt-ord_555.pdf');
  assert.equal(attach.contentType, 'application/pdf');
  // Attached content is the real generated PDF.
  const content = Buffer.isBuffer(attach.content) ? attach.content : Buffer.from(attach.content);
  assert.equal(content.slice(0, 5).toString(), '%PDF-');
});

test('processReceiptJob propagates email failure so BullMQ can retry', async () => {
  const mock = useMockMailer();
  // Tell the mock to fail the next send.
  mock.setShouldFailOnce(true);

  await assert.rejects(
    () =>
      processReceiptJob({
        orderId: 'ord_fail',
        amount: 100,
        currency: 'usd',
        customerName: 'X',
        customerEmail: 'x@example.com',
        paidAt: Date.now(),
      }),
    /nodemailer-mock failure/i
  );
});
