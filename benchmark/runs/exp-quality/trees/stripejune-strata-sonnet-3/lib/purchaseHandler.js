'use strict';
const Stripe = require('stripe');
const { mailer } = require('./mailer');
const { enqueueReceipt } = require('../queue/receiptQueue');
const orderStore = require('./orderStore');

let stripeClient = null;
function getStripeClient() {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set — cannot fetch line items for a checkout session');
    }
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

/**
 * Handle a verified `checkout.session.completed` event.
 *
 * Split into two effects deliberately:
 *   1. An immediate, best-effort confirmation email — the customer should hear "we got it" within
 *      seconds, not whenever the PDF worker gets a free cycle.
 *   2. A queued receipt job (PDF generation + a second email with the attachment) — this can take
 *      real time and involves a second dependency (Redis), so it must not block or fail the webhook
 *      handler itself. Runs AFTER Stripe already has its 200 (see server.js), so retrying internally
 *      on failure is fine — nothing is waiting on it.
 */
async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  const sessionId = session.id;
  const customerEmail = session.customer_details && session.customer_details.email
    ? session.customer_details.email
    : session.customer_email;
  const customerName = session.customer_details && session.customer_details.name
    ? session.customer_details.name
    : null;

  if (!customerEmail) {
    console.error(`[purchase] session ${sessionId} has no customer email — cannot send confirmation or receipt`);
    return;
  }

  let lineItems = [];
  try {
    const stripe = getStripeClient();
    const list = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
    lineItems = list.data.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      amountTotal: li.amount_total,
    }));
  } catch (err) {
    // Line items are a nice-to-have on the receipt, not a reason to abandon the purchase record.
    // Fall back to a single summary line built from the session total.
    console.error(`[purchase] could not fetch line items for ${sessionId}: ${err.message}`);
  }

  const order = orderStore.upsertOrder(sessionId, {
    customerEmail,
    customerName,
    currency: session.currency,
    amountTotal: session.amount_total,
    lineItems,
    status: 'paid',
  });

  const confirmResult = await mailer.send({
    to: customerEmail,
    idempotencyKey: `confirmation:${sessionId}`,
    subject: 'Purchase confirmed',
    text: `Hi${customerName ? ' ' + customerName : ''},\n\nWe've received your payment. Your receipt will follow in a separate email shortly.\n`,
    html: `<p>Hi${customerName ? ' ' + customerName : ''},</p><p>We've received your payment. Your receipt will follow in a separate email shortly.</p>`,
  });
  if (!confirmResult.ok) {
    console.error(`[purchase] confirmation email dead-lettered for ${sessionId}: ${confirmResult.error && confirmResult.error.message}`);
  }

  await enqueueReceipt({
    sessionId,
    customerEmail,
    customerName,
    currency: order.currency,
    amountTotal: order.amountTotal,
    lineItems: order.lineItems,
  });
}

async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionCompleted(event);
    default:
      console.log(`[purchase] ignoring unhandled event type ${event.type}`);
  }
}

module.exports = { handleStripeEvent, handleCheckoutSessionCompleted };
