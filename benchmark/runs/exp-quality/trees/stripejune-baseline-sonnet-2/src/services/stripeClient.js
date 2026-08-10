const Stripe = require('stripe');
const { env } = require('../config/env');

let stripe = null;

// Lazy construction: the Stripe SDK throws immediately if given an empty key,
// which would crash module load (and therefore every test) in any environment
// that hasn't set real Stripe credentials yet. A Proxy defers that check
// until the first actual method call (e.g. stripe.webhooks.constructEvent).
function getStripeClient() {
  if (!stripe) {
    // constructEvent() (webhook signature verification) never calls the
    // Stripe API and doesn't need a real key -- only charges/refunds/etc.
    // would. The placeholder lets webhook handling and its tests run without
    // real Stripe credentials configured.
    stripe = new Stripe(env.stripeSecretKey || 'sk_test_placeholder', {
      apiVersion: '2024-12-18.acacia',
    });
  }
  return stripe;
}

const lazyStripe = new Proxy(
  {},
  {
    get(_target, prop) {
      return getStripeClient()[prop];
    },
  }
);

module.exports = lazyStripe;
