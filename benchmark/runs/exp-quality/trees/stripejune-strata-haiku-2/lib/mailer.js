'use strict';
const nodemailer = require('nodemailer');
const { getTemplate } = require('./email-templates');

function createNodemailerTransport() {
  const smtpUrl = process.env.SMTP_URL;
  if (smtpUrl) {
    return nodemailer.createTransport(smtpUrl);
  }

  // Fallback to individual env vars
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

class Mailer {
  constructor(transport, fromAddress) {
    this.transport = transport;
    this.from = fromAddress;
  }

  async send(options) {
    const { to, template, data, attachments = [] } = options;
    const tmpl = getTemplate(template);

    const mailOptions = {
      from: this.from,
      to,
      subject: tmpl.subject,
      text: tmpl.text(data),
      html: tmpl.html(data),
      attachments,
    };

    const info = await this.transport.sendMail(mailOptions);
    return info;
  }
}

function createMailer() {
  const transport = createNodemailerTransport();
  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  return new Mailer(transport, from);
}

module.exports = { createMailer, Mailer };
