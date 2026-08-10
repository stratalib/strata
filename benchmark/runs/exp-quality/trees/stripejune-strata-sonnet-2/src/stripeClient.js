'use strict';

const Stripe = require('stripe');

let client = null;

/** The `stripe` SDK is used only for authenticated API calls (fetching line items) — webhook
 *  signature verification is handled separately, without this SDK, in strata/lib.js. */
function getStripeClient() {
  if (client) return client;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

module.exports = { getStripeClient };
