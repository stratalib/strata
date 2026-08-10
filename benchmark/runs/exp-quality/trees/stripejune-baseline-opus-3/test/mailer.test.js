'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useMockMailer } = require('./helpers');
const mailer = require('../src/services/mailer');

test('formatAmount converts minor units to major for decimal currencies', () => {
  assert.equal(mailer.formatAmount(4999, 'usd'), '$49.99');
  assert.equal(mailer.formatAmount(1000, 'usd'), '$10.00');
});

test('formatAmount treats zero-decimal currencies as whole units', () => {
  // 1000 JPY should be ¥1,000 — not ¥10.00
  const jpy = mailer.formatAmount(1000, 'jpy');
  assert.match(jpy, /1,000/);
  assert.doesNotMatch(jpy, /10\.00/);
});

test('formatAmount falls back gracefully for unknown currency codes', () => {
  const out = mailer.formatAmount(1234, 'zzz');
  assert.match(out, /12\.34/);
  assert.match(out, /ZZZ/);
});

test('escapeHtml neutralizes markup in interpolated values', () => {
  assert.equal(mailer._escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(mailer._escapeHtml('a & b "c"'), 'a &amp; b &quot;c&quot;');
});

test('sendConfirmationEmail sends a lightweight email with formatted amount', async () => {
  const mock = useMockMailer();
  await mailer.sendConfirmationEmail({
    to: 'jane@example.com',
    orderId: 'ord_1',
    amount: 4999,
    currency: 'usd',
    customerName: 'Jane',
  });
  const sent = mock.getSentMail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'jane@example.com');
  assert.match(sent[0].subject, /ord_1/);
  assert.match(sent[0].text, /\$49\.99/);
  // Confirmation email must NOT carry the PDF — that's the receipt email's job.
  assert.ok(!sent[0].attachments || sent[0].attachments.length === 0);
});

test('confirmation email HTML-escapes a hostile customer name', async () => {
  const mock = useMockMailer();
  await mailer.sendConfirmationEmail({
    to: 'jane@example.com',
    orderId: 'ord_1',
    amount: 1000,
    currency: 'usd',
    customerName: '<script>alert(1)</script>',
  });
  const sent = mock.getSentMail();
  assert.doesNotMatch(sent[0].html, /<script>/);
  assert.match(sent[0].html, /&lt;script&gt;/);
});

test('sendReceiptEmail attaches the PDF buffer', async () => {
  const mock = useMockMailer();
  const pdf = Buffer.from('%PDF-1.4 fake');
  await mailer.sendReceiptEmail({
    to: 'jane@example.com',
    orderId: 'ord_9',
    amount: 2500,
    currency: 'usd',
    customerName: 'Jane',
    pdfBuffer: pdf,
  });
  const sent = mock.getSentMail();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].filename, 'receipt-ord_9.pdf');
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
});
