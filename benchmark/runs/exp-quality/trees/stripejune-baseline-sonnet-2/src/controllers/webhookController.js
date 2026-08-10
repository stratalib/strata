const stripe = require('../services/stripeClient');
const { env } = require('../config/env');
const orderStore = require('../db/orderStore');
// Called as receiptQueue.enqueueReceiptJob(...) / emailService.sendConfirmationEmail(...)
// (not destructured) so tests can monkey-patch these functions on the module
// object and have that substitution actually take effect here.
const receiptQueue = require('../queues/receiptQueue');
const emailService = require('../services/emailService');

// Stripe requires the exact raw bytes it signed -- if this ever runs after a
// JSON body parser, the signature will not match even for a legitimate event.
function constructEvent(req) {
  const signature = req.headers['stripe-signature'];
  return stripe.webhooks.constructEvent(req.body, signature, env.stripeWebhookSecret);
}

// Pulls the fields the rest of the system needs out of a Stripe object,
// independent of whether it arrived via checkout.session or payment_intent.
function extractOrderDetails(event) {
  const obj = event.data.object;

  const customerEmail =
    obj.customer_details?.email || obj.receipt_email || obj.customer_email || null;
  const customerName = obj.customer_details?.name || obj.shipping?.name || null;

  const amountTotal = obj.amount_total ?? obj.amount ?? 0;
  const currency = obj.currency || 'usd';

  const lineItems = (obj.line_items?.data || []).map((item) => ({
    description: item.description,
    quantity: item.quantity,
    amount: item.amount_total,
  }));

  return {
    eventId: event.id,
    eventType: event.type,
    objectId: obj.id,
    customerEmail,
    customerName,
    amountTotal,
    currency,
    lineItems,
    createdAt: new Date((event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

// Event types that represent a completed, payable purchase worth emailing
// a receipt for. Everything else (disputes, subscription lifecycle, etc.)
// is acknowledged with 200 but otherwise ignored by this handler.
const HANDLED_EVENT_TYPES = new Set(['checkout.session.completed', 'payment_intent.succeeded']);

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = constructEvent(req);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: Stripe may redeliver the same event (network retry, manual
  // resend from the dashboard, etc). Without this check a redelivery would
  // re-send the confirmation email and re-generate the receipt.
  if (orderStore.hasProcessedEvent(event.id)) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const order = extractOrderDetails(event);

  if (!order.customerEmail) {
    console.warn(`[webhook] event ${event.id} has no customer email, skipping`);
    orderStore.saveOrder(event.id, order);
    return res.status(200).json({ received: true, skipped: 'no_email' });
  }

  orderStore.saveOrder(event.id, order);

  try {
    await emailService.sendConfirmationEmail(order);
  } catch (err) {
    // Do not fail the webhook over an email delivery problem -- Stripe would
    // interpret a non-2xx as "retry", and the order is already recorded.
    // The PDF receipt job below still gets queued regardless.
    console.error(`[webhook] confirmation email failed for ${event.id}:`, err.message);
  }

  try {
    await receiptQueue.enqueueReceiptJob(order);
  } catch (err) {
    console.error(`[webhook] failed to enqueue receipt job for ${event.id}:`, err.message);
  }

  return res.status(200).json({ received: true });
}

module.exports = { handleStripeWebhook, extractOrderDetails, HANDLED_EVENT_TYPES };
