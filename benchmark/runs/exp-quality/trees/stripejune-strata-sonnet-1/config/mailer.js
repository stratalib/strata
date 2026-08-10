'use strict';
const nodemailer = require('nodemailer');
const { createMailer } = require('strata-composed');
const env = require('./env');

// No SMTP_URL configured -> fall back to Nodemailer's JSON transport, which renders the message
// instead of sending it. Same "safe by default" reasoning as strata-composed's own test transport:
// a box with no SMTP configured must never silently attempt real delivery.
const smtpTransport = env.mail.smtpUrl
  ? nodemailer.createTransport(env.mail.smtpUrl)
  : nodemailer.createTransport({ jsonTransport: true });

async function nodemailerTransport(message) {
  const info = await smtpTransport.sendMail({
    from: message.from.name
      ? `"${message.from.name}" <${message.from.address}>`
      : message.from.address,
    to: message.to.map((t) => (t.name ? `"${t.name}" <${t.address}>` : t.address)).join(', '),
    cc: message.cc.length
      ? message.cc.map((t) => (t.name ? `"${t.name}" <${t.address}>` : t.address)).join(', ')
      : undefined,
    bcc: message.bcc.length
      ? message.bcc.map((t) => (t.name ? `"${t.name}" <${t.address}>` : t.address)).join(', ')
      : undefined,
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
  return info;
}

const deadLetters = [];

const mailer = createMailer({
  transport: nodemailerTransport,
  from: env.mail.from,
  maxAttempts: env.mail.maxAttempts,
  baseBackoffMs: env.mail.baseBackoffMs,
  onDeadLetter: async (record) => {
    // No durable store wired up for this project (no DB was specified). Kept in-process and logged
    // loudly so it is at least visible in stdout/log aggregation rather than silently dropped.
    deadLetters.push(record);
    console.error('[mailer] DEAD LETTER — email not delivered after retries:', record);
  },
  log: (event) => {
    if (event.event === 'email.dead-letter' || event.event === 'email.permanent-failure') {
      console.error('[mailer]', event);
    }
  },
});

module.exports = { mailer, deadLetters };
