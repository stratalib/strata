'use strict';
require('dotenv').config();

// Fail fast at boot, not on the first webhook. A missing secret discovered when Stripe's first
// retry storm hits production is a worse time to find out than process startup. Everything else
// (SMTP_URL, REDIS_URL, MAIL_FROM) has a safe, runnable default — localhost Redis, jsonTransport,
// a placeholder from-address — so only the one value with no safe default is enforced here.
const REQUIRED_IN_PRODUCTION = ['STRIPE_WEBHOOK_SECRET'];

function required() {
  if (process.env.NODE_ENV !== 'production') return [];
  return REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
}

const missing = required();
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s) in production: ${missing.join(', ')}`);
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  trustProxyHops: process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : null,

  stripe: {
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    webhookPath: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
    toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  },

  mail: {
    smtpUrl: process.env.SMTP_URL || null,
    from: process.env.MAIL_FROM || 'no-reply@example.com',
    maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
    baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  },

  company: {
    name: process.env.COMPANY_NAME || 'Acme Inc.',
    supportEmail: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM || 'support@example.com',
  },
};
