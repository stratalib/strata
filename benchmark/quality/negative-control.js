#!/usr/bin/env node
'use strict';
/**
 * NEGATIVE CONTROL — proof that the acceptance suite can actually fail.
 *
 * A check that cannot fail is not a check. This project has been bitten by exactly that: an HTTP
 * check for full-text search PASSED against deliberately broken code, because the route it probed came
 * from the pagination recall and never called search() at all. It was only caught by planting the bug
 * and watching the check stay green.
 *
 * So every check in suites.js is exercised twice here:
 *   1. against a REFERENCE app that implements the task correctly  → the check must PASS
 *   2. against that same app with ONE property deliberately broken → that check must FAIL
 *
 * A check that passes both times measures nothing and is reported as BROKEN. A check that fails both
 * times is unsatisfiable and equally useless. Only a check that discriminates is trustworthy, and the
 * suite's grade is only meaningful for checks that pass this file.
 *
 *   node benchmark/quality/negative-control.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gradeDir, SUITE_HASH } = require('./grade.js');

// 200 products, so "limit=999999 dumped the whole table" (>100 rows) is detectable.
const SEED = `
const PRODUCTS = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1, sku: 'SKU-' + String(i + 1).padStart(5, '0'), name: 'Product ' + (i + 1),
  price: (i * 7) % 500, quantity: i % 200, category: 'HOME', active: i % 7 !== 0,
}));
`;

/** The correct catalog app. Every mutation below removes exactly one property of THIS. */
function catalogApp(m = {}) {
  return `'use strict';
const express = require('express');
const crypto = require('crypto');
${SEED}
const app = express();

// request id
app.use((req, res, next) => {
  req.id = ${m.constantRequestId ? "'fixed-id-0000'" : 'crypto.randomUUID()'};
  res.setHeader('X-Request-Id', req.id);
  console.log(JSON.stringify({ level: 'info', reqId: req.id, method: req.method, url: req.url }));
  next();
});

// token bucket, per IP
const buckets = new Map();
const CAPACITY = 30, REFILL_PER_SEC = 10;
app.use((req, res, next) => {
${m.noRateLimit ? '  return next();' : `  const ip = req.ip || 'x';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: CAPACITY, ts: now }; buckets.set(ip, b); }
${m.noRefill ? '  // BUG: never refills' : '  const elapsed = (now - b.ts) / 1000;\n  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * REFILL_PER_SEC);'}
  b.ts = now;
  if (b.tokens < 1) return res.status(429).json({ error: 'rate limited' });
  b.tokens -= 1;
  return next();`}
});

app.use(express.json());

app.get('/products', (req, res) => {
${m.ignoreLimit
  ? '  return res.json({ data: PRODUCTS });'
  : `  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
${m.noClamp ? '  // BUG: caller controls the page size without bound' : '  limit = Math.min(limit, 100);'}
${m.page2RepeatsPage1
    ? '  const offset = 0; // BUG: offset ignored, page 2 re-serves page 1'
    : '  let offset = parseInt(req.query.offset, 10);\n  if (!Number.isFinite(offset) || offset < 0) offset = 0;'}
  return res.json({ data: PRODUCTS.slice(offset, offset + limit), total: PRODUCTS.length });`}
});

app.post('/products', (req, res) => res.status(201).json({ ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));

${m.noJsonErrorHandler ? '' : `app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON' });
  return next(err);
});`}

app.listen(process.env.PORT || 3000, () => console.log('listening'));
`;
}

/** The correct idempotent-orders app. */
function idempotencyApp(m = {}) {
  return `'use strict';
const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const store = new Map();     // key -> { fingerprint, response, inflight }
let nextId = 1;

const fingerprint = (b) => crypto.createHash('sha1').update(JSON.stringify(b || {})).digest('hex');

app.post('/orders', async (req, res) => {
  console.log(JSON.stringify({ level: 'info', msg: 'order attempt', url: req.url, at: Date.now() }));
  const key = req.get('Idempotency-Key') || req.get('X-Idempotency-Key');
  const body = req.body || {};

${m.noValidation ? '  // BUG: no validation' : `  if (!body.sku || typeof body.sku !== 'string') return res.status(422).json({ error: 'sku required' });
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) return res.status(422).json({ error: 'quantity must be a positive integer' });`}

${m.ignoreKey ? '  // BUG: key ignored, every call creates a new order' : `  if (key) {
    const prior = store.get(key);
    if (prior) {
${m.acceptDifferentBody
      ? '      return res.status(200).json(prior.response); // BUG: replays regardless of body'
      : `      if (prior.fingerprint !== fingerprint(body)) {
        return res.status(422).json({ error: 'idempotency key reused with a different body' });
      }
      if (prior.inflight) return res.status(409).json({ error: 'in flight' });
      return res.status(200).json(prior.response);`}
    }
${m.raceyReserve
      // The gap must outlast the arrival of the second request, or the race cannot be observed at all.
      // setImmediate was too short: request 1 ran to completion and stored its order before request 2
      // even reached the check, so both saw a consistent store and the mutation looked correct. A real
      // check-then-write window is milliseconds wide, not microseconds.
      ? '    // BUG: check-then-write with a gap; two concurrent calls both pass the check above\n    await new Promise(r => setTimeout(r, 50));'
      : "    store.set(key, { fingerprint: fingerprint(body), response: null, inflight: true });"}
  }`}

  const order = { id: nextId++, sku: body.sku, quantity: body.quantity, status: 'created' };
${m.ignoreKey ? '' : '  if (key) store.set(key, { fingerprint: fingerprint(body), response: order, inflight: false });'}
  return res.status(201).json(order);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

${m.noJsonErrorHandler ? '' : `app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON' });
  return next(err);
});`}

app.listen(process.env.PORT || 3000, () => console.log('listening'));
`;
}

// mutation → the check it must break
/**
 * Reference Stripe-webhook app: correct on every property the stripejune suite grades.
 *
 * Deliberately has NO Redis, NO SMTP and NO PDF library — this machine has none of them, and the suite
 * was written not to need them. The queue is a setImmediate and the "receipt" is a log line, because
 * what P7 grades is that the heavy work is DEFERRED, not what the work happens to be.
 */
function stripejuneApp(m = {}) {
  return `
const express = require('express');
const crypto = require('crypto');
const app = express();
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const TOLERANCE = 300;                       // seconds; Stripe's own default
const seen = new Set();                      // event.id -> already handled

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// express.raw, not express.json: the signature is over the BYTES Stripe sent. Parsing first and
// re-serializing is the canonical way to get this wrong.
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = ${m.reserializeBody
      ? 'JSON.stringify(JSON.parse(req.body.toString("utf8")))'
      : 'req.body.toString("utf8")'};
  const header = req.get('Stripe-Signature') || '';

  ${m.noSigCheck ? '' : `
  if (!header) return res.status(400).json({ error: 'missing signature' });
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return res.status(400).json({ error: 'malformed signature' });
  ${m.noTimestampCheck ? '' : `
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > TOLERANCE) {
    return res.status(400).json({ error: 'timestamp outside tolerance' });
  }`}
  ${m.weakSigCheck ? '' : `
  const expected = crypto.createHmac('sha256', SECRET).update(parts.t + '.' + raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(parts.v1));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).json({ error: 'signature mismatch'${m.leakSecret
      ? ", expected, secret: SECRET" : ''} });
  }`}
  `}

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid json' }); }

  ${m.noDedupe ? '' : `
  if (seen.has(event.id)) {
    // Acknowledge — Stripe must not be told to retry — but do no work. Worded so it cannot be
    // mistaken for a unit of work by a log-delta reader.
    console.log('[webhook] duplicate ' + event.id + ' ignored');
    return res.json({ received: true, duplicate: true });
  }
  seen.add(event.id);`}

  ${m.inlineHeavyWork
      ? `// The defect: PDF + SMTP inline, so Stripe waits and eventually gives up and retries.
  await sleep(4000);
  console.log('[webhook] generated pdf receipt and emailed it for ' + event.id);
  res.json({ received: true });`
      : `// Answer Stripe first; the receipt job runs after the response is on the wire.
  res.json({ received: true });
  setImmediate(() => console.log('[webhook] queued receipt job for ' + event.id));`}
});

app.use((err, _req, res, _next) => res.status(400).json({ error: 'bad request' }));
app.listen(process.env.PORT || 3000, () => console.log('listening'));
`;
}

const STRIPEJUNE_MUTATIONS = [
  ['noSigCheck', 'P2-unsigned-rejected'],
  ['weakSigCheck', 'P3-forged-signature-rejected'],
  ['reserializeBody', 'P4-raw-body-verification'],
  ['noTimestampCheck', 'P5-replay-window-enforced'],
  ['noDedupe', 'P6-duplicate-event-once'],
  ['inlineHeavyWork', 'P7-webhook-answers-promptly'],
  ['leakSecret', 'P8-no-secret-or-stack-leak'],
];

/**
 * Reference retry helper: correct on every property the retry suite grades.
 *
 * Exported under a deliberately ORDINARY name with an ordinary signature, because the point of the
 * control is to prove the checks discriminate — not to prove the discovery can find something exotic.
 */
function retryApp(m = {}) {
  return `
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(url) {
  return new Promise((resolve, reject) => {
    const rq = http.get(url, (rs) => {
      rs.resume();
      rs.on('end', () => {
        if (rs.statusCode >= 400) {
          const e = new Error('HTTP ' + rs.statusCode);
          e.status = rs.statusCode;
          return reject(e);
        }
        resolve(rs.statusCode);
      });
    });
    rq.on('error', reject);
  });
}

async function fetchWithRetry(url, opts = {}) {
  const maxAttempts = opts.maxAttempts || 4;
  const base = opts.baseDelayMs || 60;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOnce(url);
    } catch (err) {
      lastErr = err;
      ${m.retryEverything ? '' : `
      // A 4xx means the REQUEST is wrong — retrying cannot ever make it right.
      if (err.status && err.status >= 400 && err.status < 500) throw err;`}
      if (attempt === maxAttempts) break;
      ${m.noWait ? '// defect: no delay at all'
      : m.constantDelay ? 'await sleep(base);'
      : 'await sleep(base * Math.pow(2, attempt - 1));'}
    }
  }
  ${m.swallowError ? 'return undefined;' : 'throw lastErr;'}
}

module.exports = { fetchWithRetry };
`;
}

const RETRY_MUTATIONS = [
  ['retryEverything', 'R5-no-retry-on-4xx'],
  ['noWait', 'R3-actually-waits'],
  ['constantDelay', 'R4-backoff-grows'],
  ['swallowError', 'R6-surfaces-the-failure'],
];

const CATALOG_MUTATIONS = [
  ['ignoreLimit', 'C2-limit-respected'],
  ['page2RepeatsPage1', 'C3-page2-disjoint'],
  ['noClamp', 'C4-hostile-paging-input'],
  ['noRateLimit', 'C5-ratelimit-triggers'],
  ['noRefill', 'C6-ratelimit-refills'],
  ['constantRequestId', 'C7-request-id-traceable'],
  ['noJsonErrorHandler', 'C8-malformed-json'],
];

const IDEMPOTENCY_MUTATIONS = [
  ['ignoreKey', 'I2-replay-deduplicates'],
  ['acceptDifferentBody', 'I3-same-key-different-body'],
  ['noJsonErrorHandler', 'I4-malformed-json'],
  ['noValidation', 'I5-validation-rejects-bad-body'],
  ['raceyReserve', 'I6-concurrent-duplicate'],
];

function makeApp(suite, mutation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nc-${suite}-`));
  const mut = mutation ? { [mutation]: true } : {};
  const src = suite === 'catalog' ? catalogApp(mut)
    : suite === 'stripejune' ? stripejuneApp(mut)
      : suite === 'retry' ? retryApp(mut)
        : idempotencyApp(mut);
  fs.writeFileSync(path.join(dir, 'server.js'), src);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'nc', version: '1.0.0', private: true, scripts: { start: 'node server.js' },
    dependencies: { express: '^4.18.0' },
  }, null, 2));
  // Reuse this repo's express rather than installing per app.
  fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

(async () => {
  console.log(`=== NEGATIVE CONTROL (suite ${SUITE_HASH}) ===\n`);
  const verdicts = [];

  for (const [suite, mutations] of [['catalog', CATALOG_MUTATIONS], ['idempotency', IDEMPOTENCY_MUTATIONS],
    ['stripejune', STRIPEJUNE_MUTATIONS], ['retry', RETRY_MUTATIONS]]) {
    console.log(`--- ${suite} ---`);
    const cleanDir = makeApp(suite, null);
    const clean = await gradeDir(cleanDir, suite);
    console.log(`reference (correct) app: ${clean.passed}/${clean.total} passed`
      + (clean.booted ? '' : `  BOOT FAILED: ${clean.bootReason}`));
    for (const r of clean.results) if (!r.pass) console.log(`   reference FAILS ${r.id}: ${r.detail}`);

    for (const [mutation, targetCheck] of mutations) {
      const dir = makeApp(suite, mutation);
      const g = await gradeDir(dir, suite);
      const target = g.results.find(r => r.id === targetCheck);
      const cleanTarget = clean.results.find(r => r.id === targetCheck);

      const discriminates = cleanTarget && cleanTarget.pass && target && !target.pass;
      verdicts.push({ suite, mutation, targetCheck, discriminates });
      console.log(`  ${discriminates ? 'OK  ' : 'BAD '} ${targetCheck.padEnd(32)} `
        + `clean=${cleanTarget ? (cleanTarget.pass ? 'pass' : 'FAIL') : '?'} `
        + `mutated=${target ? (target.pass ? 'PASS(!!)' : 'fail') : '?'}   [${mutation}]`
        + (discriminates ? '' : `  <- ${target ? target.detail : 'no result'}`));
    }
    console.log();
  }

  const bad = verdicts.filter(v => !v.discriminates);
  if (bad.length === 0) {
    console.log(`ALL ${verdicts.length} checks discriminate. The suite can fail, and does, for the right reason.`);
  } else {
    console.log(`${bad.length}/${verdicts.length} checks DO NOT discriminate — their grades mean nothing until fixed:`);
    for (const b of bad) console.log(`  ${b.suite} ${b.targetCheck} (mutation: ${b.mutation})`);
    process.exitCode = 1;
  }
})();
