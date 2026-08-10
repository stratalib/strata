const nodemailer = require('nodemailer');
const { env } = require('../config/env');
const { formatMoney } = require('../utils/formatMoney');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    });
  }
  return transporter;
}

async function sendConfirmationEmail(order) {
  const total = formatMoney(order.amountTotal, order.currency);
  const itemsHtml = order.lineItems.length
    ? `<ul>${order.lineItems
        .map((i) => `<li>${i.quantity} x ${i.description} - ${formatMoney(i.amount, order.currency)}</li>`)
        .join('')}</ul>`
    : '';

  const html = `
    <p>Hi ${order.customerName || 'there'},</p>
    <p>Thanks for your purchase! We've received your payment of <strong>${total}</strong>.</p>
    ${itemsHtml}
    <p>Your PDF receipt will arrive in a separate email shortly.</p>
  `;

  return getTransporter().sendMail({
    from: env.mailFrom,
    to: order.customerEmail,
    subject: 'Payment confirmation',
    html,
  });
}

async function sendReceiptEmail(order, pdfBuffer) {
  const total = formatMoney(order.amountTotal, order.currency);

  return getTransporter().sendMail({
    from: env.mailFrom,
    to: order.customerEmail,
    subject: `Your receipt - ${total}`,
    html: `<p>Hi ${order.customerName || 'there'},</p><p>Please find your receipt attached.</p>`,
    attachments: [
      {
        filename: `receipt-${order.objectId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

module.exports = { sendConfirmationEmail, sendReceiptEmail, getTransporter };
