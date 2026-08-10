'use strict';
require('dotenv').config();
const express = require('express');
const redis = require('redis');
const { Queue } = require('bullmq');
const stripe = require('stripe');
const {
  badJsonHandler,
  createMailer,
  createStripeWebhook,
  createWebhookEventLog,
  validateRequest,
} = require('strata-composed');
const { createMailer: createNodemailer } = require('./lib/mailer');
const { createReceiptWorker } = require('./lib/receipt-worker');


// Redis connection for BullMQ queues
const redisConnection = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisConnection.on('error', (err) => console.error('Redis error:', err));

// Nodemailer-based transactional email
const nodemailer = createNodemailer();

// BullMQ queue for receipt generation jobs
const receiptQueue = new Queue('receipt-generation', { connection: redisConnection });

// Start the receipt worker
const receiptWorker = createReceiptWorker(redisConnection, nodemailer);

// Stripe API client
const stripeClient = stripe(process.env.STRIPE_API_KEY);

// Stripe webhook intake. Mounted ABOVE express.json() on purpose: the signature covers the raw request
// bytes, and once a JSON parser has run those bytes are gone. Re-serializing req.body produces a
// different HMAC and rejects every genuine delivery — the single most common Stripe integration bug.
const stripeWebhookOptions = {
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  path: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
  toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  eventLog: createWebhookEventLog(),
  onEvent: async (event) => {
    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        // Send immediate purchase confirmation email
        await nodemailer.send({
          to: session.customer_email,
          template: 'purchase_confirmation',
          data: {
            orderId: session.id,
            amount: (session.amount_total / 100).toFixed(2),
          },
        });

        // Queue the receipt generation job (PDF will be generated and emailed)
        await receiptQueue.add('receipt', {
          sessionId: session.id,
          email: session.customer_email,
          amount: session.amount_total,
          items: session.display_items || [],
        });

        console.log(`[stripe-webhook] processed checkout.session.completed ${session.id}`);
      }
    } catch (err) {
      console.error(`[stripe-webhook] error processing ${event.id}:`, err.message);
    }
  },
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

app.use(badJsonHandler());

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server listening on port ${port}`));

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(async () => {
    await receiptWorker.close();
    await receiptQueue.close();
    await redisConnection.quit();
    process.exit(0);
  });
});
