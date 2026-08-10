'use strict';
const express = require('express');
const {
  createStripeWebhook,
  createWebhookEventLog,
} = require('strata-composed');
const env = require('./config/env');
const { handleStripeEvent } = require('./services/purchase');

// Stripe webhook intake. Mounted ABOVE express.json() on purpose: the signature covers the raw request
// bytes, and once a JSON parser has run those bytes are gone. Re-serializing req.body produces a
// different HMAC and rejects every genuine delivery — the single most common Stripe integration bug.
//
// eventLog defaults to an in-process Map, which does NOT dedupe across replicas — behind a load
// balancer with more than one instance, swap this for a Redis-backed `seen()` (SETNX). Single-instance
// deployments (the assumed default here) are fine with the in-process version.
const stripeWebhookOptions = {
  // Never hardcoded: the signing secret is per-endpoint and rotates.
  secret: env.stripe.webhookSecret,
  path: env.stripe.webhookPath,
  // Stripe's own default. Lower it and legitimate deliveries fail on clock skew; raise it and a
  // captured request stays replayable for longer.
  toleranceSec: env.stripe.toleranceSec,
  eventLog: createWebhookEventLog(),
  onEvent: handleStripeEvent,
};

const app = express();

// TRUST PROXY — off by default, and that default is deliberate.
//
// Anything keyed on req.ip (rate limiting above all) is wrong behind a load balancer unless Express
// is told how many proxies to trust: req.ip becomes the PROXY's address, so every caller shares one
// bucket and the first burst 429s the entire internet. That is an outage, and it only appears in
// production.
//
// It is opt-in rather than automatic because the opposite mistake is worse: trusting
// X-Forwarded-For when nothing strips it lets any caller forge their own IP and bypass the limiter
// completely. Set TRUST_PROXY_HOPS to the number of proxies actually in front of this app —
// 1 behind a single nginx/ALB, 2 behind Cloudflare plus your own.
if (env.trustProxyHops) {
  app.set('trust proxy', env.trustProxyHops);
}

app.use(createStripeWebhook(stripeWebhookOptions));

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(env.port, () => console.log(`Server listening on port ${env.port}`));
