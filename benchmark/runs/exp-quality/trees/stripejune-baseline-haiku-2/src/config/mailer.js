import nodemailer from 'nodemailer';
import { config } from './env.js';

let transporter;

export function getMailer() {
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    auth: config.smtp.user ? {
      user: config.smtp.user,
      pass: config.smtp.pass,
    } : undefined,
  });

  return transporter;
}
