'use strict';

require('dotenv').config();

// Central place to read + validate configuration. We fail fast at boot if a
// required secret is missing so a misconfigured deploy dies immediately instead
// of accepting a payment and then throwing when it tries to verify the webhook.

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function int(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

// In test we don't want to require real secrets; the tests inject their own.
const isTest = process.env.NODE_ENV === 'test';

const config = {
  env: optional('NODE_ENV', 'development'),
  port: int('PORT', 3000),

  stripe: {
    secretKey: isTest ? optional('STRIPE_SECRET_KEY', 'sk_test_dummy') : required('STRIPE_SECRET_KEY'),
    webhookSecret: isTest
      ? optional('STRIPE_WEBHOOK_SECRET', 'whsec_dummy')
      : required('STRIPE_WEBHOOK_SECRET'),
  },

  smtp: {
    host: isTest ? optional('SMTP_HOST', 'localhost') : required('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false), // true for port 465, false for STARTTLS on 587
    user: optional('SMTP_USER', undefined),
    pass: optional('SMTP_PASS', undefined),
    from: optional('MAIL_FROM', 'Receipts <receipts@example.com>'),
  },

  redis: {
    // BullMQ can take a single URL or discrete host/port. URL wins if present.
    url: optional('REDIS_URL', undefined),
    host: optional('REDIS_HOST', '127.0.0.1'),
    port: int('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', undefined),
  },

  company: {
    name: optional('COMPANY_NAME', 'Acme Inc.'),
    address: optional('COMPANY_ADDRESS', '123 Example Street, Springfield'),
    supportEmail: optional('SUPPORT_EMAIL', 'support@example.com'),
  },
};

module.exports = { config, required, optional, bool, int };
