'use strict';

const Stripe = require('stripe');

// A test transport that records every sendMail call instead of sending.
function makeFakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(message) {
      sent.push(message);
      return { messageId: `fake-${sent.length}`, accepted: [message.to] };
    },
  };
}

// Build a minimal checkout.session.completed event object.
function makeCheckoutEvent(overrides = {}) {
  const session = Object.assign(
    {
      id: 'cs_test_123',
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: 'pi_test_123',
      amount_total: 4200,
      currency: 'usd',
      customer_email: null,
      customer_details: { email: 'buyer@example.com', name: 'Jane Buyer' },
      line_items: {
        data: [
          {
            description: 'Widget Pro',
            quantity: 2,
            amount_total: 4200,
          },
        ],
      },
    },
    overrides.session || {}
  );

  return {
    id: overrides.id || 'evt_test_123',
    type: overrides.type || 'checkout.session.completed',
    data: { object: session },
  };
}

// Produce a real, valid Stripe signature header for a raw payload, using the
// same signing scheme Stripe uses. This lets us test verification for real.
function signPayload(rawBody, secret) {
  const stripe = new Stripe('sk_test_placeholder');
  return stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret,
  });
}

module.exports = { makeFakeTransport, makeCheckoutEvent, signPayload };
