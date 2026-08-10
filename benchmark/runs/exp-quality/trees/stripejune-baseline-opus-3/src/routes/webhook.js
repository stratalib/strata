'use strict';

const express = require('express');
const { constructEvent } = require('../services/stripe');
const { sendConfirmationEmail } = require('../services/mailer');
const { enqueueReceiptJob } = require('../jobs/queue');
const { claimEvent, releaseEvent } = require('../lib/idempotency');
const logger = require('../lib/logger');

/**
 * Stripe webhook router.
 *
 * CRITICAL: this router uses express.raw() so req.body is the exact Buffer
 * Stripe sent. Stripe signs the raw bytes; if a JSON body parser runs first the
 * original bytes are gone and signature verification is impossible. This router
 * must be mounted BEFORE any global express.json() (see app.js).
 */
const router = express.Router();

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    let event;
    try {
      event = constructEvent(req.body, signature);
    } catch (err) {
      // Bad/missing signature, or tampered payload. Never process it.
      logger.warn('webhook signature verification failed', { error: err.message });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge fast, then do work. We handle the events we care about and
    // 200 everything else so Stripe stops retrying events we intentionally
    // ignore. Any real processing error is logged; we still 200 for events
    // whose retry wouldn't help (the receipt job has its own retry).
    try {
      await handleEvent(event);
    } catch (err) {
      logger.error('webhook processing error', { eventId: event.id, type: event.type, error: err.message });
      // Return 500 so Stripe retries — the failure was before we durably
      // enqueued the job, so a retry is the safe way to not lose the receipt.
      return res.status(500).send('Processing error');
    }

    return res.json({ received: true });
  }
);

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handlePaymentSuccess(extractFromCheckoutSession(event));
    case 'payment_intent.succeeded':
      return handlePaymentSuccess(extractFromPaymentIntent(event));
    default:
      logger.info('ignoring unhandled webhook event', { type: event.type });
      return undefined;
  }
}

/**
 * Shared success path for both event shapes. Sends the confirmation email
 * inline (fast) and enqueues the receipt job (slow work) keyed on the Stripe
 * event id for idempotency against redelivery.
 */
async function handlePaymentSuccess(details) {
  const { eventId, orderId, amount, currency, customerEmail, customerName, paidAt } = details;

  if (!customerEmail) {
    logger.warn('payment success without customer email; skipping emails', { orderId });
    return;
  }

  // Idempotency gate: the first delivery of this event wins the claim and does
  // the work; redeliveries are skipped here BEFORE any email is sent. This
  // covers the inline confirmation email, which the jobId dedupe alone cannot.
  const won = await claimEvent(eventId);
  if (!won) return;

  try {
    // Confirmation email is sent inline. If it fails we release the claim and
    // let the error propagate -> 500 -> Stripe retries cleanly.
    await sendConfirmationEmail({
      to: customerEmail,
      orderId,
      amount,
      currency,
      customerName,
    });

    await enqueueReceiptJob(
      { orderId, amount, currency, customerEmail, customerName, paidAt },
      eventId // second layer of dedupe: same jobId -> no duplicate job
    );
  } catch (err) {
    // Undo the claim so a Stripe retry can genuinely re-attempt rather than
    // being permanently deduped away after a partial failure.
    await releaseEvent(eventId);
    throw err;
  }
}

function extractFromPaymentIntent(event) {
  const pi = event.data.object;
  return {
    eventId: event.id,
    orderId: pi.metadata?.orderId || pi.id,
    amount: pi.amount_received ?? pi.amount,
    currency: pi.currency,
    customerEmail: pi.receipt_email || pi.metadata?.customerEmail || null,
    customerName: pi.shipping?.name || pi.metadata?.customerName || null,
    paidAt: event.created ? event.created * 1000 : Date.now(),
  };
}

function extractFromCheckoutSession(event) {
  const session = event.data.object;
  return {
    eventId: event.id,
    orderId: session.metadata?.orderId || session.id,
    amount: session.amount_total,
    currency: session.currency,
    customerEmail: session.customer_details?.email || session.customer_email || null,
    customerName: session.customer_details?.name || session.metadata?.customerName || null,
    paidAt: event.created ? event.created * 1000 : Date.now(),
  };
}

module.exports = { router, handleEvent, extractFromPaymentIntent, extractFromCheckoutSession };
