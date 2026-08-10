const { env } = require('../config/env');

function formatAmount(amountInCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  }).format(amountInCents / 100);
}

function purchaseConfirmationEmail({ customerName, amount, currency, orderId }) {
  const formattedAmount = formatAmount(amount, currency);
  const greeting = customerName ? `Hi ${customerName},` : 'Hi there,';

  const text = `${greeting}

Thanks for your purchase! We've received your payment of ${formattedAmount}.

Order reference: ${orderId}

Your receipt will follow in a separate email shortly.

If you have any questions, reply to this email or contact us at ${env.supportEmail}.

- ${env.companyName}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Thanks for your purchase!</h2>
      <p>${greeting}</p>
      <p>We've received your payment of <strong>${formattedAmount}</strong>.</p>
      <p>Order reference: <code>${orderId}</code></p>
      <p>Your receipt will follow in a separate email shortly.</p>
      <p>If you have any questions, reply to this email or contact us at
        <a href="mailto:${env.supportEmail}">${env.supportEmail}</a>.
      </p>
      <p>&mdash; ${env.companyName}</p>
    </div>
  `;

  return {
    subject: `Payment confirmation - ${formattedAmount}`,
    text,
    html,
  };
}

function receiptEmail({ customerName, amount, currency, orderId }) {
  const formattedAmount = formatAmount(amount, currency);
  const greeting = customerName ? `Hi ${customerName},` : 'Hi there,';

  const text = `${greeting}

Please find attached the receipt for your recent purchase of ${formattedAmount} (order ${orderId}).

- ${env.companyName}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Your receipt</h2>
      <p>${greeting}</p>
      <p>Please find attached the receipt for your recent purchase of
        <strong>${formattedAmount}</strong> (order <code>${orderId}</code>).
      </p>
      <p>&mdash; ${env.companyName}</p>
    </div>
  `;

  return {
    subject: `Your receipt - ${orderId}`,
    text,
    html,
  };
}

module.exports = { purchaseConfirmationEmail, receiptEmail, formatAmount };
