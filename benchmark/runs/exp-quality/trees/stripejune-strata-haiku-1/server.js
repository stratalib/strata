'use strict';
require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const {
  createMailer,
  createStripeWebhook,
  createWebhookEventLog,
} = require('strata-composed');
const { createReceiptQueue, startReceiptWorker } = require('./lib/job-queue');

// Email transport: sends real mail via SMTP if configured, otherwise captures for testing.
let emailTransport = null;
if (process.env.SMTP_URL) {
  emailTransport = nodemailer.createTransport({ url: process.env.SMTP_URL });
}

const mailer = createMailer({
  from: process.env.MAIL_FROM || 'no-reply@example.com',
  maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
  baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
  transport: emailTransport ? async (msg) => emailTransport.sendMail({
    from: msg.from.address,
    to: msg.to.map(t => t.address).join(', '),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: msg.attachments,
  }) : undefined,
});

// Receipt job queue and worker
let receiptQueue = null;
let receiptWorker = null;

try {
  receiptQueue = createReceiptQueue();

  // Start the receipt worker
  startReceiptWorker(mailer).then((worker) => {
    receiptWorker = worker;
    console.log('[queue] receipt worker started');
  }).catch((err) => {
    console.warn('[queue] failed to start receipt worker (Redis unavailable?):', err.message);
    // Continue running without the queue - fallback behavior for test/dev without Redis
  });
} catch (err) {
  console.warn('[queue] redis connection failed:', err.message);
  // Continue running - in production, this would be a fatal error
}

// Purchase confirmation email: sent immediately after webhook is acknowledged
async function sendPurchaseConfirmation(session) {
  return mailer.send({
    to: session.customer_email,
    subject: 'Order Confirmation',
    html: `
      <h2>Thank you for your order!</h2>
      <p>Order ID: <strong>${session.id}</strong></p>
      <p>Amount: <strong>$${(session.amount_total / 100).toFixed(2)}</strong></p>
      <p>A detailed receipt is being generated and will arrive shortly.</p>
    `,
  });
}

const stripeWebhookOptions = {
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  path: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
  toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  eventLog: createWebhookEventLog(),
  onEvent: async (event) => {
    if (event.type !== 'checkout.session.completed') return;

    const session = event.data.object;
    console.log(`[payment] processing checkout ${session.id}`);

    try {
      // Send purchase confirmation immediately
      await sendPurchaseConfirmation(session);
      console.log(`[payment] confirmation sent to ${session.customer_email}`);

      // Enqueue PDF receipt generation as a background job (if queue is available)
      if (receiptQueue) {
        await receiptQueue.add('receipt', {
          sessionId: session.id,
          email: session.customer_email,
          orderData: {
            amount: session.amount_total,
            currency: session.currency || 'usd',
            items: session.metadata?.items ? JSON.parse(session.metadata.items) : [],
          },
        }, {
          removeOnComplete: true,
          removeOnFail: false,
        });
        console.log(`[payment] receipt job queued for ${session.id}`);
      } else {
        console.warn(`[payment] receipt queue not available, skipping async receipt for ${session.id}`);
      }
    } catch (err) {
      console.error(`[payment] error processing ${session.id}: ${err.message}`);
    }
  },
};

const app = express();

if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

app.use(createStripeWebhook(stripeWebhookOptions));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server listening on port ${port}`));

// Graceful shutdown
async function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed');
  });

  if (receiptWorker) {
    await receiptWorker.close();
  }
  if (receiptQueue) {
    await receiptQueue.close();
  }

  setTimeout(() => {
    console.log('Shutdown timeout, exiting');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => gracefulShutdown().catch(() => process.exit(1)));
