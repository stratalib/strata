const express = require('express');
const Stripe = require('stripe');
const { env } = require('../config/env');
const receiptQueue = require('../queues/receiptQueue');
const mailer = require('../lib/mailer');
const { purchaseConfirmationEmail } = require('../services/emailTemplates');
const { claimEvent } = require('../lib/idempotency');
const logger = require('../lib/logger');

const stripe = new Stripe(env.stripeSecretKey);

function createWebhookRouter(redisConnection) {
  const router = express.Router();

  // express.raw() here is required: Stripe's signature check is computed over the
  // exact raw request bytes, so this route must NOT go through express.json() (or
  // any other body parser) before constructEvent() sees it.
  router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, env.stripeWebhookSecret);
    } catch (err) {
      logger.warn('Stripe webhook signature verification failed', { error: err.message });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge fast, then decide whether it's new work.
    const isNewEvent = await claimEvent(redisConnection, event.id);
    if (!isNewEvent) {
      logger.info('Duplicate Stripe event ignored', { eventId: event.id, type: event.type });
      return res.status(200).json({ received: true, duplicate: true });
    }

    try {
      await handleEvent(event);
    } catch (err) {
      // We already claimed the event id, so a transient failure here (e.g. SMTP
      // briefly down) means this specific delivery won't be retried by Stripe.
      // That's an acceptable tradeoff for staying idempotent; the enqueue step
      // below is the part that must not silently drop work, and BullMQ itself
      // retries failed jobs independently of this handler.
      logger.error('Error handling Stripe event', { eventId: event.id, type: event.type, error: err.message });
      return res.status(500).json({ received: false });
    }

    res.status(200).json({ received: true });
  });

  return router;
}

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event.data.object);
      break;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event.data.object);
      break;
    default:
      logger.info('Unhandled Stripe event type', { type: event.type });
  }
}

async function handleCheckoutSessionCompleted(session) {
  const orderId = session.id;
  const customerEmail = session.customer_details && session.customer_details.email;
  const customerName = session.customer_details && session.customer_details.name;
  const amount = session.amount_total;
  const currency = session.currency;

  if (!customerEmail) {
    logger.warn('Checkout session completed without customer email; skipping', { orderId });
    return;
  }

  await sendPurchaseConfirmation({ orderId, customerName, customerEmail, amount, currency });
  await receiptQueue.enqueueReceiptJob({
    orderId,
    customerName,
    customerEmail,
    amount,
    currency,
    paidAt: new Date().toISOString(),
  });
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  const orderId = paymentIntent.id;
  const customerEmail = paymentIntent.receipt_email;
  const amount = paymentIntent.amount_received || paymentIntent.amount;
  const currency = paymentIntent.currency;

  if (!customerEmail) {
    // No receipt_email set and no Checkout Session in play: nothing to send to.
    logger.warn('Payment intent succeeded without a receipt email; skipping', { orderId });
    return;
  }

  await sendPurchaseConfirmation({ orderId, customerName: null, customerEmail, amount, currency });
  await receiptQueue.enqueueReceiptJob({
    orderId,
    customerName: null,
    customerEmail,
    amount,
    currency,
    paidAt: new Date().toISOString(),
  });
}

async function sendPurchaseConfirmation({ orderId, customerName, customerEmail, amount, currency }) {
  const { subject, text, html } = purchaseConfirmationEmail({ customerName, amount, currency, orderId });
  await mailer.sendMail({ to: customerEmail, subject, text, html });
}

module.exports = { createWebhookRouter, handleEvent };
