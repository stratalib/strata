'use strict';

const { getStripeClient } = require('./stripeClient');
const { getMailer } = require('./mailer');
const { enqueueReceiptJob } = require('./queue');
const { formatMoney } = require('./receiptPdf');
const { withTimeout } = require('./withTimeout');

const ENQUEUE_TIMEOUT_MS = 5000;

/** Pull `{ description, quantity, unitAmount }` line items for a Checkout Session. Falls back to
 *  a single synthetic line ("Purchase") if Stripe has no line items (e.g. a PaymentIntent-only
 *  flow) — a receipt with no rows looks broken, one row with the total does not. */
async function fetchLineItems(session) {
  try {
    const stripe = getStripeClient();
    const { data } = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    if (data.length > 0) {
      return data.map((li) => ({
        description: li.description || 'Item',
        quantity: li.quantity || 1,
        unitAmount: li.quantity ? Math.round(li.amount_total / li.quantity) : li.amount_total,
      }));
    }
  } catch (err) {
    console.error(`[purchase] could not fetch line items for ${session.id}: ${err.message}`);
  }
  return [{
    description: 'Purchase',
    quantity: 1,
    unitAmount: session.amount_total || 0,
  }];
}

/**
 * Handles `checkout.session.completed`. Called from the webhook's onEvent, which runs AFTER
 * Stripe already has its 200 — so this can take as long as it needs, but a throw here does NOT
 * make Stripe retry (see strata/lib.js). Both steps below have their own retry/durability:
 * the immediate email retries in-process (createMailer), the receipt survives a process crash
 * because it is a durable BullMQ job.
 */
async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;

  const customerEmail = session.customer_details && session.customer_details.email;
  if (!customerEmail) {
    console.error(`[purchase] event ${event.id}: no customer email on session ${session.id}, skipping`);
    return;
  }
  const customerName = session.customer_details && session.customer_details.name;
  const currency = session.currency || 'usd';
  const totalAmount = session.amount_total || 0;

  const mailer = getMailer();
  const confirmResult = await mailer.send({
    idempotencyKey: `purchase-confirmation:${event.id}`,
    to: customerEmail,
    subject: 'Purchase confirmed',
    text: `Hi${customerName ? ' ' + customerName : ''},\n\n`
      + `We've received your payment of ${formatMoney(totalAmount, currency)}. `
      + `A detailed PDF receipt will follow shortly in a separate email.\n\n`
      + `Thank you for your purchase.`,
  });
  if (!confirmResult.ok) {
    console.error(`[purchase] event ${event.id}: confirmation email failed: ${confirmResult.error && confirmResult.error.message}`);
  }

  const lineItems = await fetchLineItems(session);

  // Timeout-guarded: if Redis is unreachable this throws instead of hanging. The confirmation
  // email above has already been sent either way — losing the receipt job is a support ticket,
  // hanging this handler forever is a slow leak of one promise per missed purchase.
  await withTimeout(
    enqueueReceiptJob({
      eventId: event.id,
      receiptNumber: session.id,
      purchasedAt: new Date((event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      customerName: customerName || null,
      customerEmail,
      currency,
      lineItems,
      totalAmount,
      paymentMethodLabel: session.payment_method_types && session.payment_method_types[0],
    }),
    ENQUEUE_TIMEOUT_MS,
    'enqueue receipt job',
  );
}

/** Dispatch table — only checkout.session.completed drives a purchase today, but the shape keeps
 *  adding a second event type a one-line change instead of a rewrite. */
async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutSessionCompleted(event);
    default:
      console.log(`[purchase] ignoring unhandled event type ${event.type}`);
  }
}

module.exports = { handleStripeEvent, handleCheckoutSessionCompleted };
