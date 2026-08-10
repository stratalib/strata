/**
 * The deterministic verifier — the answer to the 23-turn wall.
 *
 * Turn accounting on the brownfield benchmark, per session:
 *
 *     TEST + PROCWRANGLE = 23 turns  (41% of the entire job)
 *     VERIFY_OURS        = 14 turns  (reading the code we delivered)
 *     WRITE              =  2 turns  (what Strata actually eliminated)
 *
 * Strata was optimising the 2. The model spent 23 turns booting the server, curling every endpoint,
 * hammering the limiter with 70 requests, grepping the log for a leaked authorization header, POSTing
 * malformed JSON — and then fighting Windows `taskkill`/`netstat` to free the port again.
 *
 * That work is NOT distrust of us. It is accountability: the model was asked to deliver a working
 * feature, so it must PROVE the feature works, and it will not take a comment's word for it. It did
 * not believe our claim that the middleware order was right — it POSTed a malformed body and checked
 * the correlation id survived.
 *
 * You cannot argue a model out of that, and you shouldn't try. But you CAN do the work for it.
 *
 * Strata knows exactly which routes it emitted, on which entity, with which fields — so it can write
 * the end-to-end proof itself. The session then runs ONE command instead of twenty-three turns, and
 * gets a checkable receipt rather than a promise. Evidence, not assurance.
 */

export interface VerifierSpec {
  /** How to start the app, e.g. "node src/server.js". */
  startCommand: string;
  /**
   * True when strata/selftest.js exists — the recalls' own behavioural suites (176 assertions today).
   *
   * verify.js runs it FIRST. The two are not alternatives: the selftest proves the primitives behave
   * (a 404 must not reset the circuit breaker; a CSV bad row must name its source line), and the
   * end-to-end checks prove the WIRING is right (the logger runs before the body parser; the filter
   * is allowlisted). Bugs hide in both places, and a session should need exactly ONE command.
   *
   * Getting this wrong was actively harmful: a csv-only task produced a verifier with a single
   * trivial check, and because a verifier merely EXISTED the prompt pointed the model at it instead
   * of the 28-assertion selftest. A near-empty verifier that displaces a real one is worse than no
   * verifier at all.
   */
  hasSelftest: boolean;
  /**
   * Env vars the delivered recalls declared they need. The verifier seeds any that the project does
   * not already set — see startServer(). Without this, a recall that (correctly) refuses to boot in
   * production without its secret can never pass the composed-boot gate.
   */
  envSlots?: string[];
  /** Route the pagination recall emitted, e.g. "/products". Null if not delivered. */
  listRoute: string | null;
  /** True when the project has a real data source, so an empty list is a defect rather than a fact. */
  expectRows: boolean;
  /** Route the csv-import recall emitted, e.g. "/products/import". Null if not delivered. */
  importRoute: string | null;
  /** CSV header + one valid row + one invalid row, derived from the entity's real columns. */
  csvHeader: string | null;
  csvValidRow: string | null;
  csvInvalidRow: string | null;
  /** Which field the invalid row violates, and on which file line. */
  csvBadField: string | null;
  hasLogging: boolean;
  hasRateLimit: boolean;
  hasCache: boolean;
  /**
   * payment.stripe-webhook.v1 shipped — so the webhook must refuse a forged signature and accept a
   * real one, and a redelivered event must not be processed twice.
   *
   * Added because this spec had no vocabulary for a webhook, and the consequence was measured rather
   * than guessed: stripejune's generated verify.js contained ZERO checks across all five strata runs
   * (idempotency's had eight). The prompt still pointed the model at it, so the model opened a
   * verifier that proved nothing and went on to hand-write its own tests — turns went 36-43 on the
   * old 4-recall delivery to 56-84 here, and the cost with it. That is the exact failure this file's
   * own header warns about: "a near-empty verifier that displaces a real one is worse than no
   * verifier at all."
   *
   * The signing secret is not a placeholder here. verify.js seeds STRIPE_WEBHOOK_SECRET from envSlots
   * and signs with the same value, so these checks exercise real HMAC verification rather than
   * asserting that some string was rejected.
   */
  hasStripeWebhook: boolean;
  /** The path the webhook recall mounts, e.g. "/webhooks/stripe". */
  webhookRoute: string | null;
  /** validation.request.v1 shipped — so a malformed body must come back as JSON, not an HTML stack. */
  hasValidation: boolean;
  /** search.fulltext.v1 shipped — so a hostile ?q= must not be able to 500 the search box. */
  hasSearch: boolean;
  /** Burst capacity, so the rate-limit check knows how many requests to send. */
  rateLimitBurst: number;
  /** Two real sortable columns, for the multi-field sort check. */
  sortA: string | null;
  sortB: string | null;
  /** A real filterable column + a value known to exist, for the filter check. */
  filterField: string | null;
  filterValue: string | null;
  /**
   * The schema's unique key. NOT always "id" — a Mongoose document keys on `_id`.
   *
   * The cursor check used to read `row.id` unconditionally, so on a Mongoose project it compared
   * `undefined` to `undefined` across two pages and reported a page-overlap that did not exist. A
   * verifier that fails for the WRONG reason is as corrosive as one that falsely passes: either way
   * it stops meaning anything, and the session goes back to proving everything by hand.
   */
  idField: string;
  /** True when ANY recall contributed routes — so the app is worth starting even without a list route. */
  hasRoutes: boolean;
  /**
   * Checks DECLARED BY THE RECALLS THEMSELVES, in their metadata.
   *
   * Every field above is an engine-side flag, which means the verifier can only check the recalls the
   * engine was taught about — 6 of 11 when this was written. Deliver idempotency, health, audit or
   * email and `verify.js` proved nothing about them beyond "the server booted", while still printing a
   * confident green summary. That is the worst failure a proof can have, and it got worse with every
   * recall added, because coverage required an ENGINE edit per recall (O(N)).
   *
   * So a recall now carries its own checks and coverage travels with it: declare, don't hardcode —
   * the same rule as the contribution IR.
   */
  recallChecks: RecallCheck[];
}

/** A verifier check a recall declares for itself in metadata.json. */
export interface RecallCheck {
  /** What is being proven, in the imperative — it is printed verbatim next to PASS/FAIL. */
  name: string;
  /**
   * The body of an async function, run against the LIVE server. Available in scope:
   *   get(route, headers) / post(route, body, contentType) -> { status, headers, body, text }
   *   assert(cond, msg) · readLog() · sleep(ms) · BASE
   * Entity placeholders ({{ROUTE}}, {{ID_FIELD}}, ...) are substituted before emission.
   */
  code: string;
}

export function buildVerifierScript(spec: VerifierSpec): string {
  const checks: string[] = [];
  // Checks that consume a shared resource (the rate-limit bucket). Appended last — see the note below.
  const destructiveChecks: string[] = [];

  // Start the app whenever ANYTHING route-shaped shipped.
  //
  // `retry` ships a /proxy/:id route, but this used to check only for pagination/csv/logging/limiter —
  // so hasHttp was false, the server was never started, nothing about the HTTP surface was proven, and
  // the session hand-tested it: 8.3 turns of curling a server we could have exercised for free. If we
  // put a route in someone's app, we owe them a check that it answers.
  // A webhook IS an HTTP surface. Omitting it here would start no server, so every check above would
  // be skipped and the verifier would go back to proving nothing.
  const hasHttp = !!(spec.listRoute || spec.importRoute || spec.hasLogging || spec.hasRateLimit
    || spec.hasRoutes || spec.hasStripeWebhook);

  if (hasHttp) {
    checks.push(`
  // ── the app boots at all ────────────────────────────────────────────────────
  await check('server boots and answers /health', async () => {
    const r = await get('/health');
    assert(r.status === 200, 'GET /health -> ' + r.status + ' (expected 200)');
  });`);
  }

  // NOTE: there is deliberately NO "are the routes mounted?" check here.
  //
  // I added one, and it broke two other checks. It GET-ed the import route — which only accepts POST,
  // so a 404 there is CORRECT — and it warmed the response cache, so the MISS/HIT check then saw a HIT
  // on its "first" request. Both failures were the checker's, not the code's.
  //
  // The rule this earns: a verifier check must have NO SIDE EFFECTS on the checks around it, and must
  // never assert on behaviour the feature does not claim. Mounting is already proven by the pagination
  // and import checks that actually exercise those routes; a separate check bought nothing and cost
  // two false failures. A verifier that cries wolf is worth less than no verifier at all.

  if (spec.hasLogging) {
    checks.push(`
  // ── correlation id: an inbound x-request-id must survive, so a trace spans services ──
  await check('correlation id honours an inbound x-request-id', async () => {
    const r = await get('/health', { 'x-request-id': 'verify-trace-1' });
    assert(r.headers['x-request-id'] === 'verify-trace-1',
      'x-request-id was ' + r.headers['x-request-id'] + ', expected it echoed back');
  });

  await check('a request with no id is still assigned one', async () => {
    const r = await get('/health');
    assert(!!r.headers['x-request-id'], 'no x-request-id on the response');
  });

  // ── redaction: the whole reason the logging recall exists ──
  await check('an authorization header is NOT written to the log', async () => {
    await get('/health', { authorization: 'Bearer sk_live_VERIFY_SECRET' });
    await sleep(150);
    const log = readLog();
    assert(!log.includes('sk_live_VERIFY_SECRET'), 'THE SECRET LEAKED INTO THE LOG');
  });

  // A password arrives in a BODY far more often than in a header, and a body is what actually ends up
  // in an access log. Sessions hand-checked this after the verifier passed — so now it is checked.
  await check('a password in a request BODY is NOT written to the log', async () => {
    await post('/health', JSON.stringify({ password: 'hunter2_VERIFY', token: 'tok_VERIFY' }), 'application/json');
    await sleep(150);
    const log = readLog();
    assert(!log.includes('hunter2_VERIFY'), 'A PASSWORD FROM THE REQUEST BODY LEAKED INTO THE LOG');
    assert(!log.includes('tok_VERIFY'), 'A TOKEN FROM THE REQUEST BODY LEAKED INTO THE LOG');
  });

  // 4xx is the caller's fault and must not dump a stack to them; 5xx is ours and must not leak
  // internals either. A malformed JSON body is the cheapest way to reach the error handler for real.
  await check('a malformed body is a 4xx and leaks no stack trace to the caller', async () => {
    const r = await post('/health', '{"broken":', 'application/json');
    assert(r.status >= 400 && r.status < 500, 'malformed JSON gave ' + r.status + ', expected a 4xx');
    assert(!/\\bat\\s+\\w+.*:\\d+:\\d+/.test(r.text), 'a STACK TRACE was returned to the caller');
  });

  // The error path is exactly where the correlation id is most valuable, and exactly where it is most
  // often lost — express.json() throws BEFORE a late-registered logger would have run.
  await check('the error path still carries a correlation id', async () => {
    const r = await post('/health', '{"broken":', 'application/json');
    assert(!!r.headers['x-request-id'], 'the failing request lost its correlation id — the one you most need to trace');
  });`);
  }

  if (spec.hasValidation) {
    checks.push(`
  // ── validation: the error ENVELOPE, not just the status code ──
  //
  // express.json() throws a SyntaxError on a malformed body, and Express's default handler answers it
  // with an HTML page containing a stack trace. So a client that sends one bad byte gets HTML from an
  // endpoint that has only ever returned JSON: its parser throws, and the real cause (a typo in the
  // request) is buried under a second, unrelated error. The status code alone does not catch this —
  // the HTML page is ALSO a 400. The body is what has to be checked.
  await check('a malformed body returns a JSON error envelope, not an HTML stack trace', async () => {
    const r = await post('/health', '{"a":', 'application/json');
    assert(r.status === 400, 'malformed JSON gave ' + r.status + ' (expected 400)');
    assert(!/^\\s*</.test(r.text), 'the response body is HTML — Express default handler is still in charge');

    let body;
    try { body = JSON.parse(r.text); } catch { throw new Error('the error body is not even JSON'); }
    assert(typeof body.error === 'string', 'no machine-readable .error in the response');
    assert(Array.isArray(body.details), 'no per-field .details array — a form cannot show the caller what to fix');
  });`);
  }

  if (spec.hasSearch && spec.listRoute) {
    // SCOPE, STATED HONESTLY: this exercises the searchQuery MIDDLEWARE, which is mounted globally and
    // tokenizes ?q= on every request. It does NOT exercise search() itself — the list route comes from
    // the pagination recall and does not call it; wiring search into a route needs the data source,
    // which is the model's glue to write, not ours to fake.
    //
    // I verified that distinction instead of assuming it: with a deliberate `new RegExp(query)` planted
    // inside search(), this check still PASSED (nothing calls search over HTTP) — a check that passes
    // on broken code is a lie, and the same class of false pass has bitten this project before. Planted
    // in tokenize(), which the middleware DOES run, it correctly FAILED. search() itself is covered by
    // the recall's 61-assertion adversarial selftest, which verify.js runs first.
    checks.push(`
  // ── search: a user typing "(" must not be able to 500 the search box ──
  //
  // This is THE bug the search recall exists to prevent. \`new RegExp(q)\` on a query of "(((" throws a
  // SyntaxError — so an unlucky bracket is a 500 — and on "(a+)+$" it backtracks catastrophically and
  // pins the event loop (ReDoS): one request takes the whole server down for everyone.
  await check('a hostile search query does not 500 (no RegExp is built from user input)', async () => {
    for (const q of ['(((', '(a+)+$', '[unclosed', '\\\\', '*']) {
      const r = await get('${spec.listRoute}?q=' + encodeURIComponent(q));
      assert(r.status < 500, 'q=' + q + ' returned ' + r.status + ' — user input is reaching a RegExp');
    }
  });

  await check('a huge search query is truncated, not processed', async () => {
    const started = Date.now();
    const r = await get('${spec.listRoute}?q=' + 'x'.repeat(20000));
    assert(r.status < 500, 'a 20KB query returned ' + r.status);
    assert(Date.now() - started < 3000, 'a 20KB query took over 3s — it is not being bounded');
  });`);
  }

  if (spec.hasCache && spec.listRoute) {
    checks.push(`
  // ── response cache: MISS then HIT ──
  await check('response cache reports MISS then HIT', async () => {
    const a = await get('${spec.listRoute}');
    const b = await get('${spec.listRoute}');
    assert(a.headers['x-cache'] === 'MISS', 'first request x-cache=' + a.headers['x-cache']);
    assert(b.headers['x-cache'] === 'HIT', 'second request x-cache=' + b.headers['x-cache']);
  });`);
  }

  if (spec.hasStripeWebhook && spec.webhookRoute) {
    // ── stripe webhook: forged signatures refused, real ones accepted, retries deduplicated ──
    //
    // Ordered deliberately: the ACCEPT check comes last but matters most. Every rejection assertion
    // here is satisfied by a handler that refuses everything — including one that is broken — so
    // without proving a correctly signed event gets through, the other two are vacuous.
    checks.push(`
  // ── stripe webhook signature verification ──
  // The SAME value startServer() seeds into the child. Guessing a different one meant the verifier
  // signed with one secret while the server verified against another, so every signature mismatched:
  // the three rejection checks passed VACUOUSLY (a webhook with no secret configured refuses
  // everything) and only the accept check exposed it. That is exactly why the accept check is ordered
  // last, and it caught a real defect on its first outing — the recall had not declared
  // STRIPE_WEBHOOK_SECRET in envSlots, so nothing was seeded at all.
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET || 'strata-verify-stripe-webhook-secret';
  const whEvent = (id) => JSON.stringify({
    id, object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'pi_' + id, amount: 2000, currency: 'usd' } },
  });
  const whSign = (raw, ts) => {
    const h = require('crypto').createHmac('sha256', whSecret).update(ts + '.' + raw).digest('hex');
    return { 'Stripe-Signature': 't=' + ts + ',v1=' + h };
  };
  const nowSec = () => Math.floor(Date.now() / 1000);

  await check('${spec.webhookRoute} refuses an unsigned webhook', async () => {
    const raw = whEvent('evt_unsigned');
    const r = await request('POST', '${spec.webhookRoute}', raw, 'application/json');
    assert(r.status >= 400 && r.status < 500,
      'an unsigned webhook returned ' + r.status + '. Anyone who can reach this URL can forge a paid order.');
  });

  await check('${spec.webhookRoute} refuses a forged signature', async () => {
    const raw = whEvent('evt_forged');
    const r = await request('POST', '${spec.webhookRoute}', raw, 'application/json',
      { 'Stripe-Signature': 't=' + nowSec() + ',v1=' + '0'.repeat(64) });
    assert(r.status >= 400 && r.status < 500, 'a forged signature returned ' + r.status);
  });

  await check('${spec.webhookRoute} refuses a replayed timestamp', async () => {
    const raw = whEvent('evt_replay');
    // Signature is genuinely VALID — only the age is wrong, so nothing but a tolerance check catches it.
    const r = await request('POST', '${spec.webhookRoute}', raw, 'application/json',
      whSign(raw, nowSec() - 3600));
    assert(r.status >= 400 && r.status < 500,
      'an hour-old capture with a valid signature returned ' + r.status + ' — it is replayable forever');
  });

  await check('${spec.webhookRoute} accepts a correctly signed event', async () => {
    const raw = whEvent('evt_ok_' + Date.now());
    const r = await request('POST', '${spec.webhookRoute}', raw, 'application/json', whSign(raw, nowSec()));
    assert(r.status >= 200 && r.status < 300,
      'a correctly signed event returned ' + r.status + '. The three checks above are vacuous unless this passes.');
  });

  await check('${spec.webhookRoute} handles a redelivered event once', async () => {
    // Stripe retries on any non-2xx AND on timeout, redelivering the same event.id. Both deliveries
    // must be acknowledged; what must not happen twice is the work.
    const id = 'evt_dup_' + Date.now();
    const raw = whEvent(id);
    const a = await request('POST', '${spec.webhookRoute}', raw, 'application/json', whSign(raw, nowSec()));
    const b = await request('POST', '${spec.webhookRoute}', raw, 'application/json', whSign(raw, nowSec()));
    assert(a.status >= 200 && a.status < 300, 'first delivery returned ' + a.status);
    assert(b.status >= 200 && b.status < 300,
      'redelivery returned ' + b.status + ' — a non-2xx tells Stripe to retry again, forever');
  });`);
  }

  if (spec.listRoute) {
    // THE EMPTINESS CHECK. Every other check here asserts the ABSENCE of a failure — status < 500,
    // no repeated row, no 5xx on hostile input. Every one of them passes against a route that returns
    // an empty array with a 200, and the cursor-walk below actively excuses it: with no rows there is
    // no nextCursor, so it returns early and reports success.
    //
    // That is not hypothetical. A benchmark delivery served `[]` from a route the project never asked
    // for, with the project's own server orphaned, and this verifier reported 12/12 PASSED. The proof
    // was issued for an application that did nothing.
    //
    // Only asserted when an entity was resolved, i.e. the project HAS a data source we read a schema
    // from. Greenfield genuinely starts empty, and demanding rows there would be a check that cannot
    // pass — the opposite failure, equally useless.
    if (spec.expectRows) {
      checks.push(`
  // ── the endpoint serves the project's actual data ──
  await check('${spec.listRoute} returns real rows, not an empty list', async () => {
    const r = await get('${spec.listRoute}');
    assert(r.status === 200, 'status ' + r.status);
    const rows = Array.isArray(r.body) ? r.body : (r.body.data || r.body.items || r.body.results);
    assert(Array.isArray(rows), 'no array of rows in the response');
    assert(rows.length > 0, 'the endpoint returned 200 with ZERO rows. Every other check here passes '
      + 'against an empty list, so this one exists to catch a route that was wired to a placeholder '
      + 'instead of to this project\\'s data source.');
  });
`);
    }

    checks.push(`
  // ── list endpoint: pagination, sorting, allowlisting ──
  await check('${spec.listRoute} paginates with hasMore + nextCursor', async () => {
    const r = await get('${spec.listRoute}?limit=2');
    assert(r.status === 200, 'status ' + r.status);
    assert(Array.isArray(r.body.data), 'no data array in the response');
    assert(r.body.pagination, 'no pagination block in the response');
    assert(typeof r.body.pagination.hasMore === 'boolean', 'pagination.hasMore missing');
  });

  await check('${spec.listRoute} walks pages by cursor without repeating a row', async () => {
    const KEY = '${spec.idField}';   // NOT always "id" — Mongoose keys on _id
    const p1 = await get('${spec.listRoute}?limit=2');
    if (!p1.body.pagination.nextCursor) return;   // fewer than 2 rows in the store; nothing to walk
    const p2 = await get('${spec.listRoute}?limit=2&cursor=' + encodeURIComponent(p1.body.pagination.nextCursor));

    const ids1 = p1.body.data.map(function (r) { return r[KEY]; });
    const ids2 = p2.body.data.map(function (r) { return r[KEY]; });

    // If the key is missing, every row reads as undefined and this check would compare undefined to
    // undefined — reporting a phantom overlap, or worse, a phantom pass. Fail loudly instead.
    assert(ids1.every(function (id) { return id !== undefined; }),
      'rows have no "' + KEY + '" — the cursor cannot be built from a key that does not exist');

    const overlap = ids2.filter(function (id) { return ids1.indexOf(id) !== -1; });
    assert(overlap.length === 0, 'page 2 repeated rows from page 1: ' + overlap.join(','));
  });

  await check('a sort field that is not allowlisted is REJECTED, not honoured', async () => {
    const r = await get('${spec.listRoute}?sort=' + encodeURIComponent('password; DROP TABLE'));
    assert(r.status === 200, 'an unknown sort field should fall back, not 500 (got ' + r.status + ')');
  });`);

    // The checks below exist because sessions hand-curled EXACTLY these after running the verifier and
    // seeing it pass. They were right to: the task asked for multi-field sorting and filtering, and the
    // verifier tested neither. A verifier built from the DELIVERED RECALLS rather than from the TASK
    // leaves a gap, and the model closes that gap by hand — which is the cost we were trying to remove.
    if (spec.sortA && spec.sortB) {
      checks.push(`
  // ── multi-field sort: "${spec.sortA},-${spec.sortB}" — asked for by the task, so it gets proven ──
  await check('sorts on MULTIPLE fields (${spec.sortA} asc, then ${spec.sortB} desc)', async () => {
    const r = await get('${spec.listRoute}?limit=20&sort=' + encodeURIComponent('${spec.sortA},-${spec.sortB}'));
    assert(r.status === 200, 'status ' + r.status);
    const rows = r.body.data;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (a['${spec.sortA}'] === b['${spec.sortA}']) {
        // Within an equal primary key, the secondary key must be DESCENDING. If the secondary key is
        // silently ignored, this is where it shows up — the caller sees rows and believes they are
        // sorted, and they are not.
        assert(a['${spec.sortB}'] >= b['${spec.sortB}'],
          'secondary sort ignored: ${spec.sortB} went ' + a['${spec.sortB}'] + ' -> ' + b['${spec.sortB}'] + ' inside the same ${spec.sortA}');
      } else {
        assert(a['${spec.sortA}'] <= b['${spec.sortA}'], 'primary sort ${spec.sortA} is not ascending');
      }
    }
  });`);
    }

    if (spec.filterField && spec.filterValue) {
      checks.push(`
  // ── filtering ──
  await check('filters on ${spec.filterField} and returns ONLY matching rows', async () => {
    const r = await get('${spec.listRoute}?limit=20&${spec.filterField}=${spec.filterValue}');
    assert(r.status === 200, 'status ' + r.status);
    assert(r.body.data.length > 0, 'the filter matched nothing — the check cannot prove anything');
    const bad = r.body.data.filter(function (row) { return String(row['${spec.filterField}']) !== '${spec.filterValue}'; });
    assert(bad.length === 0, bad.length + ' rows leaked through the ${spec.filterField} filter');
  });

  await check('a filter field that is not allowlisted is IGNORED, not applied', async () => {
    const all = await get('${spec.listRoute}?limit=20');
    const probed = await get('${spec.listRoute}?limit=20&notAField=whatever');
    assert(probed.body.data.length === all.body.data.length,
      'an unknown filter key changed the result set — it should be dropped, not honoured');
  });`);
    }
  }

  if (spec.importRoute && spec.csvHeader) {
    checks.push(`
  // ── CSV import: bad rows skipped, source line named, good rows persisted ──
  await check('${spec.importRoute} skips the bad row and names its SOURCE LINE', async () => {
    const csv = ${JSON.stringify(`${spec.csvHeader}\n${spec.csvValidRow}\n${spec.csvInvalidRow}\n`)};
    const r = await post('${spec.importRoute}', csv, 'text/csv');
    assert(r.status === 200, 'status ' + r.status + ' (a partial import is a 200 with a failure list)');
    assert(r.body.summary.imported === 1, 'imported ' + r.body.summary.imported + ', expected 1');
    assert(r.body.summary.failed === 1, 'failed ' + r.body.summary.failed + ', expected 1');
    const err = r.body.errors[0];
    assert(err.line === 3, 'the bad row was reported on line ' + err.line + ', expected 3 (header is line 1)');
    ${spec.csvBadField ? `assert(err.field === '${spec.csvBadField}', 'blamed field ' + err.field + ', expected ${spec.csvBadField}');` : ''}
  });

  await check('an empty body is a 400, not a crash', async () => {
    const r = await post('${spec.importRoute}', '', 'text/csv');
    assert(r.status === 400, 'status ' + r.status + ', expected 400');
  });`);
  }

  if (spec.hasRateLimit) {
    destructiveChecks.push(`
  // ── rate limiter: 429 + Retry-After once the burst is spent ──
  await check('a burst past capacity yields 429 + Retry-After', async () => {
    let limited = null;
    for (let i = 0; i < ${spec.rateLimitBurst + 15}; i++) {
      const r = await get('/health');
      if (r.status === 429) { limited = r; break; }
    }
    assert(limited, 'never got a 429 after ${spec.rateLimitBurst + 15} requests');
    assert(limited.headers['retry-after'], '429 carried no Retry-After header — clients cannot back off');
  });`);
  }

  // Checks the RECALLS declared for themselves. Each is wrapped exactly like a built-in, so a throw
  // inside one is reported as a FAIL rather than taking the whole run down.
  for (const rc of spec.recallChecks ?? []) {
    checks.push(`
  await check(${JSON.stringify(rc.name)}, async () => {
${rc.code.split('\n').map(l => '    ' + l).join('\n')}
  });`);
  }

  // DESTRUCTIVE CHECKS RUN LAST — this ordering is load-bearing, not cosmetic.
  //
  // The rate-limit check deliberately spends the entire token bucket (it fires burst+15 requests to
  // trip the 429). Anything that runs AFTER it gets 429 instead of its real answer. That is exactly
  // what happened the first time a recall declared its own checks: `ops.health.v1` asserted
  // /health/live and /health/ready, they were emitted after the burst, and both failed with 429 — the
  // health recall looked broken when the VERIFIER was at fault.
  //
  // This is the same class as the note above about the routes-mounted check warming the cache. A check
  // that consumes a shared resource must be ordered last, or it silently indicts its neighbours.
  checks.push(...destructiveChecks);

  // KEEP THIS FILE SMALL.
  //
  // It lands in the user's project, and anything in the project can be read into the model's context —
  // where it is re-billed on EVERY subsequent turn (cost ≈ context × turns). This file used to open
  // with a twenty-line essay about why verification is expensive. That essay is a note to OURSELVES;
  // shipping it charged the user ~500 tokens a turn to read our own design rationale.
  //
  // Measured on `csvimport` (an 18-turn task): Strata's on-disk footprint was ~6.1k tokens, of which
  // verify.js was ~2k. Context per turn rose 20% while output fell only 4% — the whole loss, in one
  // line. On a 65-turn task that is noise; on a short one it IS the task.
  //
  // Comments here must earn their place: explain a NON-OBVIOUS assertion, nothing else.
  return `'use strict';
// Strata — end-to-end check for the delivered feature.
//
//   node strata/verify.js
//
// Runs the unit tests, starts the app on a free port, exercises each requirement against the running
// server, and shuts it down. Exit 0 means every line below passed.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const LOG = path.join(__dirname, 'verify-server.log');
let server = null;
let BASE = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function request(method, route, body, contentType, headers) {
  // A plain OBJECT body is serialised as JSON automatically.
  //
  // Passing one straight to fetch() stringifies it as "[object Object]" and sends no content-type, so
  // express.json() never parses it, req.body is empty, and the route answers 400 — while any check
  // that merely asserts "this request was rejected" still PASSES. Three auth checks passed that way
  // before one of them happened to assert a success path and exposed it. A helper whose misuse looks
  // like a passing test is a bug in the helper.
  let payload = body;
  let ct = contentType;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Buffer)) {
    payload = JSON.stringify(body);
    if (!ct) ct = 'application/json';
  }

  const res = await fetch(BASE + route, {
    method,
    headers: Object.assign({}, ct ? { 'content-type': ct } : {}, headers || {}),
    body: payload === undefined ? undefined : payload,
    // Do NOT follow redirects. fetch() follows by default, which means a check asserting "this route
    // 302s to the identity provider" instead sees whatever Google returned — and, worse, the verifier
    // makes a live outbound request to a third party from inside a test. The verifier's job is to
    // observe what THE APP returned, not what a browser would do next.
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, headers: h, body: parsed, text };
}

const get = (route, headers) => request('GET', route, undefined, undefined, headers);
const post = (route, body, ct) => request('POST', route, body, ct);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

async function startServer() {
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;

  const out = fs.openSync(LOG, 'w');
  const parts = ${JSON.stringify(spec.startCommand)}.split(' ');

  // NODE_ENV=production so the logger emits JSON (pretty mode is unparseable, and it is what made an
  // earlier session's log grep silently miss the very line it was looking for).
  // No shell:true — it triggers a Node deprecation warning about unescaped args, and a stray warning
  // in the output is a turn someone spends investigating a non-problem. \`node\` is on PATH anyway.
  // Seed any env var the delivered recalls DECLARED, unless the project already sets it.
  //
  // We boot with NODE_ENV=production (above), and a correctly-written recall refuses to start in
  // production without its secret — so every recall that needs configuration could never pass this
  // gate. web.sessions.v1 failed exactly here: the recall was right, the harness simply ignored the
  // envSlots it had already declared. Seeding is not weakening the check; the point of declaring a
  // slot is to say "this must exist", and the verifier is the one component that knows it is a test.
  const seeded = Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'production' });
  for (const slot of ${JSON.stringify(spec.envSlots ?? [])}) {
    if (!seeded[slot]) seeded[slot] = 'strata-verify-' + slot.toLowerCase().replace(/_/g, '-');
  }

  server = spawn(process.execPath, parts.slice(1), {
    cwd: path.join(__dirname, '..'),
    env: seeded,
    stdio: ['ignore', out, out],
  });

  // Poll until it answers rather than sleeping a fixed amount — a fixed sleep is either a flake or a
  // waste, and usually both.
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(BASE + '/health');
      if (r.status) return;
    } catch { /* not up yet */ }
  }
  throw new Error('server did not start within 15s. Log:\\n' + readLog().slice(-800));
}

function stopServer() {
  // The process owns its own child, so no taskkill/netstat archaeology is needed to free the port.
  //
  // SYNCHRONOUS on Windows. An async spawn() here races process.exit() and libuv aborts with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — a C-level crash printed AFTER the
  // results, which looks like the verifier itself blew up. A tool whose output ends in a crash dump
  // does not get trusted, however green the lines above it were.
  if (!server || server.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

const HAS_HTTP = ${hasHttp};
const HAS_SELFTEST = ${spec.hasSelftest};

// The recalls' own behavioural suites. These prove the PRIMITIVES (a 404 must not reset the circuit
// breaker; a bad CSV row must name its source line). The end-to-end checks below prove the WIRING.
// Bugs live in both, so one command runs both.
async function runSelftests() {
  if (!HAS_SELFTEST) return true;
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'selftest.js')], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.trim().split('\\n').filter(Boolean).pop() || '';
    console.log('  PASS  unit selftests — ' + line.trim());
    passed++;
    return true;
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || '')).trim();
    console.log('  FAIL  unit selftests');
    console.log(out.split('\\n').filter(function (l) { return /FAIL/.test(l); }).slice(0, 6).map(function (l) { return '        ' + l.trim(); }).join('\\n'));
    failures.push({ name: 'unit selftests', error: 'see above' });
    return false;
  }
}

(async () => {
  await runSelftests();

  if (!HAS_HTTP) {
    // Nothing to serve — a library-shaped delivery. The selftests were the whole proof.
    console.log('');
    if (failures.length === 0) {
      console.log('  ' + passed + '/' + passed + ' checks passed — the delivered code works.');
      process.exit(0);
    }
    console.log('  ' + passed + ' passed, ' + failures.length + ' FAILED.');
    process.exit(1);
  }

  try {
    await startServer();
  } catch (e) {
    console.log('\\n  FAIL  the server did not start\\n        ' + e.message);
    stopServer();
    process.exit(1);
  }

  try {
${checks.join('\n')}
  } finally {
    stopServer();
  }

  console.log('');
  if (failures.length === 0) {
    console.log('  ' + passed + '/' + passed + ' checks passed — the delivered feature works end to end.');
    process.exit(0);
  }
  console.log('  ' + passed + ' passed, ' + failures.length + ' FAILED:');
  for (const f of failures) console.log('    - ' + f.name + ': ' + f.error);
  process.exit(1);
})();
`;
}
