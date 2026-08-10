const orders = require('../db/orders');
const { enqueueReceiptJob } = require('../jobs/queue');
const { sendPurchaseConfirmationEmail } = require('./mailer');

/**
 * Handles a completed checkout: persists the order, fires the instant
 * confirmation email, and enqueues background PDF receipt generation.
 * Idempotent per stripe_session_id via the orders table UNIQUE constraint.
 */
async function handleCheckoutCompleted(session) {
  const order = orders.createOrGetBySessionId({
    stripeSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    customerEmail: session.customer_details?.email || session.customer_email,
    customerName: session.customer_details?.name || null,
    amountTotal: session.amount_total,
    currency: session.currency,
    description: session.metadata?.description || null,
  });

  if (!order.customer_email) {
    throw new Error(`Checkout session ${session.id} has no customer email; cannot send receipt`);
  }

  await sendPurchaseConfirmationEmail(order);
  await enqueueReceiptJob(order.id);

  return order;
}

module.exports = { handleCheckoutCompleted };
