const nodemailer = require('nodemailer');
const { env } = require('../config/env');
const logger = require('./logger');

let transporter;

// Lazy singleton so tests can import this module without a live SMTP connection.
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html, attachments }) {
  const result = await getTransporter().sendMail({
    from: env.emailFrom,
    to,
    subject,
    text,
    html,
    attachments,
  });
  logger.info('Email sent', { to, subject, messageId: result.messageId });
  return result;
}

module.exports = { sendMail, getTransporter };
