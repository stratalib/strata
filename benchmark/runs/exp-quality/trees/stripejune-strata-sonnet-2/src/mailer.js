'use strict';

const nodemailer = require('nodemailer');
const { createMailer } = require('strata-composed');

/**
 * SMTP transport, real if SMTP_HOST is set, otherwise nodemailer's own JSON transport (logs the
 * envelope instead of connecting anywhere) — so `npm run dev` without SMTP configured still runs
 * instead of throwing on the first purchase.
 */
function buildTransporter() {
  if (!process.env.SMTP_HOST) {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    // 465 is implicit TLS; anything else (587, 25) starts plaintext and upgrades via STARTTLS
    // whenever the server advertises it (most do — including internal relays with a self-signed
    // or private-CA cert nodemailer can't validate, which fails closed by default on purpose).
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    tls: {
      rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== 'true',
    },
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

let mailerSingleton = null;

/** Shared across the web process and the worker process — both need to send mail, and both must
 *  see the same dead-letter behavior. */
function getMailer() {
  if (mailerSingleton) return mailerSingleton;

  const transporter = buildTransporter();

  mailerSingleton = createMailer({
    from: process.env.MAIL_FROM || 'no-reply@example.com',
    maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
    baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
    onDeadLetter: async (record) => {
      // No durable store wired up (no DB in this project) — logging loudly is the honest floor so a
      // lost receipt email is at least visible in the process logs, not silently swallowed.
      console.error('[mail] dead-lettered:', JSON.stringify(record));
    },
    transport: async (message) => {
      const info = await transporter.sendMail({
        from: formatAddress(message.from),
        to: message.to.map(formatAddress).join(', '),
        cc: message.cc.length ? message.cc.map(formatAddress).join(', ') : undefined,
        bcc: message.bcc.length ? message.bcc.map(formatAddress).join(', ') : undefined,
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
    },
  });

  return mailerSingleton;
}

function formatAddress({ name, address }) {
  return name ? `"${name.replace(/"/g, '')}" <${address}>` : address;
}

module.exports = { getMailer };
