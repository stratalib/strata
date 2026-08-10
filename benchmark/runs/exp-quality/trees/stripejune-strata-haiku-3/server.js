'use strict';
require('dotenv').config();
const express = require('express');
const redis = require('redis');
const {
  createMailer,
  createStripeWebhook,
  createWebhookEventLog,
} = require('strata-composed');
const { createReceiptQueue } = require('./lib/receipt-queue');
const { createPurchaseHandler } = require('./lib/purchase-handler');


// Redis connection for BullMQ job queue
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redisClient.on('error', (err) => console.error('[redis] error:', err.message));

// Outbound transactional email
const mailer = createMailer({
  from: process.env.MAIL_FROM || 'no-reply@example.com',
  maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
  baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
  transport: process.env.MAIL_TRANSPORT ? (async (msg) => {
    const nodemailer = require('nodemailer');
    const smtp = nodemailer.createTransport(process.env.MAIL_TRANSPORT);
    return smtp.sendMail({
      from: msg.from.address,
      to: msg.to.map(t => t.address).join(', '),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments,
    });
  }) : undefined,
});

// Receipt queue for background PDF generation and email delivery
const receiptQueue = createReceiptQueue({
  redis: redisClient,
  mailer,
  onReceipt: async (result) => {
    if (!result.success) {
      console.error(`[receipt] failed for ${result.email}: ${result.error}`);
    }
  },
});

// Purchase event handler coordinates confirmation email and receipt generation
const purchaseHandler = createPurchaseHandler({ receiptQueue, mailer });

// Stripe webhook intake. Mounted ABOVE express.json() on purpose: the signature covers the raw request
// bytes, and once a JSON parser has run those bytes are gone.
const stripeWebhookOptions = {
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  path: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
  toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  eventLog: createWebhookEventLog(),
  onEvent: purchaseHandler,
};

const app = express();

// TRUST PROXY — off by default, and that default is deliberate.
//
// Anything keyed on req.ip (rate limiting above all) is wrong behind a load balancer unless Express
// is told how many proxies to trust: req.ip becomes the PROXY's address, so every caller shares one
// bucket and the first burst 429s the entire internet. That is an outage, and it only appears in
// production.
//
// It is opt-in rather than automatic because the opposite mistake is worse: trusting
// X-Forwarded-For when nothing strips it lets any caller forge their own IP and bypass the limiter
// completely. Set TRUST_PROXY_HOPS to the number of proxies actually in front of this app —
// 1 behind a single nginx/ALB, 2 behind Cloudflare plus your own.
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

app.use(createStripeWebhook(stripeWebhookOptions));

app.use(express.json());


app.get('/health', (_req, res) => res.json({ ok: true }));


// Try to connect Redis but don't fail if it's unavailable (queue goes in-memory)
redisClient.connect().catch(err => {
  if (process.env.REDIS_URL) {
    console.warn('[redis] connection failed:', err.message);
  }
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close(() => console.log('HTTP server closed'));
  await receiptQueue.close();
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
