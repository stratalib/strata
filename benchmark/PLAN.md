# Benchmark plan — pre-registered

**Written 2026-07-22, BEFORE any run.** The point of writing it first is that we cannot later choose
the analysis that flatters us. We have already caught one contaminated harness and one vacuous test in
this project; the cure for both is deciding what counts as success while we still don't know the answer.

---

## Arms

| | |
|---|---|
| **baseline** | the agent, no Strata |
| **strata** | the agent with the MCP server available |
| **models** | Claude (quota-limited — the scarce resource) and Gemini 2.5 Pro (GCP credit — effectively free) |
| **n** | 3 per cell |

**Gemini needs its own baselines.** Comparing Gemini-with-Strata against Claude-without measures the
model, not the tool. If runs must be cut, cut **Claude** cells — the Gemini arm costs credit, not quota.

## Tasks

Each runs in ONE designated mode, because that is how the task actually occurs. Tasks 1 and 5 run in
both, to isolate the brownfield effect on its own.

| # | task | capabilities exercised | mode | prediction |
|---|---|---|---|---|
| 1 | Email + password auth with sessions | auth.identity, web.sessions, validation, ratelimit | **both** | win |
| 2 | Admin API with role-based access control | authz.policies, pagination, validation, audit | brownfield | win |
| 3 | Stripe-style idempotent payments endpoint | idempotency, validation, logging | brownfield | win |
| 4 | GDPR "delete my account" flow | softdelete, audit, notifications | brownfield | marginal |
| 5 | Public API: rate limits + cursor pagination | ratelimit, pagination, logging, serialization | **both** | win |
| 6 | Search API with filters and pagination | fulltext, pagination, validation, cache | greenfield | marginal |
| 7 | `platform` (unchanged) | 5 recalls | greenfield | win — the continuity anchor |
| 8 | `retry` (unchanged) | 1 recall | greenfield | **LOSS, and we publish it** |

Tasks 7 and 8 are carried over deliberately: they link to baselines we already measured, and 8 is the
one we expect to lose. *"Strata is negative below ~45 turns, here is the data"* is the most credible
sentence we can put on the site.

## Fixtures

Brownfield runs use the existing fixtures, one per ORM, because entity extraction is ORM-specific —
Mongoose keying on `_id` instead of `id` already caused a real cursor bug that unit tests missed.

- `benchmark/fixtures/catalog-service` (Prisma)
- `benchmark/fixtures/shop-mongoose` (Mongoose)
- `benchmark/fixtures/orders-drizzle` (Drizzle)

**Reset with `git checkout`, never `rm -rf` on a shared directory.** Every run starts from an
identical tree.

## Metrics

**Primary: turns.** Cost is `context × turns`; everything else follows from it.

**Secondary:** input tokens, output tokens, dollar cost, wall time.

**Two gates that override the primary metric:**

1. **Correctness** — did the feature actually work? `verify.js` passing is necessary, not sufficient;
   one manual check per run. *A cheaper wrong answer is not a win.*
2. **Adoption** — did the model keep the delivered code, or quietly rewrite it? Measured **by content,
   not by import path** — a model that copies the logic and drops the import has still adopted it.

A run that is 30% cheaper with 0% adoption is a failure, not a win.

## Success criteria — decided now

A cell counts as a **win** when all three hold:

- turns drop in **≥ 2 of 3** runs, **and**
- adoption **≥ 60%**, **and**
- correctness is **3 of 3**.

Anything else is a loss or inconclusive, and is published as such.

## Reporting rules

- **No single percentage.** At n=3, "−25%" is not defensible. Report **win rate + observed range**:
  *"turns fell in 3 of 3 runs, by 18–31%."*
- **Losses are published.** Especially task 8.
- **No re-running a cell we dislike.** A re-run happens only on a *harness* fault, and is logged as
  one, with the fault named.
- The coverage figure (51%) rests on a **single** 100-task sample. A second independent sample runs
  before that number appears anywhere public.

## Known threats to validity

- **n=3 cannot separate small effects from noise.** Hence win-rate reporting rather than point estimates.
- **We wrote the tasks.** They are drawn from the measured taxonomy rather than invented to flatter,
  but they are not an independent sample. The 100-task blind set is the corrective.
- **Baseline drift.** Existing Claude greenfield baselines were measured on an older model build; if
  the model has changed underneath us, they are not comparable and must be re-run. Check before reuse.
- **The agent knows it is being tested** in neither arm — but the Strata arm has a tool advertised in
  its context, which is itself a nudge. This is unavoidable and worth stating.
