'use strict';
require('dotenv').config();
const express = require('express');
const {
  CircuitOpenError,
  HttpError,
  createHttpClient,
  createMailer,
} = require('strata-composed');


// Outbound transactional email. NOTE the default: with no MAIL_TRANSPORT configured this records
// messages instead of sending them, so this app cannot email real users from a staging box or a test
// run. You opt IN to delivery by supplying a transport below.
//
// INJECT: to actually send, pass a transport — any `async (message) => any`. The message carries
// { from, to, cc, bcc, subject, text, html, headers, attachments }, all validated and rendered.
//
//   const nodemailer = require('nodemailer');
//   const smtp = nodemailer.createTransport({ url: process.env.SMTP_URL });
//   transport: async (msg) => smtp.sendMail({
//     from: msg.from.address, to: msg.to.map(t => t.address).join(', '),
//     subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments,
//   }),
//
// Resend / SES / Postmark are the same three lines against their own SDK.
const mailer = createMailer({
  from: process.env.MAIL_FROM || 'no-reply@example.com',
  maxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS || 3),
  baseBackoffMs: Number(process.env.MAIL_BACKOFF_MS || 500),
  // INJECT: dead letters are the mail nobody received. In production this should reach something
  // durable — a table, a queue, an alert — not just this process's memory.
  //   onDeadLetter: async (record) => { await db.failedEmail.create({ data: record }); },
});

// One client per upstream. Each gets its OWN circuit breaker — a shared breaker would let a dead
// vendor take down calls to a perfectly healthy one.
//
// baseUrl falls back to a local default rather than passing `undefined` straight through. Without it,
// an unset UPSTREAM_URL produces `new URL(path, undefined)` and the app dies at the first request with
// an opaque error — and a session had to notice and patch that by hand before it could run anything.
// A scaffold that cannot boot on a fresh checkout is not a scaffold.
const upstream = createHttpClient({
  baseUrl: process.env.UPSTREAM_URL || 'http://localhost:4000',
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),   // per ATTEMPT, not for the whole call
  retries: Number(process.env.UPSTREAM_RETRIES || 3),
  headers: process.env.UPSTREAM_KEY ? { authorization: `Bearer ${process.env.UPSTREAM_KEY}` } : {},
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
});

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

app.use(express.json());


// INJECT: add the routes that actually call the upstream.
app.get('/proxy/:id', async (req, res, next) => {
  try {
    res.json(await upstream.get(`/items/${req.params.id}`));
  } catch (err) {
    // 503 + Retry-After, not 500: an open circuit is a TEMPORARY condition, and saying so lets the
    // caller back off instead of retrying us into the ground.
    if (err instanceof CircuitOpenError) {
      res.set('retry-after', String(Math.ceil(err.msRemaining / 1000)));
      return res.status(503).json({ error: 'upstream unavailable', retryInMs: err.msRemaining });
    }
    next(err);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
