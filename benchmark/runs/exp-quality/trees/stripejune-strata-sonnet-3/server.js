'use strict';
require('dotenv').config();
const express = require('express');
const {
  createStripeWebhook,
  createWebhookEventLog,
} = require('strata-composed');
const { handleStripeEvent } = require('./lib/purchaseHandler');

// Stripe webhook intake. Mounted ABOVE express.json() on purpose: the signature covers the raw request
// bytes, and once a JSON parser has run those bytes are gone. Re-serializing req.body produces a
// different HMAC and rejects every genuine delivery — the single most common Stripe integration bug.
//
// onEvent runs AFTER Stripe has been acknowledged (see createStripeWebhook in strata/lib.js), so it
// may take as long as it needs. It sends the confirmation email and enqueues the receipt job — see
// lib/purchaseHandler.js.
//
// eventLog defaults to an in-process Map, which does NOT dedupe across replicas — fine for a single
// instance, but behind a load balancer two instances would each handle one redelivery once. Swapping
// in Redis-backed dedupe (SETNX on the event id) is the natural next step if this ever runs scaled out.
const stripeWebhookOptions = {
  // Never hardcoded: the signing secret is per-endpoint and rotates.
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  path: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
  // Stripe's own default. Lower it and legitimate deliveries fail on clock skew; raise it and a
  // captured request stays replayable for longer.
  toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  eventLog: createWebhookEventLog(),
  onEvent: async (event) => {
    console.log(`[stripe-webhook] handling ${event.type} ${event.id}`);
    await handleStripeEvent(event);
  },
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
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

app.use(createStripeWebhook(stripeWebhookOptions));

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
const httpServer = app.listen(port, () => console.log(`Server listening on port ${port}`));

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  const { smtpTransporter } = require('./lib/mailer');
  if (smtpTransporter) smtpTransporter.close();
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
