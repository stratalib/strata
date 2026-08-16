#!/usr/bin/env node
'use strict';
// Selection regression test.
//
// The semantic scorer leaks: it has delivered a CSV importer into a pino-logging task and a Valibot
// validator into an HTTP-retry task, purely on shared vocabulary. Every leak costs the session real
// turns to notice, delete, and un-wire — so precision is a COST metric here, not a nicety.
//
// Each case pins what MUST be delivered and what must NOT be. Run after any selection change.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// THE COMPOSITION GATE.
//
// Strata's value is COMPOSING several modules — wiring them in the right order, substituting the
// project's entity, generating an end-to-end check. With a single recall there is nothing to compose,
// and the cost of reading + verifying delivered code exceeds the cost of writing it. Measured:
//
//     recalls   task        cost     turns
//        1      retry       +21%     +25%    LOSS
//        1      csvimport   +31%      +8%    LOSS
//        4      catalog     -41%     -41%    WIN
//        4      platform    -44%     -51%    WIN
//
// So a single-recall task MUST decline. `expectDecline` pins that — and it doubles as a precision
// test, because a leak that inflates the recall count would silently defeat the gate.
const CASES = [
  {
    name: 'logging (1 recall -> must DECLINE)',
    task: 'Express API pino structured logging: per-request correlation id middleware honoring x-request-id header, pino child logger per request, redaction of authorization header/cookies/password fields, request/response logging middleware with duration and status code, centralized error handler logging stack traces for 5xx only, health route, users route',
    expectDecline: true,
    // auth.rbac.express.v1 leaked in here through FAT-CONSOLIDATION, a second selection path that had
    // no evidence gate. It matched on "authorization" (the HTTP HEADER, not the security concept) and
    // on "auth" as a substring of "authorization". It turned a 1-recall task into a 2-recall task and
    // made Strata fire on work it should have declined.
    forbid: ['auth.rbac.express.v1', 'data.csv-import.v1', 'payment.stripe.v1'],
  },
  {
    name: 'retry (1 recall -> must DECLINE)',
    task: 'resilient HTTP client for a flaky third-party API: per-attempt timeout, retries with exponential backoff and jitter, honour Retry-After on 429, retry only idempotent methods and retryable status codes, circuit breaker that fails fast and probes for recovery, express proxy endpoint',
    expectDecline: true,
    forbid: ['validation.valibot.v1', 'data.csv-import.v1', 'observability.logging.v1'],
  },
  {
    name: 'csvimport (1 recall -> must DECLINE)',
    task: 'CSV import endpoint: parse a raw CSV body, validate each row against a schema (valid email, name min length, age integer >= 18), coerce cell types, skip bad rows instead of aborting, return per-row errors naming the source line number, handle UTF-8 BOM and quoted commas',
    expectDecline: true,
    forbid: ['observability.logging.v1', 'validation.valibot.v1'],
  },
  {
    name: 'catalog (4 recalls -> must DELIVER)',
    task: 'product catalog API: cursor-paginated GET list endpoint with multi-field sorting and allowlisted filtering, CSV import validating each row and reporting source line numbers, pino structured logging with a per-request correlation id and credential redaction, token-bucket rate limiter returning 429 with Retry-After',
    expect: ['observability.logging.v1', 'api.pagination.v1', 'data.csv-import.v1', 'cache.ratelimit.v1'],
    forbid: ['auth.rbac.express.v1', 'http.resilient-client.v1', 'payment.stripe.v1'],
  },
  // THE COVERAGE SPRINT'S OWN TEST. Coverage is only worth anything if it raises N — the number of
  // recalls that compose on ONE task — because that is the only variable Strata's value scales with:
  //
  //     recalls   task        cost     turns
  //        1      retry       +21%     +25%    LOSS
  //        4      catalog     -41%     -41%    WIN
  //
  // These two new recalls were chosen for exactly that: search and validation land on the SAME list
  // endpoint as pagination, so a realistic "searchable API" task now composes 5 where it used to
  // compose 2 — and 2 is barely above the decline threshold.
  {
    name: 'searchapi (5 recalls -> must DELIVER, proves the new recalls raise N)',
    task: 'product search API: a full-text search box over the catalog with typeahead prefix matching and faceted category counts, cursor-paginated results with sorting, schema validation of the request body returning per-field 400 errors, pino structured logging with a per-request correlation id, token-bucket rate limiter returning 429 with Retry-After',
    expect: ['search.fulltext.v1', 'api.pagination.v1', 'validation.request.v1', 'observability.logging.v1', 'cache.ratelimit.v1'],
    forbid: ['http.resilient-client.v1', 'auth.rbac.express.v1'],
  },
  // The payments/auth recalls were PULLED on 2026-07-14. They all failed admission (no compose block,
  // several with no selftest, one — stripe.webhook-patterns — outright broken and being served), and
  // they sit in the measured trust wall: 0/3 adoption, +32% cost, because a model SHOULD audit code it
  // did not write for signature verification. So these tasks must now MISS, and a miss is the correct,
  // cheaper outcome: an honest miss costs baseline; a forced hit cost +17-32%.
  // UPDATED 2026-08-16. This case asserted a world that no longer exists and had been failing on every
  // run — which is worse than having no case at all, because a permanently-red guard gets read as
  // background noise and stops being evidence of anything. (Verified pre-existing: it fails identically
  // with the new stem matching disabled, so it is not fallout from that change.)
  //
  // What changed: the BROKEN `stripe.webhook-patterns.v1` is still pulled and still forbidden. But a
  // re-authored `payment.stripe-webhook.v1` passed admission and is in the library, and it earns its
  // place — the stripejune benchmark run delivered it and its generated verifier passed 6/6 end to end
  // (unsigned, forged, replayed, correctly-signed, and redelivered webhooks all handled). Asserting a
  // MISS here would now be asserting that Strata should refuse work it does correctly.
  //
  // The rest of the task text is still uncovered (nodemailer, bullmq, pdfkit), so this remains a
  // PARTIAL-coverage case — exactly the shape that produced the idempotency defect, where a confident
  // pass was reported for a fraction of what was asked. Keeping it here as a delivering case means any
  // future regression in the stripe path shows up as a diff rather than as silence.
  {
    name: 'stripe (re-authored recall — must DELIVER the webhook module)',
    task: 'Stripe webhooks with signature verification, email confirmation on purchase via Nodemailer SMTP, background job with BullMQ and Redis that generates a PDF receipt with PDFKit and emails it',
    expect: ['payment.stripe-webhook.v1'],
    forbid: ['payment.stripe.v1', 'stripe.webhook-patterns.v1', 'queue.bullmq.v1', 'receipt.pdfkit.v1'],
  },
  {
    name: 'jwt (pulled — must MISS)',
    task: 'user authentication: signup and login endpoints, JWT access and refresh tokens with the jsonwebtoken package, bcrypt hashed passwords, protected-route middleware, in-memory user store',
    expectDecline: true,
    forbid: ['auth.jwt.tokenhandling.v1', 'auth.password.passwordhashing.v1', 'auth.rbac.express.v1'],
  },
];

function selectFor(task) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-sel-'));
    const proc = spawn('node', [path.join(__dirname, '..', 'dist', 'src', 'mcp-server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timed out')); }, 40_000);

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;

        clearTimeout(timer);
        proc.kill();
        const text = msg.result?.content?.[0]?.text ?? '';
        // The delivered recall ids are whatever the assembly actually pulled in; read them off the
        // files Strata wrote rather than trusting the prose of the prompt.
        const testsDir = path.join(dir, 'strata', 'tests');
        const delivered = fs.existsSync(testsDir)
          ? fs.readdirSync(testsDir).map((f) => f.replace(/\.js$/, ''))
          : [];
        resolve({ delivered, text, dir });
        return;
      }
    });

    proc.on('error', reject);

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'seltest', version: '1' } },
    }) + '\n');

    setTimeout(() => {
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'strata_use', arguments: { task, dir } },
      }) + '\n');
    }, 800);
  });
}

(async () => {
  let failures = 0;

  for (const c of CASES) {
    const { delivered, text } = await selectFor(c.task);
    const problems = [];
    // Two ways to deliver nothing: DECLINE (found 1 recall, below the composition gate) or MISS (found
    // none at all). Both are correct outcomes; expectDecline pins 'delivered nothing'.
    const declined = text.startsWith('Strata is declining') || /No verified Strata recall covers/.test(text);

    if (c.expectDecline) {
      if (!declined) problems.push(`DELIVERED but should have DECLINED (${delivered.length} recall(s) — the gate needs >= 2)`);
    } else {
      if (declined) problems.push('DECLINED but should have delivered');
      for (const id of c.expect ?? []) {
        if (!delivered.includes(id) && !text.includes(id)) problems.push(`MISSING  ${id}`);
      }
    }

    for (const id of c.forbid ?? []) {
      if (delivered.includes(id) || text.includes(id)) problems.push(`LEAKED   ${id}`);
    }

    if (problems.length) {
      failures++;
      console.log(`FAIL  ${c.name}`);
      problems.forEach((p) => console.log(`        ${p}`));
      console.log(`        delivered: ${delivered.join(', ') || '(none)'}`);
    } else {
      console.log(`PASS  ${c.name}  -> ${declined ? 'declined' : delivered.join(', ') || '(none)'}`);
    }
  }

  console.log(`\n${CASES.length - failures}/${CASES.length} selection cases passed`);
  process.exit(failures ? 1 : 0);
})();
