'use strict';

const templates = {
  purchase_confirmation: {
    subject: 'Purchase Confirmation',
    html: (data) => `
      <h1>Thank you for your purchase!</h1>
      <p>Order ID: <strong>${data.orderId}</strong></p>
      <p>Amount: <strong>$${data.amount}</strong></p>
      <p>We'll send you a detailed receipt shortly.</p>
    `,
    text: (data) => `
Thank you for your purchase!

Order ID: ${data.orderId}
Amount: $${data.amount}

We'll send you a detailed receipt shortly.
    `,
  },

  receipt: {
    subject: 'Your Receipt',
    html: (data) => `
      <h1>Receipt</h1>
      <p>Order ID: <strong>${data.orderId}</strong></p>
      <p>Amount: <strong>$${data.amount}</strong></p>
      <p>Your receipt is attached to this email.</p>
    `,
    text: (data) => `
Receipt

Order ID: ${data.orderId}
Amount: $${data.amount}

Your receipt is attached to this email.
    `,
  },
};

function getTemplate(name) {
  const tmpl = templates[name];
  if (!tmpl) throw new Error(`Template not found: ${name}`);
  return tmpl;
}

module.exports = { getTemplate };
