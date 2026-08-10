'use strict';
require('dotenv').config();
const express = require('express');
const {
  createStripeWebhook,
  createWebhookEventLog,
} = require('strata-composed');
const { handleStripeEvent } = require('./src/purchaseHandler');

// Redis-backed dedupe log: this process and the BullMQ worker are separate processes (and in
// production, likely separate replicas of this web server too), so the in-memory Map default
// would let two instances each handle one copy of the same Stripe retry. Reuses the same Redis
// connection BullMQ already needs, at the cost of one extra round trip per webhook delivery.
const { getRedisConnection } = require('./src/redis');
const { withTimeout } = require('./src/withTimeout');
const redis = getRedisConnection();

// This dedupe check runs on every webhook delivery, after Stripe's 200 was already sent. The
// shared Redis connection has no per-command retry ceiling (BullMQ needs that for its own
// blocking commands elsewhere), so without a timeout here a dead Redis would hang this check
// forever instead of just failing this one event.
const DEDUPE_TIMEOUT_MS = 5000;
const webhookEventLog = createWebhookEventLog({
  seen: async (id) => {
    // SET NX EX: only the first caller to write this key gets `1` back (not seen before);
    // everyone else gets `0`. Atomic, so two concurrent redeliveries can't both win.
    const result = await withTimeout(
      redis.set(`stripe:event:${id}`, '1', 'EX', 60 * 60 * 24 * 7, 'NX'),
      DEDUPE_TIMEOUT_MS,
      'redis dedupe check',
    );
    return result === null; // null means the key already existed -> already seen
  },
});

// Stripe webhook intake. Mounted ABOVE express.json() on purpose: the signature covers the raw request
// bytes, and once a JSON parser has run those bytes are gone. Re-serializing req.body produces a
// different HMAC and rejects every genuine delivery — the single most common Stripe integration bug.
const stripeWebhookOptions = {
  // Never hardcoded: the signing secret is per-endpoint and rotates.
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  path: process.env.STRIPE_WEBHOOK_PATH || '/webhooks/stripe',
  // Stripe's own default. Lower it and legitimate deliveries fail on clock skew; raise it and a
  // captured request stays replayable for longer.
  toleranceSec: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
  eventLog: webhookEventLog,
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
const server = app.listen(port, () => console.log(`Server listening on port ${port}`));

const shutdown = async () => {
  console.log('[server] shutting down...');
  server.close();
  await redis.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
