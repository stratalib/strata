'use strict';

const nodemailer = require('nodemailer');
const { config } = require('./config');

// One transport for the whole process. Creating a transport per message would
// open and tear down an SMTP connection each time; the transport pools
// connections for us instead.
let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      // Only attach auth if credentials were supplied. Some local/dev SMTP
      // servers (Mailhog, Mailpit) accept mail with no auth at all.
      auth:
        config.smtp.user && config.smtp.pass
          ? { user: config.smtp.user, pass: config.smtp.pass }
          : undefined,
    });
  }
  return transporter;
}

// Allow tests to inject a fake transport (an object with a sendMail method).
function setTransporter(fake) {
  transporter = fake;
}

function formatAmount(amountMinor, currency) {
  // Stripe reports money in the smallest currency unit (e.g. cents). Most
  // currencies have 2 decimal places; a few (JPY, KRW) have 0. We handle the
  // common case and the well-known zero-decimal set.
  const zeroDecimal = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  const code = (currency || 'usd').toLowerCase();
  const major = zeroDecimal.has(code) ? amountMinor : amountMinor / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() }).format(major);
  } catch {
    // Unknown currency code: fall back to a plain number + code.
    return `${major.toFixed(zeroDecimal.has(code) ? 0 : 2)} ${code.toUpperCase()}`;
  }
}

// Instant confirmation, sent synchronously from the webhook. Intentionally
// plain — its job is to reassure the customer the payment landed. The itemised
// PDF receipt follows from the background worker.
async function sendConfirmationEmail(order) {
  const amount = formatAmount(order.amountTotal, order.currency);
  const subject = `Payment confirmed — ${amount}`;
  const text = [
    `Hi${order.customerName ? ' ' + order.customerName : ''},`,
    '',
    `Thanks for your purchase. We've received your payment of ${amount}.`,
    `Order reference: ${order.orderId}`,
    '',
    `A detailed PDF receipt is on its way in a separate email.`,
    '',
    `— ${config.company.name}`,
  ].join('\n');

  return getTransporter().sendMail({
    from: config.smtp.from,
    to: order.customerEmail,
    subject,
    text,
  });
}

// Follow-up email carrying the PDF receipt. Sent from the worker.
async function sendReceiptEmail(order, pdfBuffer) {
  const amount = formatAmount(order.amountTotal, order.currency);
  const text = [
    `Hi${order.customerName ? ' ' + order.customerName : ''},`,
    '',
    `Your receipt for order ${order.orderId} (${amount}) is attached as a PDF.`,
    '',
    `Questions? Reach us at ${config.company.supportEmail}.`,
    '',
    `— ${config.company.name}`,
  ].join('\n');

  return getTransporter().sendMail({
    from: config.smtp.from,
    to: order.customerEmail,
    subject: `Your receipt — order ${order.orderId}`,
    text,
    attachments: [
      {
        filename: `receipt-${order.orderId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

module.exports = {
  getTransporter,
  setTransporter,
  formatAmount,
  sendConfirmationEmail,
  sendReceiptEmail,
};
