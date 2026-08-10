'use strict';
const crypto = require('crypto');

// Create a valid Stripe webhook signature for testing.
function createTestSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedContent = timestamp + '.' + rawBody;
  const signature = crypto.createHmac('sha256', secret).update(signedContent).digest('hex');
  return {
    header: `t=${timestamp},v1=${signature}`,
    timestamp,
  };
}

// Create a mock Stripe checkout.session.completed event.
function createCheckoutSessionEvent(overrides = {}) {
  const sessionId = `cs_${Math.random().toString(36).slice(2)}`;
  const event = {
    id: `evt_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: overrides.amount_total || 2999, // $29.99
        currency: overrides.currency || 'usd',
        customer_email: overrides.customer_email || 'customer@example.com',
        payment_intent: `pi_${Math.random().toString(36).slice(2)}`,
        status: 'complete',
        metadata: overrides.metadata || {},
        ...overrides.session,
      },
    },
  };
  return event;
}

module.exports = {
  createTestSignature,
  createCheckoutSessionEvent,
};
