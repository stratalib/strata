'use strict';
const nodemailer = require('nodemailer');
const { createMailer, createTestTransport } = require('strata-composed');

// SMTP_URL (e.g. smtps://user:pass@smtp.example.com) is the single env var Nodemailer needs.
// With nothing configured we fall back to the Strata test transport, which records messages
// instead of sending — the same "safe by default" reasoning as the rest of this app: a box with
// no SMTP configured must not silently attempt real deliveries and fail, or silently succeed by
// doing nothing without anyone knowing why.
let transport;
let smtpTransporter = null;
if (process.env.SMTP_URL) {
  const smtp = nodemailer.createTransport(process.env.SMTP_URL);
  smtpTransporter = smtp;
  transport = async (message) => smtp.sendMail({
    from: message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address,
    to: message.to.map((t) => (t.name ? `${t.name} <${t.address}>` : t.address)).join(', '),
    cc: message.cc.length ? message.cc.map((t) => t.address).join(', ') : undefined,
    bcc: message.bcc.length ? message.bcc.map((t) => t.address).join(', ') : undefined,
    subject: message.subject,
    text: message.text || undefined,
    html: message.html || undefined,
    headers: message.headers,
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
} else {
  transport = createTestTransport();
  console.warn('[mailer] SMTP_URL not set — using in-memory test transport, no real email will be sent');
}

const mailer = createMailer({
  transport,
  from: process.env.MAIL_FROM || 'no-reply@example.com',
  maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
  baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
  onDeadLetter: async (record) => {
    console.error('[mailer] dead-lettered email, nobody received it:', record);
  },
});

// Exposed so a process (or a test) that created the pooled SMTP connection can close it on
// shutdown — Nodemailer's default transport keeps a socket pool alive, which is exactly what a
// long-running server wants but what a one-off script or test must clean up explicitly.
module.exports = { mailer, transport, smtpTransporter };
