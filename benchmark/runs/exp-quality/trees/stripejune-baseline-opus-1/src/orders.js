'use strict';

const store = require('./store');
const mailer = require('./mailer');
const queue = require('./queue');

// Indirection so tests can substitute the enqueue function without a live
// Redis. Defaults to the real BullMQ enqueue.
let enqueue = queue.enqueueReceiptJob;
function setEnqueue(fn) {
  enqueue = fn || queue.enqueueReceiptJob;
}

// Translate a Stripe Checkout Session into our internal order shape. Keeping
// this mapping in one function means the rest of the code never has to know
// Stripe's field names.
function orderFromCheckoutSession(session) {
  const details = session.customer_details || {};
  const order = {
    id: session.id,
    paymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent && session.payment_intent.id,
    customerEmail:
      details.email || session.customer_email || null,
    customerName: details.name || null,
    amountTotal: session.amount_total,
    currency: session.currency,
    paidAt: Date.now(),
    lineItems: extractLineItems(session),
  };
  return order;
}

// Line items are only present if the webhook payload expanded them. If not, the
// receipt falls back to a single summary line (handled in receipt.js).
function extractLineItems(session) {
  const li = session.line_items && session.line_items.data;
  if (!Array.isArray(li)) return null;
  return li.map((item) => ({
    description: item.description || (item.price && item.price.nickname) || 'Item',
    quantity: item.quantity || 1,
    amount: item.amount_total != null ? item.amount_total : item.amount_subtotal,
  }));
}

// Handle a verified checkout.session.completed event end to end:
//   - guard against duplicate delivery (idempotency)
//   - persist the order
//   - send the immediate confirmation email
//   - enqueue the background receipt job
// Returns a small result object describing what happened, useful for tests and
// logging.
async function handleCheckoutCompleted(event) {
  // Idempotency: Stripe retries webhooks. Only the first delivery of a given
  // event id does the work; repeats short-circuit.
  if (!store.markEventProcessed(event.id)) {
    return { status: 'duplicate', eventId: event.id };
  }

  const session = event.data.object;

  // Only fulfil sessions that are actually paid. A session can complete in
  // other states (e.g. async payment pending); don't ship receipts for those.
  if (session.payment_status && session.payment_status !== 'paid') {
    return { status: 'unpaid', eventId: event.id, paymentStatus: session.payment_status };
  }

  const order = orderFromCheckoutSession(session);

  if (!order.customerEmail) {
    // Persist so the purchase isn't lost, but we can't email without an address.
    store.saveOrder(order);
    return { status: 'no_email', orderId: order.id };
  }

  store.saveOrder(order);

  // Confirmation email is sent inline (fast, no attachment). If it throws we
  // let it propagate so the webhook returns non-2xx and Stripe retries.
  await mailer.sendConfirmationEmail(order);

  // The slow part — PDF + receipt email — goes to the background queue.
  await enqueue(order);

  return { status: 'processed', orderId: order.id };
}

module.exports = {
  orderFromCheckoutSession,
  extractLineItems,
  handleCheckoutCompleted,
  setEnqueue,
};
