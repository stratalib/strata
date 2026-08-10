const { sendMail } = require('../lib/mailer');
const { config } = require('../lib/config');

function formatAmount(amountInCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || config.stripe.currency).toUpperCase(),
  }).format(amountInCents / 100);
}

async function sendOrderConfirmationEmail(order) {
  const amount = formatAmount(order.amountTotal, order.currency);

  return sendMail({
    to: order.customerEmail,
    subject: `Order confirmed — ${order.id}`,
    text: [
      `Thanks for your order!`,
      ``,
      `Order ID: ${order.id}`,
      `Amount: ${amount}`,
      ``,
      `We're preparing your receipt now and will email it separately shortly.`,
      ``,
      `${config.company.name}`,
      `${config.company.supportEmail}`,
    ].join('\n'),
    html: `
      <p>Thanks for your order!</p>
      <p><strong>Order ID:</strong> ${order.id}<br/>
      <strong>Amount:</strong> ${amount}</p>
      <p>We're preparing your receipt now and will email it separately shortly.</p>
      <p>${config.company.name}<br/>${config.company.supportEmail}</p>
    `,
  });
}

async function sendReceiptEmail(order, pdfBuffer) {
  const amount = formatAmount(order.amountTotal, order.currency);

  return sendMail({
    to: order.customerEmail,
    subject: `Your receipt — ${order.id}`,
    text: [
      `Here is your receipt for order ${order.id} (${amount}).`,
      ``,
      `${config.company.name}`,
      `${config.company.supportEmail}`,
    ].join('\n'),
    html: `
      <p>Here is your receipt for order <strong>${order.id}</strong> (${amount}).</p>
      <p>${config.company.name}<br/>${config.company.supportEmail}</p>
    `,
    attachments: [
      {
        filename: `receipt-${order.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

module.exports = { sendOrderConfirmationEmail, sendReceiptEmail, formatAmount };
