'use strict';

const nodemailer = require('nodemailer');
const { config } = require('./config');

// Nodemailer speaks SMTP so we can send mail from JS. We build the transport
// lazily and cache it: creating it is cheap but pooling the connection across
// many sends is cheaper than reconnecting each time.
let transport = null;

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure, // true for 465, false for 587 (STARTTLS)
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });
  return transport;
}

// Test seam: let a test swap in a mock transport, and reset afterward.
function setTransport(t) {
  transport = t;
}
function resetTransport() {
  transport = null;
}

// Immediate purchase-confirmation email (no attachment). The PDF receipt
// arrives separately from the background worker so this send stays fast and
// never blocks the webhook response.
async function sendConfirmationEmail(order) {
  const money = formatMoney(order.amountTotal, order.currency);
  const info = await getTransport().sendMail({
    from: config.smtp.from,
    to: order.customerEmail,
    subject: `Your ${config.merchant.name} purchase is confirmed`,
    text: [
      `Hi${order.customerName ? ' ' + order.customerName : ''},`,
      '',
      `Thanks for your purchase! We've received your payment of ${money}.`,
      `Order reference: ${order.id}`,
      '',
      `A PDF receipt will follow in a separate email shortly.`,
      '',
      `Questions? Reach us at ${config.merchant.supportEmail}.`,
      '',
      `— ${config.merchant.name}`,
    ].join('\n'),
  });
  return info;
}

// Receipt email carrying the generated PDF as an attachment.
async function sendReceiptEmail(order, pdfBuffer) {
  const info = await getTransport().sendMail({
    from: config.smtp.from,
    to: order.customerEmail,
    subject: `Your ${config.merchant.name} receipt (${order.id})`,
    text: [
      `Hi${order.customerName ? ' ' + order.customerName : ''},`,
      '',
      `Your receipt for order ${order.id} is attached as a PDF.`,
      '',
      `— ${config.merchant.name}`,
    ].join('\n'),
    attachments: [
      {
        filename: `receipt-${order.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
  return info;
}

// Amounts from Stripe are in the smallest currency unit (cents). Format for
// humans. Zero-decimal currencies (JPY, etc.) are the exception but rare
// enough that we handle the common case and note the limitation.
function formatMoney(amountMinor, currency) {
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${String(currency || 'usd').toUpperCase()}`;
}

module.exports = {
  sendConfirmationEmail,
  sendReceiptEmail,
  formatMoney,
  getTransport,
  setTransport,
  resetTransport,
};
