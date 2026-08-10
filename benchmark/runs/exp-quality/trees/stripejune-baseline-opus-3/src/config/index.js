'use strict';

require('dotenv').config();

/**
 * Central config. Everything that reads from the environment does it here, so
 * there is exactly one place to audit for required secrets and one place that
 * fails loudly at boot instead of silently at request time.
 */

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
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

// In test we do not want to hard-crash on missing real secrets; tests inject
// their own values. NODE_ENV=test relaxes the "required" checks to placeholders.
const isTest = process.env.NODE_ENV === 'test';
const req = isTest ? (name) => optional(name, `test-${name}`) : required;

const config = {
  env: optional('NODE_ENV', 'development'),
  isTest,
  port: int('PORT', 3000),

  stripe: {
    secretKey: req('STRIPE_SECRET_KEY'),
    webhookSecret: req('STRIPE_WEBHOOK_SECRET'),
  },

  smtp: {
    host: optional('SMTP_HOST', 'localhost'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', 'Payments <no-reply@example.com>'),
  },

  redis: {
    host: optional('REDIS_HOST', '127.0.0.1'),
    port: int('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', undefined),
    // BullMQ requires this to be null (not undefined) for blocking commands.
    maxRetriesPerRequest: null,
  },

  // Company details printed on the PDF receipt.
  company: {
    name: optional('COMPANY_NAME', 'Acme Inc.'),
    address: optional('COMPANY_ADDRESS', '123 Example St, Springfield'),
    supportEmail: optional('COMPANY_SUPPORT_EMAIL', 'support@example.com'),
  },
};

module.exports = config;
