'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { processReceiptJob } = require('../src/worker');
const mailer = require('../src/mailer');

test('processReceiptJob generates a PDF and emails it via the transport', async () => {
  const captured = [];
  // Inject a fake SMTP transport so no real mail is sent.
  mailer.setTransporter({
    async sendMail(message) {
      captured.push(message);
      return { messageId: 'test' };
    },
  });

  const order = {
    orderId: 'cs_1',
    amountTotal: 2500,
    currency: 'usd',
    customerEmail: 'buyer@example.com',
    customerName: 'Sam',
  };

  const result = await processReceiptJob({ data: order });

  assert.strictEqual(captured.length, 1, 'one email sent');
  const msg = captured[0];
  assert.strictEqual(msg.to, 'buyer@example.com');
  assert.match(msg.subject, /receipt/i);
  assert.strictEqual(msg.attachments.length, 1, 'one attachment');
  const att = msg.attachments[0];
  assert.match(att.filename, /receipt-cs_1\.pdf/);
  assert.strictEqual(att.contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(att.content));
  assert.strictEqual(att.content.subarray(0, 5).toString('latin1'), '%PDF-');

  assert.strictEqual(result.emailedTo, 'buyer@example.com');
  assert.ok(result.bytes > 800);
});

test('sendConfirmationEmail sends a plain confirmation (no attachment)', async () => {
  const captured = [];
  mailer.setTransporter({
    async sendMail(message) {
      captured.push(message);
      return { messageId: 'test' };
    },
  });

  await mailer.sendConfirmationEmail({
    orderId: 'cs_2',
    amountTotal: 4200,
    currency: 'usd',
    customerEmail: 'c@d.com',
    customerName: 'Pat',
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].to, 'c@d.com');
  assert.match(captured[0].subject, /confirmed/i);
  assert.match(captured[0].text, /\$42\.00/);
  assert.strictEqual(captured[0].attachments, undefined, 'confirmation has no attachment');
});
