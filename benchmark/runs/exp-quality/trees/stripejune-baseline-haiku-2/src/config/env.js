import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'noreply@payments.local',
  },
};

// Validate required env vars
const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.warn(`Missing required env var: ${key}`);
  }
}
