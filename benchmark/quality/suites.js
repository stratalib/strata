'use strict';
/**
 * PRE-REGISTERED ACCEPTANCE SUITES.
 *
 * These are the graders for the quality thesis ("haiku + Strata reaches sonnet quality"). Three rules
 * govern this file, and each of them exists because this project already made the mistake:
 *
 * 1. **strata/verify.js is NEVER the grader.** Strata generates it, so grading the Strata arm with it
 *    is marking your own homework. Everything here is written against the TASK PROMPT alone and knows
 *    nothing about recalls.
 *
 * 2. **Frozen before the first run.** The file is hashed and the hash is recorded in every result. If
 *    these checks were written or edited after seeing an arm's output, the hash would differ from the
 *    one on the earlier results and the tampering is visible. Checks tuned to the delivered code would
 *    otherwise be indistinguishable from checks that measure quality.
 *
 * 3. **Every check gets a negative control.** A check that cannot fail is not a check — an HTTP search
 *    check in this project once passed against deliberately broken code, because the route it probed
 *    never called the function under test. See negative-control.js: it plants each bug and asserts the
 *    corresponding check goes red.
 *
 * WHY THESE CHECKS. The happy path tells us nothing — every arm will list products and create an
 * order. Model quality separates on EDGE CASES: refill arithmetic, cursor keys, malformed input,
 * replay semantics. So the suite is deliberately weighted there, and each check names the specific
 * failure it is hunting.
 *
 * FAIRNESS. Baseline arms invent their own route names, so nothing may assume a path. Routes are
 * DISCOVERED from a candidate list; a suite that only probed /products would score an arm zero for
 * choosing /api/products, which measures naming, not quality.
 */

/** Checks are graded independently; `critical` ones also gate whether the run is counted as working. */
const CATALOG = {
  name: 'catalog',
  // "Add pagination to the products list endpoint, rate limit the API per IP, and log every request
  //  with an id I can trace. Make sure it runs."
  prompt: 'pagination + per-IP rate limit + traceable request id logging',
  listCandidates: ['/products', '/api/products', '/items', '/api/items', '/product', '/v1/products'],

  checks: [
    {
      id: 'C1-list-works',
      title: 'Products list returns items',
      critical: true,
      hunting: 'the endpoint exists at all and serves the fixture\'s 40 seeded products',
    },
    {
      id: 'C2-limit-respected',
      title: 'limit is respected',
      hunting: 'a "pagination" that returns the whole table and ignores the caller\'s page size',
    },
    {
      id: 'C3-page2-disjoint',
      title: 'Page 2 does not repeat page 1',
      hunting:
        'THE classic pagination defect. A cursor built on a hardcoded `id` field, or an off-by-one '
        + 'offset, silently re-serves page 1 as page 2. It looks completely correct from a single '
        + 'request, and it is the exact bug a Mongoose fixture exposed in this project\'s own '
        + 'pagination recall (every cursor encoded undefined).',
    },
    {
      id: 'C4-hostile-paging-input',
      title: 'Garbage paging input does not 5xx',
      hunting:
        'limit=abc / limit=-1 / limit=999999 reaching the data layer unvalidated. A 4xx or a clamped '
        + '2xx are both fine — a 500 is not, and neither is dumping the entire table for limit=999999.',
    },
    {
      id: 'C5-ratelimit-triggers',
      title: 'Rate limit actually refuses a burst',
      hunting: 'a limiter that is configured, mounted, and never returns 429 — present but inert.',
    },
    {
      id: 'C6-ratelimit-refills',
      title: 'Rate limit recovers after waiting',
      hunting:
        'a limiter that blocks and never recovers, i.e. a first-request-wins bucket with broken refill '
        + 'arithmetic. This project\'s own rate-limit recall once had a test that passed on luck here: '
        + 'it asserted an empty bucket with refillPerSec=1000, which regains a token every millisecond, '
        + 'so the assertion only held when three calls landed in the same millisecond. Standalone they '
        + 'did; composed they did not.',
    },
    {
      id: 'C7-request-id-traceable',
      title: 'Each request carries a distinct traceable id',
      hunting:
        'the literal ask ("an id I can trace"). Satisfied by a per-request id in a response header OR '
        + 'in the server log. Must be DISTINCT per request — a constant id is not traceability, and it '
        + 'is what you get from a logger wired up once outside the request scope.',
    },
    {
      id: 'C8-malformed-json',
      title: 'Malformed JSON is handled without leaking internals',
      hunting:
        'no error handler for express.json()\'s parse failure. Requires 4xx, a surviving process, AND '
        + 'no stack trace in the body. The stack-trace clause is not decoration — the negative control '
        + 'proved that without it this check CANNOT FAIL: Express\'s built-in handler already answers '
        + '400 for entity.parse.failed, so the check measured Express rather than the arm. What the '
        + 'built-in handler also does outside production is return err.stack to the caller.',
    },
  ],
};

const IDEMPOTENCY = {
  name: 'idempotency',
  // "If a client retries the same order request it should not create two orders. Validate the request
  //  body properly and log each attempt. Make sure it runs."
  prompt: 'retry-safe order creation + request body validation + attempt logging',
  createCandidates: ['/orders', '/api/orders', '/order', '/v1/orders', '/orders/create'],

  checks: [
    {
      id: 'I1-create-works',
      title: 'An order can be created',
      critical: true,
      hunting: 'the endpoint exists and accepts a well-formed order',
    },
    {
      id: 'I2-replay-deduplicates',
      title: 'Replaying the same request does not create a second order',
      hunting:
        'THE task. Detected by identity, not by counting: two creates that return DIFFERENT order ids '
        + 'created two orders. Deliberately does not need a list endpoint, which baseline arms often '
        + 'do not build.',
    },
    {
      id: 'I3-same-key-different-body',
      title: 'Same key with a different body is refused',
      hunting:
        'the subtle half of idempotency, and the half naive implementations miss entirely. Returning '
        + 'the FIRST order\'s response for a genuinely different request is silent data loss — the '
        + 'client believes its second, different order exists. Correct answers are 4xx (422/409).',
    },
    {
      id: 'I4-malformed-json',
      title: 'Malformed JSON is handled without leaking internals',
      hunting: 'same as C8 — unhandled body-parser errors, including the stack-trace leak that makes '
        + 'this check falsifiable at all.',
    },
    {
      id: 'I5-validation-rejects-bad-body',
      title: 'A structurally invalid order is rejected',
      hunting:
        '"validate the request body properly". Missing required fields, and a negative quantity, must '
        + 'be refused with 4xx. A 2xx here means the validation is decorative; a 500 means it is absent '
        + 'and something downstream threw.',
    },
    {
      id: 'I6-concurrent-duplicate',
      title: 'Two simultaneous identical requests create at most one order',
      hunting:
        'the race the single-threaded replay test cannot see. A store that checks-then-writes without '
        + 'reserving the key admits both when they arrive together — which is exactly when a client '
        + 'retry storm happens.',
    },
    {
      id: 'I7-attempt-logged',
      title: 'Each attempt is logged',
      hunting: 'the third clause of the prompt, which is the one most often silently dropped.',
    },
  ],
};

/**
 * STRIPEJUNE — the hard-capability, security-shaped task, and deliberately the one where the thesis is
 * PREDICTED TO FAIL.
 *
 * Adoption of delivered code in payments/auth domains is measured at 0/3 in this project: capable
 * models audit and rewrite anything handed to them when the domain is high-stakes (the "audit
 * inversion"). If Strata's advantage evaporates anywhere, it evaporates here. Including this task is
 * what stops the benchmark being a showcase of two friendly domains — a suite that only contains tasks
 * you expect to win is marketing, not measurement.
 *
 * WRITTEN FROM THE TASK PROMPT ALONE, BEFORE ANY OUTPUT TREE WAS READ. The prompt is:
 *
 *   "Build a payment processing system in Node.js + Express (plain JavaScript, no TypeScript): Stripe
 *    webhooks with signature verification, email confirmation on purchase via Nodemailer/SMTP, and a
 *    background job (BullMQ + Redis) that generates a PDF receipt (PDFKit) and emails it."
 *
 * WHAT IS AND IS NOT GRADED, decided up front rather than discovered afterwards.
 *
 * This machine has no Redis and no Docker, and there is no SMTP server to deliver to. That is a
 * constraint on the instrument, and the wrong response to it would be to grade "did the app boot with
 * a working queue" — an app that correctly uses BullMQ would fail for the graders's missing dependency
 * while an app that ignored the requirement entirely would sail through. That is precisely the
 * inversion that scored four correct idempotency implementations 2/7 (see grade.js CATALOG_REFS), and
 * it is not being repeated here by accident.
 *
 * So: everything below is testable with `crypto` and `http` alone, against the HTTP surface. Queue and
 * SMTP internals are NOT graded behaviourally. The one background-work property that IS observable
 * from outside — that the webhook answers Stripe promptly instead of generating a PDF and sending mail
 * inline — is graded, because that is a real defect with a real consequence and it needs no Redis to
 * observe.
 *
 * The signing secret is not guessed: the grader boots the app with STRIPE_WEBHOOK_SECRET set to a value
 * it chooses, and computes real Stripe-format signatures against it. An app that reads the secret from
 * anywhere else is discovered, not assumed.
 */
const STRIPEJUNE = {
  name: 'stripejune',
  prompt: 'stripe webhook signature verification + email confirmation + queued PDF receipt',
  webhookCandidates: [
    '/webhook', '/webhooks', '/webhooks/stripe', '/webhook/stripe', '/stripe/webhook',
    '/api/webhook', '/api/webhooks/stripe', '/v1/webhook', '/stripe', '/payments/webhook',
  ],

  checks: [
    {
      id: 'P1-webhook-accepts-valid-signature',
      title: 'A correctly signed webhook is accepted',
      critical: true,
      hunting:
        'the anti-vacuous-pass check, and it comes FIRST on purpose. Every rejection check below is '
        + 'trivially satisfiable by a route that refuses everything — including a route that crashes on '
        + 'startup because Redis is absent. Without this, an app that never worked at all would score '
        + '4/5 on security. Signed with a real Stripe-format t=/v1= header over the raw bytes.',
    },
    {
      id: 'P2-unsigned-rejected',
      title: 'A webhook with no signature header is rejected',
      hunting:
        'the whole point of the task. An unsigned webhook that returns 2xx means anyone who can reach '
        + 'the URL can forge a paid order — no Stripe account required, no secret required. This is the '
        + 'single highest-severity defect the suite can find, and it is invisible in any happy-path test '
        + 'because Stripe always sends the header.',
    },
    {
      id: 'P3-forged-signature-rejected',
      title: 'A well-formed but wrong signature is rejected',
      hunting:
        'the half-implementation: parsing the Stripe-Signature header, reading t and v1 out of it, and '
        + 'then never actually comparing the HMAC — or comparing it against the wrong string. Looks '
        + 'completely correct in review and in every test where the signature happens to be valid.',
    },
    {
      id: 'P4-raw-body-verification',
      title: 'Verification uses the raw body, not a re-serialized one',
      hunting:
        'THE canonical Stripe integration bug, and the reason `express.raw({type:"application/json"})` '
        + 'exists. Verifying against JSON.stringify(req.body) after express.json() has already parsed it '
        + 'passes every test written with a re-serialized payload and fails against real Stripe traffic, '
        + 'because key order and whitespace are not preserved. Probed with a payload whose byte form '
        + 'differs from its re-serialization: correct code accepts it, a re-serializing implementation '
        + 'computes a different HMAC and rejects it. A defect that only appears in production is exactly '
        + 'the kind a benchmark should be built to catch.',
    },
    {
      id: 'P5-replay-window-enforced',
      title: 'An old timestamp with a valid signature is rejected',
      hunting:
        'the reason the Stripe-Signature header carries `t` at all. Without a tolerance check, one '
        + 'captured webhook is replayable forever by anyone who recorded it, and the HMAC stays valid '
        + 'because the payload never changed. Signature is genuinely correct here; only the age is wrong, '
        + 'so nothing but an explicit timestamp check can pass this.',
    },
    {
      id: 'P6-duplicate-event-once',
      title: 'The same event id delivered twice has effect once',
      hunting:
        'Stripe retries webhooks on any non-2xx and on timeouts, and will re-deliver the same event.id. '
        + 'Without dedupe the customer is emailed and receipted twice for one purchase. Detected without '
        + 'needing a list endpoint, by requiring the second delivery to be acknowledged rather than '
        + 'reprocessed.',
    },
    {
      id: 'P7-webhook-answers-promptly',
      title: 'The webhook responds without doing the heavy work inline',
      hunting:
        'why the prompt asks for a background job at all. Generating a PDF and sending SMTP mail inside '
        + 'the request handler makes Stripe wait; past its timeout Stripe gives up, retries, and the '
        + 'duplicate work compounds. This is the only queue property observable without Redis, and it is '
        + 'the one that actually matters. Judged leniently and only when P1 passed, so that a missing '
        + 'Redis costs nothing.',
    },
    {
      id: 'P8-no-secret-or-stack-leak',
      title: 'Rejections leak neither the signing secret nor a stack trace',
      hunting:
        'the failure mode of hand-rolled verification: echoing the expected signature, the whsec_ value, '
        + 'or a raw stack trace into the 400 body. Leaking the expected HMAC turns a rejection into an '
        + 'oracle that hands the attacker exactly what they needed.',
    },
  ],
};

/**
 * RETRY — the CONTROL, and the one task Strata is expected to LOSE.
 *
 * "Write a helper that calls a flaky API and retries with backoff when it fails." One small function,
 * far under the ~45-turn break-even where composing, reading and verifying delivered code costs more
 * than writing it. This project has already measured it: a single-recall retry task ran +21% cost and
 * +25% turns. It is in the suite precisely BECAUSE it loses — a benchmark whose every task is a win is
 * a brochure, and the honest-decline behaviour ("Strata is declining") is itself a product claim worth
 * testing.
 *
 * WRITTEN FROM THE PROMPT ALONE, BEFORE ANY RETRY RUN EXISTED.
 *
 * GRADED DIFFERENTLY, and that difference is forced by the task. The other three suites boot an app
 * and probe HTTP. A helper has no HTTP surface, so these checks REQUIRE the module and drive it
 * against a server whose failure pattern the grader controls. Which means discovery has to find an
 * exported function rather than a route — and, exactly as with route names, WHAT IT IS CALLED IS NOT
 * QUALITY. `retry`, `withRetry`, `fetchWithRetry`, `callWithBackoff` are all fine.
 *
 * The checks are weighted at the failure modes a happy-path test cannot see. Anyone can write
 * something that retries; the defects live in when it STOPS.
 */
const RETRY = {
  name: 'retry',
  prompt: 'a helper that calls a flaky API and retries with backoff',

  checks: [
    {
      id: 'R1-retries-then-succeeds',
      title: 'A call that fails twice and then succeeds returns the success',
      critical: true,
      hunting:
        'the task itself, and the anti-vacuous-pass anchor. Every check below is satisfiable by a '
        + 'helper that gives up instantly or never calls anything at all, so this one has to pass for '
        + 'the rest to mean anything.',
    },
    {
      id: 'R2-gives-up-eventually',
      title: 'An endpoint that always fails is abandoned, not retried forever',
      critical: true,
      hunting:
        'the unbounded loop. A retry helper with no attempt ceiling turns one dead upstream into a '
        + 'hung request and, at scale, into a self-inflicted DDoS on the thing that is already down. '
        + 'Measured by the SERVER counting attempts, not by trusting the helper to report them.',
    },
    {
      id: 'R3-actually-waits',
      title: 'Retries are spaced, not fired in a tight loop',
      hunting:
        '"with backoff" silently dropped. A helper that retries three times in 2ms is not backing off, '
        + 'it is hammering — and it looks completely correct in any test that only asserts the final '
        + 'result. Measured from the arrival times of the requests themselves.',
    },
    {
      id: 'R4-backoff-grows',
      title: 'Each wait is longer than the one before',
      hunting:
        'CONSTANT delay sold as backoff. Sleeping 100ms between every attempt passes R3 and still '
        + 'fails the purpose: backoff exists so a struggling upstream gets progressively more room to '
        + 'recover. Requires gap2 to exceed gap1 by a real margin, not a scheduling wobble.',
    },
    {
      id: 'R5-no-retry-on-4xx',
      title: 'A 400 is not retried',
      hunting:
        'THE defect of this domain. A 4xx means the REQUEST is wrong — retrying it cannot ever succeed, '
        + 'so every attempt is pure waste and, on a 429 or a payment call, actively harmful. Naive '
        + 'helpers retry on any non-2xx. Invisible in testing because the call still fails either way; '
        + 'the only difference is how many times it failed.',
    },
    {
      id: 'R6-surfaces-the-failure',
      title: 'Giving up reports a real error, not undefined',
      hunting:
        'the swallowed exception. A helper that exhausts its attempts and returns undefined turns an '
        + 'upstream outage into a null-pointer crash somewhere unrelated, hours later, in code that '
        + 'has nothing to do with the network.',
    },
    {
      id: 'R7-succeeds-first-time-without-waiting',
      title: 'A healthy endpoint is called once and returned promptly',
      hunting:
        'backoff applied unconditionally. Sleeping before the FIRST attempt, or retrying a 200, adds '
        + 'latency to every healthy call — the common path — to serve the rare one. A helper that '
        + 'takes a second to return a 200 is a performance bug in every request the service makes.',
    },
  ],
};

module.exports = {
  CATALOG, IDEMPOTENCY, STRIPEJUNE, RETRY,
  SUITES: { catalog: CATALOG, idempotency: IDEMPOTENCY, stripejune: STRIPEJUNE, retry: RETRY },
};
