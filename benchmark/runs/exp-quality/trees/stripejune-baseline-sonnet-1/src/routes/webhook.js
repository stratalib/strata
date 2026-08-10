const express = require('express');
const stripe = require('../lib/stripeClient');
const { config } = require('../lib/config');
const { upsertOrder, findByStripeEventId, markEventProcessed } = require('../services/orderStore');
const { sendOrderConfirmationEmail } = require('../services/emailService');
const { enqueueReceiptJob } = require('../jobs/receiptQueue');

const router = express.Router();

// Stripe needs the raw, unparsed body to verify the signature — this route
// must NOT go through express.json(), or the signature check will fail.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: Stripe may redeliver the same event; skip work we've already done.
  if (findByStripeEventId(event.id)) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        await handleCheckoutCompleted(event);
        break;
      }
      default:
        // Unhandled event types are acknowledged but ignored.
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[webhook] failed to handle event ${event.id} (${event.type}):`, err);
    // 500 tells Stripe to retry the delivery later.
    res.status(500).json({ error: 'Internal error handling webhook' });
  }
});

async function handleCheckoutCompleted(event) {
  const session = event.data.object;

  const order = upsertOrder({
    id: session.id,
    customerEmail: session.customer_details?.email || session.customer_email,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentStatus: session.payment_status,
    productName: session.line_items?.data?.[0]?.description,
    createdAt: new Date().toISOString(),
    stripeEventId: event.id,
  });

  markEventProcessed(order.id, event.id);

  if (!order.customerEmail) {
    console.warn(`[webhook] order ${order.id} has no customer email; skipping emails`);
    return;
  }

  await sendOrderConfirmationEmail(order);
  await enqueueReceiptJob(order.id);
}

module.exports = router;
