const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
process.env.SMTP_HOST = process.env.SMTP_HOST || 'localhost';
process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
process.env.SMTP_USER = process.env.SMTP_USER || 'user';
process.env.SMTP_PASS = process.env.SMTP_PASS || 'pass';
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'billing@example.com';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const mailer = require('../src/lib/mailer');
const { processReceiptJob } = require('../src/jobs/receiptWorker');

test('processReceiptJob generates a PDF and emails it as an attachment', async (t) => {
  const sentEmails = [];
  t.mock.method(mailer, 'sendMail', async (opts) => {
    sentEmails.push(opts);
    return { messageId: 'fake-message-id' };
  });

  const job = {
    id: 'job_1',
    data: {
      orderId: 'order_789',
      customerName: 'Grace Hopper',
      customerEmail: 'grace@example.com',
      amount: 12000,
      currency: 'usd',
      paidAt: new Date().toISOString(),
      items: [{ description: 'Consulting', amount: 12000 }],
    },
  };

  await processReceiptJob(job);

  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'grace@example.com');
  assert.equal(sentEmails[0].attachments.length, 1);
  assert.equal(sentEmails[0].attachments[0].filename, 'receipt-order_789.pdf');
  assert.ok(Buffer.isBuffer(sentEmails[0].attachments[0].content));
  assert.ok(sentEmails[0].attachments[0].content.length > 0);
});
