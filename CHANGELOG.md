# Changelog

## v1.1 — hand over the result, not the homework

Strata composes verified backend modules into your project. v1.1 changes what happens *after* it
writes them.

Before, a delivery ended with a list of things to do — install this, run that, read the verifier. The
session then did all of it, and the doing was most of the bill. v1.1 does that work in the engine,
before it answers, and opens with the outcome.

### The delivery leads with the result

```
=== VERIFICATION: 15/15 CHECKS PASSED — run by the engine before this reply (strata/verify.js) ===
  PASS  server boots and answers /health
  PASS  /products paginates with hasMore + nextCursor
  PASS  a sort field that is not allowlisted is REJECTED, not honoured
  PASS  a burst past capacity yields 429 + Retry-After
  ...
  15/15 checks passed — every delivered module is exercised above.
```

Strata runs `npm install` and the generated verifier itself, then reports what happened. The first
line you read is the outcome of a real run, not a suggestion to go and check.

### The verifier says what it did NOT check

A pass used to read the same whether it had proven the whole delivery or a fraction of it. Now the
scope is named:

```
  12/12 checks passed.
  exercised above: observability.logging.v1, validation.request.v1
  NOT exercised by any check above: api.idempotency.v1
  Those modules were delivered. Nothing here proves them.
```

This matters more than it looks. On one measured task the old wording reported `8/8 CHECKS PASSED`
where every check belonged to a different module and nothing tested the delivered feature at all.

### Smaller delivery, and nothing undisclosed

- **78 KB → 42 KB.** The unit-test layer is no longer copied into your project, and the readable copy
  of the implementation is removed once it is installed as a dependency.
- Every file Strata writes or edits is named in the response. No exceptions.

### `strata preset`

Adds Strata's usage notes to `~/.claude/CLAUDE.md` (or `./CLAUDE.md` with `--project`).

**Strictly additive by construction.** It appends a marked block, or replaces the block it wrote
itself. It never rewrites, reorders, or trims a line you wrote — the property is asserted on the real
content before anything touches disk, and the write is refused if the assertion fails. `--remove`
takes it back out; `--show` prints it without writing.

### Fixes

- **Auto-verification never ran for anyone.** An early return on the hub path skipped it entirely, and
  hub mode is the default for every install. The single highest-leverage part of the delivery had never
  executed outside a local test.
- **Module selection was blind to word endings.** `api.idempotency.v1` — named *"Idempotency Keys for
  Express"* — scored zero against the word "idempotent", because `"idempotency"` does not contain
  `"idempotent"`. It lost its own task to two less relevant modules.
- **`FILES CREATED` over-reported.** It listed files from the plan rather than from what was written.
- **`validation.request.v1` accepted an empty list for a required field.** `items: []` satisfied
  `required`, so an empty order was created and returned 201.

---

## How Strata measures right now

Every number below is `n=3`, Claude Haiku 4.5, one task per cell, graded against a suite neither arm
can see — never by the verifier Strata generates, which would be marking its own homework.

### Catalog — pagination, rate limiting, request logging

| | baseline | **Strata** | |
|---|---|---|---|
| turns | 31.3 | **15.0** | 0.48× |
| cost | $0.190 | **$0.077** | **0.40×** |
| wall time | 190s | **63s** | 0.33× |
| quality | 70.8% | **100%** | |

Per run: baseline 5/8, 6/8, 6/8 — Strata **8/8, 8/8, 8/8**. No overlap between the arms on any axis:
the worst Strata run beats the best baseline run on turns, cost, time and quality alike.

### Payments — Stripe webhooks, plus emailed PDF receipts on a background queue

| | baseline | **Strata** | |
|---|---|---|---|
| turns | 48.7 | **43.7** | 0.90× |
| cost | $0.406 | **$0.385** | 0.95× |
| quality | 16.7% | **66.7%** | |

Per run: baseline **0/8, 0/8, 4/8** — Strata **0/8, 8/8, 8/8**.

This is the hardest task in the set and the most honest one to publish, because both arms produce a
build that does not run. Baseline's first run never wrote an entry point at all. Strata's first run
shipped an unsatisfiable dependency tree — `bullmq@5.81.3` needs `redis >= 5`, pinned beside
`redis@4.7.1`, so `npm install` fails outright. Both of those packages were chosen by the model:
Strata has no recall for queues or PDF generation, and covers only the webhook.

The lesson is the same one the cost figures show. Strata's advantage tracks how much of the task its
library actually covers. Here it covers one capability out of four, and the numbers move accordingly —
0.95× on cost, which is a wash.

### The number we think actually matters

Run the same task three times and the interesting question is not "was it good" but **"was it the
same"**. On an order-idempotency task — *"if a client retries the same order request it should not
create two orders"*:

| | baseline | **Strata** |
|---|---|---|
| quality, run by run | **14%**, 71%, 71% | **86%, 86%, 86%** |
| standard deviation | **26.9 points** | **0.0 points** |
| turns | 27.7 | **21.7** (0.78×) |
| cost | $0.175 | **$0.134** (0.77×) |
| lines of code written | 201 | 46 |
| project files touched | 4.0 | 0.3 |

The 14% run is not a fluke and not a grading artefact — it scores the same on repeat passes. The
session invented an order API whose create endpoint *"rejected all 5 shapes"* the grader tried, and
because every other property depends on being able to create an order at all, five checks became
undemonstrable at once. That is the shape of the risk: not a slightly worse result, a **cliff**, and
nothing in the session's own output says it happened.

Baseline also edited `prisma/schema.prisma` — the database schema — on a task that never mentions the
data model, and across three runs touched six different files with only two written every time. You
cannot predict which files come back changed.

Strata does not beat the ceiling; a good baseline run reaches the same 86%. **Strata reaches it every
time.**

### What we do not claim

- **One model, one task per cell.** Nothing here speaks to Sonnet or Opus.
- **Cost is the least stable number we report.** It moves with the model, the prompt and the machine.
  The variance figures do not.
- **Strata declines work it cannot help with** — a single-module greenfield task costs more with it
  than without, and it says so rather than composing anyway.
- **It is weaker than an unaided model at validating nested data.** Generated validation checks that a
  list is present and non-empty; it does not yet check the shape of items inside it, and a hand-written
  route does. Known, logged, and being fixed.
- `n=3` is thin for a variance claim. It is the honest size of what has been run, not a chosen one.
