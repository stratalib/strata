require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    currency: process.env.STRIPE_CURRENCY || 'usd',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  },

  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'orders@example.com',
  },

  company: {
    name: process.env.COMPANY_NAME || 'Acme, Inc.',
    address: process.env.COMPANY_ADDRESS || '123 Market St, San Francisco, CA 94103',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
  },

  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
  receiptsDir: process.env.RECEIPTS_DIR || require('path').join(__dirname, '..', '..', 'receipts'),
};

module.exports = { config, required };
