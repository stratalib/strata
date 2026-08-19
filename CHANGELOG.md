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

### Payments — Stripe webhook handling *(n=1, directional only)*

| | baseline | Strata |
|---|---|---|
| turns | 65 | 42 |
| cost | $0.523 | $0.461 |
| quality | 87.5% | 100% |

### The number we think actually matters

Run the same task three times and the interesting question is not "was it good" but **"was it the
same"**. On an order-idempotency task:

| | baseline | **Strata** |
|---|---|---|
| quality, run by run | 86%, **57%**, 71% | **86%, 86%, 86%** |
| standard deviation | **11.7 points** | **0.0 points** |
| lines of code written | 201 | 46 |
| project files touched | 4.0 | 0.3 |

Baseline edited `prisma/schema.prisma` — the database schema — in two of three runs, for a task that
never mentioned the data model. Across three runs it touched six different files, only two of them
every time. You cannot predict which files come back changed.

Strata does not beat the ceiling; baseline's best run reaches the same 86%. **Strata reaches it every
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
