const nodemailer = require('nodemailer');
const { config } = require('./config');

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });

  return transporter;
}

async function sendMail(message) {
  const t = getTransporter();
  return t.sendMail({ from: config.smtp.from, ...message });
}

module.exports = { sendMail, getTransporter };
