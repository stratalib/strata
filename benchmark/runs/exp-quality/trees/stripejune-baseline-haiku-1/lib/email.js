import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025'),
  secure: false,
  auth: process.env.SMTP_USER
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      }
    : undefined,
});

export async function sendPurchaseConfirmation({
  email,
  paymentIntentId,
  amount,
  currency,
}) {
  const currencySymbol = currency === 'usd' ? '$' : currency.toUpperCase();

  const mailOptions = {
    from: process.env.SMTP_FROM || 'noreply@payment.local',
    to: email,
    subject: 'Payment Received - Order Confirmation',
    html: `
      <h2>Thank you for your purchase!</h2>
      <p>Your payment has been successfully processed.</p>

      <div style="margin: 20px 0; padding: 15px; background-color: #f5f5f5; border-radius: 5px;">
        <p><strong>Payment ID:</strong> ${paymentIntentId}</p>
        <p><strong>Amount:</strong> ${currencySymbol}${amount.toFixed(2)}</p>
        <p><strong>Status:</strong> Confirmed</p>
      </div>

      <p>Your receipt will be emailed shortly. If you have any questions, please contact us.</p>
    `,
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log('Purchase confirmation sent:', result.messageId);
    return result;
  } catch (err) {
    console.error('Failed to send purchase confirmation:', err);
    throw err;
  }
}

export async function sendReceiptEmail({ email, filename, pdfBuffer }) {
  const mailOptions = {
    from: process.env.SMTP_FROM || 'noreply@payment.local',
    to: email,
    subject: 'Your Receipt',
    html: `
      <h2>Your Receipt is Attached</h2>
      <p>Please find your detailed receipt attached to this email.</p>
    `,
    attachments: [
      {
        filename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log('Receipt email sent:', result.messageId);
    return result;
  } catch (err) {
    console.error('Failed to send receipt email:', err);
    throw err;
  }
}
