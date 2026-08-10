import { getMailer } from '../config/mailer.js';
import { config } from '../config/env.js';

export async function sendPurchaseConfirmation(email, paymentData) {
  const mailer = getMailer();

  const emailContent = `
    <h1>Payment Confirmed</h1>
    <p>Thank you for your purchase!</p>
    <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)}</p>
    <p><strong>Payment ID:</strong> ${paymentData.paymentId}</p>
    <p>Your PDF receipt will be sent shortly.</p>
  `;

  try {
    await mailer.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Payment Confirmed',
      html: emailContent,
    });
  } catch (error) {
    console.error('Failed to send confirmation email:', error);
    throw error;
  }
}

export async function sendReceiptPDF(email, filename, fileStream) {
  const mailer = getMailer();

  try {
    await mailer.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Your Receipt',
      html: '<p>Please find your receipt attached.</p>',
      attachments: [{
        filename,
        content: fileStream,
      }],
    });
  } catch (error) {
    console.error('Failed to send receipt email:', error);
    throw error;
  }
}
