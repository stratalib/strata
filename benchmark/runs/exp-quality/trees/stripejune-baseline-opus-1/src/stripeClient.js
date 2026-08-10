'use strict';

const Stripe = require('stripe');
const { config } = require('./config');

// One shared Stripe client. Constructing it without a key is fine for tests
// that only exercise webhook signature verification (which uses the webhook
// secret, not the API key).
const stripe = new Stripe(config.stripe.secretKey || 'sk_test_placeholder', {
  apiVersion: '2024-12-18.acacia',
});

// Verify and parse a webhook. Throws if the signature is missing/invalid or the
// payload doesn't match. `rawBody` MUST be the exact bytes Stripe sent — a
// Buffer or string — not a re-serialized object.
function constructEvent(rawBody, signatureHeader) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    config.stripe.webhookSecret
  );
}

module.exports = { stripe, constructEvent };
