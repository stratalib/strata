'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../lib/logger');

/**
 * Owns the single shared SMTP transport (a connection pool to the mail server)
 * and the concrete emails we send. Keeping transport creation lazy + swappable
 * lets tests inject a mock transport without this module knowing the difference.
 */

let transport = null;

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure, // true for 465, false for 587/STARTTLS
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
    // Pool reuses connections across many receipt emails instead of a fresh
    // TCP+TLS handshake each time — meaningful under webhook bursts.
    pool: true,
    maxConnections: 5,
  });
  return transport;
}

/** Test seam: replace the transport with a mock. */
function setTransport(mockTransport) {
  transport = mockTransport;
}

function formatAmount(amountMinor, currency) {
  // Stripe amounts are in the currency's minor unit (cents). Zero-decimal
  // currencies (JPY, KRW, ...) are the exception; handle the common case and
  // treat known zero-decimal currencies as already whole.
  const zeroDecimal = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk', 'huf']);
  const code = (currency || 'usd').toLowerCase();
  const amount = zeroDecimal.has(code) ? amountMinor : amountMinor / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code.toUpperCase(),
    }).format(amount);
  } catch {
    // Unknown currency code — fall back to a plain number + raw code.
    return `${amount.toFixed(zeroDecimal.has(code) ? 0 : 2)} ${code.toUpperCase()}`;
  }
}

/**
 * Immediate "we got your payment" email. Sent from the webhook path, so it is
 * intentionally lightweight — no attachments, no heavy rendering.
 */
async function sendConfirmationEmail({ to, orderId, amount, currency, customerName }) {
  const pretty = formatAmount(amount, currency);
  const name = customerName || 'there';
  const info = await getTransport().sendMail({
    from: config.smtp.from,
    to,
    subject: `Payment confirmed — order ${orderId}`,
    text:
      `Hi ${name},\n\n` +
      `Thanks for your purchase. We've received your payment of ${pretty}.\n` +
      `Order reference: ${orderId}\n\n` +
      `Your receipt is being generated and will arrive in a separate email shortly.\n\n` +
      `— ${config.company.name}`,
    html:
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Thanks for your purchase. We've received your payment of <strong>${escapeHtml(pretty)}</strong>.</p>` +
      `<p>Order reference: <code>${escapeHtml(orderId)}</code></p>` +
      `<p>Your receipt is being generated and will arrive in a separate email shortly.</p>` +
      `<p>— ${escapeHtml(config.company.name)}</p>`,
  });
  logger.info('confirmation email sent', { to, orderId, messageId: info.messageId });
  return info;
}

/**
 * Receipt email with the generated PDF attached. Sent from the background
 * worker, not the webhook, because PDF generation is the slow part.
 */
async function sendReceiptEmail({ to, orderId, amount, currency, customerName, pdfBuffer }) {
  const pretty = formatAmount(amount, currency);
  const name = customerName || 'there';
  const info = await getTransport().sendMail({
    from: config.smtp.from,
    to,
    subject: `Your receipt — order ${orderId}`,
    text:
      `Hi ${name},\n\n` +
      `Please find attached your receipt for ${pretty} (order ${orderId}).\n\n` +
      `Questions? Reach us at ${config.company.supportEmail}.\n\n` +
      `— ${config.company.name}`,
    html:
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Please find attached your receipt for <strong>${escapeHtml(pretty)}</strong> (order <code>${escapeHtml(orderId)}</code>).</p>` +
      `<p>Questions? Reach us at ${escapeHtml(config.company.supportEmail)}.</p>` +
      `<p>— ${escapeHtml(config.company.name)}</p>`,
    attachments: [
      {
        filename: `receipt-${orderId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
  logger.info('receipt email sent', { to, orderId, messageId: info.messageId });
  return info;
}

// Minimal HTML escaping for the interpolated user-controlled values (name,
// email) so a customer name can't inject markup into the email body.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  getTransport,
  setTransport,
  sendConfirmationEmail,
  sendReceiptEmail,
  formatAmount,
  _escapeHtml: escapeHtml,
};
