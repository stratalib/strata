'use strict';

require('dotenv').config();

// Single source of truth for configuration. Everything else reads from here
// instead of touching process.env, so misconfiguration surfaces at boot.

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    // The signing secret is what makes webhook verification meaningful.
    // Without it we cannot prove a webhook actually came from Stripe.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'receipts@example.com',
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: int(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Name of the company that appears on receipts and emails.
  merchant: {
    name: process.env.MERCHANT_NAME || 'Acme Inc.',
    supportEmail: process.env.MERCHANT_SUPPORT_EMAIL || 'support@example.com',
  },
};

// Fail fast in production if the security-critical secrets are absent.
// In development/test we allow them to be empty so the app can boot for
// local work and the test suite (which stubs these) can run.
function assertProductionConfig() {
  if (config.env !== 'production') return;
  const missing = [];
  if (!config.stripe.secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.stripe.webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  if (missing.length) {
    throw new Error(`Missing required config in production: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertProductionConfig };
