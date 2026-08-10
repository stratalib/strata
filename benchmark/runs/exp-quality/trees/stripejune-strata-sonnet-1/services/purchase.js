'use strict';
const { mailer } = require('../config/mailer');
const { enqueueReceipt } = require('../queue/receiptQueue');
const env = require('../config/env');

// Stripe fires several event types per checkout depending on payment method (card = instant,
// bank debit = delayed). We only treat these two as "the money is confirmed" — anything else
// (payment_intent.created, charge.updated, etc.) is ignored here rather than mishandled.
const HANDLED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'payment_intent.succeeded',
]);

/** Pull a normalized purchase record out of the two event shapes we handle. Stripe's object shapes
 *  differ enough between checkout.session and payment_intent that a single flat mapper would be
 *  wrong for one of them, so each gets its own extractor. */
function extractPurchase(event) {
  const obj = event.data && event.data.object ? event.data.object : {};

  if (event.type === 'checkout.session.completed') {
    const email = obj.customer_details?.email || obj.customer_email || null;
    if (!email) return null;
    return {
      orderId: obj.id,
      email,
      customerName: obj.customer_details?.name || null,
      amount: obj.amount_total ?? 0,
      currency: (obj.currency || 'usd').toUpperCase(),
      items: null, // line items require a separate Stripe API call (session.list_line_items); out of scope without the `stripe` SDK wired in
      purchasedAt: new Date((event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  if (event.type === 'payment_intent.succeeded') {
    const email = obj.receipt_email || null;
    if (!email) return null;
    return {
      orderId: obj.id,
      email,
      customerName: obj.shipping?.name || null,
      amount: obj.amount_received ?? obj.amount ?? 0,
      currency: (obj.currency || 'usd').toUpperCase(),
      items: null,
      purchasedAt: new Date((event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  return null;
}

function formatMoney(amountMinorUnits, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinorUnits / 100);
}

/**
 * Runs after Stripe's webhook delivery has already been acknowledged (see server.js). Two
 * side effects, both best-effort and independent of each other: send the confirmation now,
 * queue the PDF receipt for the background worker.
 */
async function handleStripeEvent(event) {
  if (!HANDLED_EVENT_TYPES.has(event.type)) return;

  const purchase = extractPurchase(event);
  if (!purchase) {
    console.warn(`[purchase] ${event.type} ${event.id} has no usable customer email — skipping`);
    return;
  }

  const confirmation = await mailer.send({
    idempotencyKey: `confirmation:${purchase.orderId}`,
    to: purchase.email,
    subject: `Your ${env.company.name} order is confirmed`,
    text:
      `Hi${purchase.customerName ? ' ' + purchase.customerName : ''},\n\n` +
      `Thanks for your purchase! We've received payment of ${formatMoney(purchase.amount, purchase.currency)}.\n\n` +
      `Order reference: ${purchase.orderId}\n\n` +
      `Your PDF receipt will follow in a separate email shortly.\n\n` +
      `${env.company.name}\n${env.company.supportEmail}`,
  });
  if (!confirmation.ok) {
    console.error(`[purchase] confirmation email failed for order ${purchase.orderId}:`, confirmation.error?.message);
  }

  try {
    await enqueueReceipt(purchase);
  } catch (err) {
    // The confirmation email already went out; a queue failure here must not look like the whole
    // purchase failed. Logged loudly because a receipt the customer never gets is a support ticket.
    console.error(`[purchase] failed to enqueue receipt job for order ${purchase.orderId}:`, err.message);
  }
}

module.exports = { handleStripeEvent, extractPurchase, formatMoney };
