# Benchmark

Three backend tasks, two arms, three runs each — full agent sessions measured end to end. Cost is the
whole session bill, not a token count from a single call.

`n=3`, Claude Haiku 4.5, one model per cell. Nothing here speaks to Sonnet or Opus.

---

## What it saves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/savings-dark.svg">
  <img src="assets/savings-light.svg" alt="Same task, same model: 66% fewer tokens, 52% fewer turns, 67% less wall-clock time." width="760">
</picture>

The catalog task — a product API with cursor pagination, per-IP rate limiting and traceable request
logging — is the cell where the library covers the whole ask. It is the honest best case, and it is
shown alone rather than averaged with a task the library barely covers, because that average would
describe neither.

| per run | without Strata | **with Strata** | |
|---|---|---|---|
| tokens read + written | 950,011 | **319,604** | **−66%** |
| turns | 31.3 | **15.0** | **−52%** |
| wall-clock | 190s | **63s** | **3× faster** |
| cost | $0.190 | **$0.077** | **−59%** |
| checks passed | 70.8% | **100%** | |

**Why the three move together.** Tokens here are the whole session: input, output, and the accumulated
context re-read on every turn. Across all 18 runs here, **98–99% of every session's tokens are that
re-read context** and 0.6–1.8% are what the model actually wrote. Output length is not the lever;
turns are. Strata removes turns by removing the loop they are spent in: write the feature, run it,
find it broken, try again.

### The same board on the other two tasks

| task | | turns | cost | quality |
|---|---|---|---|---|
| catalog | baseline | 31.3 | $0.190 | 70.8% |
| | **Strata** | **15.0** | **$0.077** | **100%** |
| idempotency | baseline | 27.7 | $0.175 | 52.4% |
| | **Strata** | **24.0** | **$0.158** | **100%** |
| stripejune | baseline | 48.7 | $0.406 | 16.7% |
| | **Strata** | **43.7** | **$0.385** | **66.7%** |

The gradient is the coverage gradient. Catalog is fully covered and the cost lands at 0.41×;
idempotency is mostly covered at 0.90×; stripejune has one capability of four covered and lands at
0.95× — a wash. Cost is the least stable figure on this page: it moves with the model, the prompt and
the machine. The consistency figures below need no such caveat.

---

## What the failed checks actually were

A quality score is easy to wave away, so here are the failures themselves, re-graded from the archived
trees. Each heading names the pre-registered check, so any of them can be reproduced with
`node benchmark/quality/grade.js <tree> --suite <task>`.

### `C8` / `I4` — a malformed request returns the stack trace

One request with a truncated JSON body. **Both apps answered 400 — only one of them is safe.**

Without Strata (`exp-v12/trees/catalog-baseline-haiku-2`), graded `LEAKS STACK TRACE`:

```html
HTTP/1.1 400 Bad Request
Content-Type: text/html; charset=utf-8

<!DOCTYPE html>
<html lang="en"><head><title>Error</title></head><body>
<pre>SyntaxError: Unexpected end of JSON input
    at JSON.parse (&lt;anonymous&gt;)
    at parse (C:\Users\...\node_modules\body-parser\lib\types\json.js:96:19)
    at C:\Users\...\node_modules\body-parser\lib\read.js:128:18
    at AsyncResource.runInAsyncScope (node:async_hooks:206:9)
```

HTML from a JSON API, the parser's internals, and absolute paths from the server's filesystem — handed
to whoever sent the bad byte.

With Strata (`exp-v22/trees/idempotency-strata-haiku-1`):

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "malformed JSON in request body",
  "details": [
    { "field": "body", "message": "could not be parsed as JSON" }
  ]
}
```

The same 400, in the same envelope as every other error on the API, telling the caller what to fix and
nothing else.

**Failed in 6 of 6 unaided runs across both tasks; passed in 6 of 6 with Strata.** Nothing in the
failing sessions' own output mentions it.

### `I3` — a retried order with a different body is accepted

```
POST /orders   Idempotency-Key: k-1   {"items":[ A ]}   →   201 Created
POST /orders   Idempotency-Key: k-1   {"items":[ B ]}   →   200 OK    ← order A returned
```

Graded `same key + different body → 200 (want 4xx)`. This is the subtle half of idempotency and the
half a naive implementation misses entirely: returning the *first* order's response for a genuinely
different request is silent data loss. The client believes its second, different order exists. Correct
answers are 409 or 422.

**Failed in 3 of 3 unaided runs; passed in 3 of 3 with Strata.**

### `C2` — the declared page size is ignored

```
GET /products?limit=5   →   200 OK, 10 items
```

Pagination that returns whatever it likes. Nothing errors and nothing logs; the bug reaches whoever
consumes the endpoint. One unaided run in three.

### Unasked-for edits, and an unpredictable footprint

The idempotency prompt is *"if a client retries the same order request it should not create two
orders."* It never mentions the data model. **One unaided run in three rewrote `prisma/schema.prisma`;
no Strata run touched it.**

The wider result is about predictability rather than any one file. Across three runs of the same
prompt, the unaided arm touched **six different files, and only three of them in every run** — you
cannot know in advance which files come back changed. Strata touched **the same ten files in all three
runs**: an identical footprint, run to run.

Strata writes *more* lines than the unaided arm (~1,500 against ~230), and that is not a defect being
hidden — most of it is `strata/verify.js` and the composed package, which exist precisely so the
delivery can be checked. The number worth comparing is which of *your* files changed, not how many
lines arrived.

## What it does the same way twice

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/consistency-dark.svg">
  <img src="assets/consistency-light.svg" alt="Quality of every individual run. Without Strata the results scatter; with Strata every run of a task lands on the same score." width="760">
</picture>

Run one task three times with one model and the interesting question is not *"was it good"* but
**"was it the same"**.

| task | without Strata | **with Strata** |
|---|---|---|
| catalog | 63%, 75%, 75% | **100%, 100%, 100%** |
| idempotency | **14%**, 71%, 71% | **100%, 100%, 100%** |
| stripejune | 0%, 0%, 50% | 0%, 100%, 100% |

On the two tasks the library covers well, **every Strata run of a task returns the identical score** —
a standard deviation of 0.0 against baseline's 26.9 points on idempotency. Strata does not beat the
ceiling; a good baseline run reaches 86% at best. It reaches it *every time*.

The idempotency 14% is stable across repeat gradings, not a grading artefact. That session invented an
order API whose create endpoint rejected all five request shapes the grader tried, and because every
other property depends on creating an order, five checks became undemonstrable at once. **A cliff, not
a slightly worse result** — and nothing in the session's own output says it happened.

---

## Where it does not hold

**stripejune is published with its failures intact.** Both arms produce a build that does not run:
baseline never wrote an entry point in one run, and Strata shipped `bullmq@5.81.3` pinned beside
`redis@4.7.1` in another, which cannot `npm install`. Both packages are model-chosen — Strata covers
the webhook and nothing else on that task.

That is the rule the whole board obeys: **Strata's advantage tracks how much of the task its library
actually covers.** Four capabilities asked for, one covered, and the cost ratio lands at 0.95× — a wash.

**Strata also declines outright**, on roughly a third of tasks, where composing and verifying delivered
code costs more than writing it. A decline is the correct outcome there, not a miss.

---

## Method

**Pre-registered.** Every check was written from the task prompt alone and committed before the first
run of that task. The suite file and the code that runs it are hashed together and the hash is recorded
on every result, so scores produced by different instruments are never averaged.

**Negative controls.** Each check has a matching mutation that breaks the property it tests, and the
control asserts the check goes red. A check that cannot fail is not a check. All of them discriminate.

**Graded independently.** `strata/verify.js` is generated by Strata, so it is never the grader — that
would be marking its own homework. Grading is a separate suite that knows nothing about which modules
were delivered.

**Runs that did not run are not runs.** Sessions killed by a rate limit or a usage cap are recorded
with `synthetic: true` and excluded; so is any run whose arm did not apply. Counting them once
understated Strata by mixing dead sessions into the mean. Grading also waits for the run's tree to
settle and requires two agreeing passes, because grading a batch too early reads a half-written tree.

**Reproducible, with one stated limit.** Every output tree is archived, so the code each session wrote
is published — the app, its wiring, and the generated verifier. The delivered **module source is not**:
modules live in the hub and are delivered to a project at call time, and the library is not shipped.
Baseline arms use no modules, so those trees are complete and re-gradable as they stand. For Strata
arms the app-level code and the verifier are published, but re-grading them end to end requires the
modules, which means running Strata.

```bash
node benchmark/quality/negative-control.js   # prove the checks can fail
node benchmark/quality/grade.js --all        # re-grade every archived tree
node benchmark/quality/matrix.js             # recompute the board above
```

---

## Tasks

| Task | Prompt | Shape |
|---|---|---|
| catalog | cursor pagination, per-IP rate limiting, traceable request logging | brownfield |
| idempotency | retry-safe order creation, body validation, attempt logging | brownfield |
| stripejune | Stripe webhooks with signature verification, email confirmation, queued PDF receipt | greenfield |

---

## Artifacts

| Path | Contents |
|---|---|
| `benchmark/runs/exp-v12/*.json` | catalog, both arms — one record per run: turns, tokens, cost, wall time, modules delivered |
| `benchmark/runs/exp-v20/*.json` | idempotency baseline and stripejune, both arms |
| `benchmark/runs/exp-v22/*.json` | idempotency Strata arm, re-run after the nested-list fix |
| `*/GRADES.json` | every check result, with the instrument hash and the failing check ids |
| `benchmark/quality/suites.js` | the pre-registered checks |
| `benchmark/quality/grade.js` | the grader |
| `benchmark/quality/negative-control.js` | the mutations proving each check can fail |
| `benchmark/quality/matrix.js` | recomputes the published board from the raw records |
| `benchmark/quality/failed-checks.js` | which checks failed, per run |
| `benchmark/quality/analyze-cost.js` · `analyze-reads.js` | where the cost goes |
| `scripts/render-savings-svg.js` · `render-consistency-svg.js` | the two charts, rendered from the run records |

**What is not published.** The output trees are archived locally but stay out of the repo: they are
tens of megabytes of reinstallable `node_modules`, and on Strata arms they contain delivered module
source, which lives only on the hub. Raw session transcripts are not published either — they record
host paths and full agent conversations. Every figure on this page is recomputable from the run records
and `GRADES.json` above; re-running the grader end to end additionally needs the trees, and for the
Strata arms, Strata.

---

## Earlier measurements

The five-arm, 60-run battery that produced Strata's first published board — a cheap model with Strata
(92.1%) beating a frontier model without it (83.9%) — ran on an **earlier prompt instrument**. Its
numbers are not comparable with the board above and are kept separately, unedited:
[`docs/archive/BENCHMARK-2026-07.md`](archive/BENCHMARK-2026-07.md).
