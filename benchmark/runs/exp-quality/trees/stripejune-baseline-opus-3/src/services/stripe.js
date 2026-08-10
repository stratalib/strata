'use strict';

const Stripe = require('stripe');
const config = require('../config');

/**
 * Single configured Stripe client + a thin wrapper around signature
 * verification. Wrapping constructEvent (rather than calling it inline in the
 * route) keeps the route testable: tests can stub this module without needing
 * a real Stripe secret to forge a valid signature.
 */

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-12-18.acacia',
});

/**
 * Verify the webhook signature and return the parsed event.
 *
 * `rawBody` MUST be the exact bytes Stripe sent — a Buffer, not parsed JSON.
 * Stripe signs the raw payload; any re-serialization changes the bytes and the
 * signature check fails. This throws if verification fails, and the caller
 * turns that into a 400.
 */
function constructEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

module.exports = { stripe, constructEvent };
