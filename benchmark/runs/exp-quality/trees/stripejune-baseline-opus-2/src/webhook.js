'use strict';

const express = require('express');
const { config } = require('./config');

// Pull the fields we care about out of a Stripe event into a flat "order"
// object that the rest of the system (emails, PDF) understands. Keeping this
// mapping in one place means the email + PDF code never has to know Stripe's
// nested shape.
function orderFromCheckoutSession(session) {
  return {
    orderId: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
    amountTotal: session.amount_total,
    currency: session.currency,
    customerEmail:
      session.customer_details?.email || session.customer_email || undefined,
    customerName: session.customer_details?.name || undefined,
    description: session.description || undefined,
    paidAt: session.created ? session.created * 1000 : Date.now(),
  };
}

function orderFromPaymentIntent(pi) {
  const charge = pi.charges?.data?.[0];
  return {
    orderId: pi.id,
    paymentIntentId: pi.id,
    amountTotal: pi.amount_received != null ? pi.amount_received : pi.amount,
    currency: pi.currency,
    customerEmail: pi.receipt_email || charge?.billing_details?.email || undefined,
    customerName: charge?.billing_details?.name || undefined,
    description: pi.description || undefined,
    paidAt: pi.created ? pi.created * 1000 : Date.now(),
  };
}

// Build the webhook router. Dependencies are injected so the handler can be
// exercised in tests without real Redis / SMTP / network.
//   stripe:      a Stripe client (used only for constructEvent here)
//   idempotency: an object with markIfNew(id) -> Promise<boolean>
//   enqueueReceipt(order, jobId) -> Promise
//   sendConfirmationEmail(order) -> Promise
//   logger:      optional { info, warn, error }
function createWebhookRouter({ stripe, idempotency, enqueueReceipt, sendConfirmationEmail, logger = console }) {
  const router = express.Router();

  // The raw body is required for signature verification — see server.js where
  // express.raw() is mounted for this path. express.json() must NOT run first.
  router.post('/', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).send('Missing Stripe-Signature header');
    }

    let event;
    try {
      // constructEvent recomputes the HMAC over the raw body using our webhook
      // secret and compares it to the signature header (and checks the
      // timestamp to block replay). Throws if anything doesn't match.
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
    } catch (err) {
      logger.warn(`Stripe signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook signature verification failed`);
    }

    // Idempotency: only the first delivery of a given event id does real work.
    let isNew;
    try {
      isNew = await idempotency.markIfNew(event.id);
    } catch (err) {
      // If the idempotency store is down we can't safely dedupe. Return 500 so
      // Stripe retries later rather than risk double-processing right now.
      logger.error(`Idempotency store error: ${err.message}`);
      return res.status(500).send('Idempotency store unavailable');
    }
    if (!isNew) {
      logger.info(`Duplicate Stripe event ignored: ${event.id}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // We only act on events that represent a completed payment.
    let order;
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // A session can complete while payment is still async/pending; only treat
      // it as paid when Stripe says so.
      if (session.payment_status && session.payment_status !== 'paid') {
        logger.info(`Session ${session.id} completed but not paid (${session.payment_status}); skipping`);
        return res.status(200).json({ received: true, ignored: 'unpaid' });
      }
      order = orderFromCheckoutSession(session);
    } else if (event.type === 'payment_intent.succeeded') {
      order = orderFromPaymentIntent(event.data.object);
    } else {
      // Not a payment-success event we handle — ack so Stripe stops retrying.
      return res.status(200).json({ received: true, ignored: event.type });
    }

    if (!order.customerEmail) {
      // Without an email we can't confirm or send a receipt. Ack (retrying
      // won't conjure an address) but log loudly so it can be chased.
      logger.error(`Event ${event.id} has no customer email; cannot send receipt. order=${order.orderId}`);
      return res.status(200).json({ received: true, warning: 'no-customer-email' });
    }

    // Fire the instant confirmation. If this throws we still want the receipt
    // job queued and Stripe to retry, so surface a 500.
    try {
      await sendConfirmationEmail(order);
    } catch (err) {
      logger.error(`Failed to send confirmation email for ${order.orderId}: ${err.message}`);
      return res.status(500).send('Failed to send confirmation email');
    }

    // Enqueue the heavier PDF-receipt work. Key the job by event id so a retry
    // of this same event doesn't create a duplicate receipt job.
    try {
      await enqueueReceipt(order, `receipt:${event.id}`);
    } catch (err) {
      logger.error(`Failed to enqueue receipt job for ${order.orderId}: ${err.message}`);
      return res.status(500).send('Failed to enqueue receipt job');
    }

    logger.info(`Processed ${event.type} for order ${order.orderId}`);
    return res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createWebhookRouter, orderFromCheckoutSession, orderFromPaymentIntent };
