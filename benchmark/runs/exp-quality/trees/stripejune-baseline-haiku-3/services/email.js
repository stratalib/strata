import nodemailer from 'nodemailer';
import { formatCurrency } from '../utils/formatters.js';

let transporter;

function getTransporter() {
  if (!transporter) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn('Email configuration incomplete, emails will not be sent');
      return null;
    }

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function sendPurchaseConfirmation({ email, name, orderId, amount, currency, items }) {
  const transport = getTransporter();

  if (!transport) {
    console.log(`[MOCK] Purchase confirmation would be sent to ${email}`);
    return;
  }

  const itemsList = items
    .map((item) => `<li>${item.description} × ${item.quantity}: ${formatCurrency(item.price, currency)}</li>`)
    .join('');

  const html = `
    <h2>Thank you for your purchase, ${name}!</h2>
    <p>Your order has been received and payment confirmed.</p>

    <h3>Order Details</h3>
    <p><strong>Order ID:</strong> ${orderId}</p>
    <p><strong>Total:</strong> ${formatCurrency(amount, currency)}</p>

    <h3>Items</h3>
    <ul>${itemsList}</ul>

    <p>A detailed receipt PDF will be sent shortly.</p>
  `;

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `Order Confirmation - ${orderId}`,
      html,
    });
    console.log(`Purchase confirmation sent to ${email}`);
  } catch (error) {
    console.error(`Failed to send purchase confirmation: ${error.message}`);
    throw error;
  }
}

export async function sendReceiptEmail({ email, name, orderId, pdfPath }) {
  const transport = getTransporter();

  if (!transport) {
    console.log(`[MOCK] Receipt email would be sent to ${email} with attachment: ${pdfPath}`);
    return;
  }

  const html = `
    <h2>Your Receipt - ${orderId}</h2>
    <p>Hi ${name},</p>
    <p>Your detailed receipt is attached.</p>
  `;

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `Receipt - ${orderId}`,
      html,
      attachments: [
        {
          filename: `receipt-${orderId}.pdf`,
          path: pdfPath,
        },
      ],
    });
    console.log(`Receipt email sent to ${email}`);
  } catch (error) {
    console.error(`Failed to send receipt email: ${error.message}`);
    throw error;
  }
}

export async function sendPaymentFailureNotification({ email, name, orderId, errorMessage }) {
  const transport = getTransporter();

  if (!transport) {
    console.log(`[MOCK] Payment failure notification would be sent to ${email}`);
    return;
  }

  const html = `
    <h2>Payment Failed</h2>
    <p>Hi ${name},</p>
    <p>Unfortunately, your payment for order <strong>${orderId}</strong> could not be processed.</p>
    <p><strong>Reason:</strong> ${errorMessage}</p>
    <p>Please try again or contact support for assistance.</p>
  `;

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `Payment Failed - Order ${orderId}`,
      html,
    });
    console.log(`Payment failure notification sent to ${email}`);
  } catch (error) {
    console.error(`Failed to send failure notification: ${error.message}`);
    throw error;
  }
}
