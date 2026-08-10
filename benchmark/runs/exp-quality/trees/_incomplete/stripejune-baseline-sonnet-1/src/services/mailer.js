const nodemailer = require('nodemailer');
const { config } = require('../config/env');

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html, attachments }) {
  return getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    html,
    attachments,
  });
}

function formatAmount(amountInSmallestUnit, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountInSmallestUnit / 100);
}

async function sendPurchaseConfirmationEmail(order) {
  const amount = formatAmount(order.amount_total, order.currency);
  const subject = `${config.appName}: order confirmed (#${order.id})`;
  const text =
    `Hi ${order.customer_name || 'there'},\n\n` +
    `Thanks for your purchase! We've received your payment of ${amount}.\n` +
    `Order #${order.id}${order.description ? ` — ${order.description}` : ''}\n\n` +
    `Your PDF receipt is on its way in a separate email.\n\n` +
    `— ${config.appName}`;
  const html =
    `<p>Hi ${order.customer_name || 'there'},</p>` +
    `<p>Thanks for your purchase! We've received your payment of <strong>${amount}</strong>.</p>` +
    `<p>Order #${order.id}${order.description ? ` — ${order.description}` : ''}</p>` +
    `<p>Your PDF receipt is on its way in a separate email.</p>` +
    `<p>— ${config.appName}</p>`;

  return sendMail({ to: order.customer_email, subject, text, html });
}

async function sendReceiptEmail(order, pdfBuffer, fileName) {
  const amount = formatAmount(order.amount_total, order.currency);
  const subject = `${config.appName}: your receipt for order #${order.id}`;
  const text = `Hi ${order.customer_name || 'there'},\n\nAttached is your receipt for ${amount} (order #${order.id}).\n\n— ${config.appName}`;
  const html = `<p>Hi ${order.customer_name || 'there'},</p><p>Attached is your receipt for <strong>${amount}</strong> (order #${order.id}).</p><p>— ${config.appName}</p>`;

  return sendMail({
    to: order.customer_email,
    subject,
    text,
    html,
    attachments: [
      {
        filename: fileName,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

module.exports = {
  getTransporter,
  sendMail,
  sendPurchaseConfirmationEmail,
  sendReceiptEmail,
  formatAmount,
};
