#!/usr/bin/env bash
# Strata automated benchmark harness.
#
# Replaces the entire manual loop (mkdir → VS Code → launch claude → wait for MCP → prompt →
# auto-accept → wait → copy the cost screen → paste into a report → "check stripe 21"). Each task
# runs as a headless `claude -p` process — a genuinely fresh, separately-billed session, which is
# the ONLY way to get a valid isolated cost number (subagents share the parent's billing/context).
#
#   baseline arm  → strata NOT connected (--strict-mcp-config + empty config) + "Don't use Strata"
#   strata   arm  → ONLY strata connected, cold-spawned per run (picks up current dist/ + allowlist)
#
# Output: one result.json per run (parse with report-bench.sh). Resumable: a run with an existing
# result.json is skipped, so an interrupted sweep continues where it stopped.
#
# Needs `--dangerously-skip-permissions` because the child sessions run npm/node/curl/Write with no
# human to approve each call. Runs only in throwaway external dirs building benign Express apps.
set -u

ROOT="${STRATA_BENCH_ROOT:-${TMPDIR:-/tmp}/strata-bench-auto}"
DIST="${STRATA_DIST:-$(cd "$(dirname "$0")/../.." && pwd)/dist/src/mcp-server.js}"
STRATA_MCP="{\"mcpServers\":{\"strata-lib\":{\"command\":\"node\",\"args\":[\"$DIST\"]}}}"
EMPTY_MCP='{"mcpServers":{}}'
MODEL="${STRATA_BENCH_MODEL:-sonnet}"
TIMEOUT="${STRATA_BENCH_TIMEOUT:-1500}"

# Task prompts — the pinned, fully-specified prompts from MANUAL TESTS/MULTI TESTS/AB-PROTOCOL.md.
# Baseline appends "Don't use Strata." at runtime.
declare -A TASKS
TASKS[stripe]="Build a payment processing system in Node.js + Express (plain JavaScript, no TypeScript): Stripe webhooks with signature verification, email confirmation on purchase via Nodemailer/SMTP, and a background job (BullMQ + Redis) that generates a PDF receipt (PDFKit) and emails it."
TASKS[jwt]="Build a user authentication system in Node.js + Express (plain JavaScript, no TypeScript): signup and login endpoints, JWT access + refresh tokens (jsonwebtoken package), hashed passwords, and protected-route middleware. Use an in-memory store for users (no database/ORM). Return the refresh token in the JSON response body, not a cookie."
TASKS[reset]="Build a password reset flow in Node.js + Express (plain JavaScript, no TypeScript): forgot-password request that emails a reset link via Nodemailer/SMTP, and a reset-confirmation endpoint that sets a new hashed password. Use an in-memory store for reset tokens and users (no database/ORM)."
TASKS[chat]="Build a real-time chat server in Node.js + Express using the native ws package (no socket.io): WebSocket rooms, broadcast messaging within a room, and private messages between users. Use in-memory state for rooms and connections (no database)."
TASKS[rbac]="Build role-based access control for an Express API (plain JavaScript, no TypeScript): admin/editor/viewer roles with inherited permissions, and permission-protected routes. Identify the user from x-user-id and x-user-role request headers — don't build a real authentication layer, that's a separate concern. Use in-memory role/permission config (no database)."


# ── TAIL tasks ────────────────────────────────────────────────────────────────
# Packages where the model has a confidently WRONG prior inherited from a popular sibling.
# This is the domain Strata should actually win: it cannot write these from memory, so it has no
# strong belief to override the recall with, and a hallucinated API costs real debug turns.
#   valibot: Zod habit -> schema.parse(data)   REAL: v.parse(schema, data)  (standalone fn)
#   hono:    Express habit -> res.json()/app.listen()  REAL: return c.json(body, status) / serve({fetch: app.fetch, port})
TASKS[valibot]="Write a Node.js script (CommonJS) that validates user signup data using the valibot library. The schema: email must be a valid email, password must be at least 8 characters, and age must be a number of at least 18. Validate three sample inputs (one valid, two invalid), and for each print whether it passed and, if it failed, the validation error messages. Install dependencies and actually run the script to confirm it works."
TASKS[hono]="Build a small JSON HTTP API using the hono framework on Node.js (CommonJS, with @hono/node-server). Routes: GET /health returns {\"ok\":true}; POST /items reads a JSON body {\"name\":...} and returns the created item with HTTP status 201; GET /items/:id returns the id. Listen on the port from the PORT environment variable. Install dependencies, start it, and verify all three endpoints actually work."


# ── LOW-STAKES tasks ──────────────────────────────────────────────────────────
# Every task above this line is auth / payments / crypto — the one class of code a careful model
# SHOULD refuse to accept on trust, and it did: adoption of delivered code was ~0, and the sessions
# that rejected it cited signature verification and unvetted provenance. That is correct behaviour,
# and it means those tasks measure the TRUST bar, not the delivery mechanism.
#
# These three measure the mechanism. Nobody audits a logger. If Strata cannot win here — where the
# code is boring, the stakes are low, and there is no reason to distrust it — it cannot win anywhere.
TASKS[logging]="Build an Express API in Node.js (plain JavaScript, no TypeScript) with production-grade structured logging using pino: a per-request correlated request id that honours an inbound x-request-id header, a child logger on each request so every log line for that request carries the same id, automatic redaction of credentials (authorization header, cookies, and password fields) before anything is written, request/response logging with duration and status code, and a centralized error handler that logs stack traces for 5xx but not for 4xx. Include /health and /users routes."
TASKS[csvimport]="Build a CSV import endpoint in Node.js + Express (plain JavaScript, no TypeScript): POST /import accepts a raw CSV body and validates every row against a schema (email must be a valid email, name at least 2 characters, age an integer of at least 18). Coerce cells to real types, skip bad rows instead of aborting the whole import, and return a JSON report listing per-row errors that name the source line number in the file. Handle a UTF-8 BOM and quoted fields containing commas."
TASKS[retry]="Build a resilient HTTP client in Node.js (plain JavaScript, no TypeScript) for calling a flaky third-party API: per-attempt timeouts, retries with exponential backoff and jitter, honouring Retry-After on a 429, retrying only idempotent methods and retryable status codes (never blindly retrying a POST that may have already succeeded), and a circuit breaker that fails fast after repeated failures and probes for recovery. Expose it through a small Express endpoint that proxies to the upstream."


# ── THE DECISIVE CELL: complex AND low-stakes ─────────────────────────────────
# Every task above is either complex-but-high-trust (stripe/jwt — blocked by the audit wall, 0/3
# adoption) or low-stakes-but-small (logging/csv/retry — adopted 6/6, but too few turns to amortize
# Strata's ~12-turn context tax, so it loses on cost even while cutting output 43%).
#
# Cost is context x turns, and Strata's only real lever is TURNS. Turn savings require a task with
# enough turns to save. So the cell that decides Strata is the one we never tested: big enough to
# amortize the tax, boring enough that nobody audits it. This composes FOUR low-stakes recalls.
TASKS[platform]="Build a product catalog API service in Node.js + Express (plain JavaScript, no TypeScript) with four things. (1) Structured logging with pino: a per-request correlation id honouring an inbound x-request-id header, a child logger per request so every line shares the id, redaction of authorization headers and password fields, request/response logging with duration, and a centralized error handler that logs stack traces for 5xx but not 4xx. (2) A token-bucket rate limiter returning 429 with Retry-After, plus a TTL response cache on read endpoints with an x-cache HIT/MISS header. (3) A GET /products list endpoint with cursor pagination (returning hasMore and nextCursor), multi-field sorting, and filtering, where the sortable and filterable fields are allowlisted so a caller cannot sort on an arbitrary column. (4) A POST /products/import endpoint that accepts a raw CSV body, validates each row (name required, price a number >= 0, sku required), coerces cell types, skips bad rows instead of aborting the import, and returns a report naming the source line number of every failure."


# ── BROWNFIELD / TAIL ─────────────────────────────────────────────────────────
# Two things were wrong with every benchmark before this one:
#
#   1. GREENFIELD. Empty dirs. No schema, no entities, no conventions — so Imprint had nothing to
#      read and Strata could only ever be a snippet library, never a compiler.
#   2. HEAD TASKS. Structured logging, CSV import, pagination, JWT, Stripe — the most-written code on
#      earth. The model writes them correctly from memory, first try. We were fighting on its home
#      turf, where its advantage is largest and Strata's ceiling is lowest.
#
# A project's OWN code is TAIL by definition: nobody trained on your repo, your entity, or your
# conventions. This task is large (clears the ~18-turn break-even), boring (no audit wall), and built
# on a schema the model has never seen. That is the cell the whole thesis lives in, and it has never
# been tested.
declare -A FIXTURES
FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures" && pwd)"

FIXTURES[catalog]="catalog-service"
TASKS[catalog]="This is an existing catalog-service project — read the README, the Prisma schema, and the existing code first. Add four things to it. (1) A GET products list endpoint with cursor pagination (returning hasMore and nextCursor), multi-field sorting, and filtering — the sortable and filterable fields must be allowlisted so a caller cannot sort on an arbitrary column. (2) A CSV import endpoint for products that validates every row against the Product schema, coerces cell types, skips bad rows instead of aborting the whole import, reports the source line number of each failure, and persists the valid rows through the existing repository. (3) Structured logging with pino: a per-request correlation id honouring an inbound x-request-id header, a child logger per request, redaction of authorization headers and password fields, and a centralized error handler that logs stack traces for 5xx but not 4xx. (4) A token-bucket rate limiter returning 429 with Retry-After. Follow the project's existing conventions."

ORDER="${STRATA_BENCH_TASKS:-stripe jwt reset chat rbac}"
ARMS="${STRATA_BENCH_ARMS:-baseline strata}"

# CRITICAL: the session's working directory ($dir) must contain ONLY what the session itself
# creates — like a real manual run. Earlier the harness redirected result.json + stderr.log INTO
# $dir, and sessions tripped over them (ls → read stderr.log → wc result.json), burning turns and
# polluting the workspace a manual run never has. Bookkeeping now lives in a SEPARATE $OUTDIR.
OUTDIR="$ROOT/_out"

run_one() {
  local id="$1" arm="$2" rep="${4:-1}"
  local cell="$id-$arm-r$rep"
  local dir="$ROOT/$cell"
  local out="$OUTDIR/$cell.json"
  local err="$OUTDIR/$cell.stderr"
  # A run that died on the session limit still writes a well-formed result.json — with is_error:true,
  # 1 turn, and total_cost_usd: 0. The old check only asked "is total_cost_usd non-null?", so those
  # corpses counted as finished results: the resume path SKIPPED them, and the reporter averaged
  # $0.00/1-turn rows into the means. A limit-killed run must be treated as no result at all.
  if [ -f "$out" ] && node -e "
    const j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.exit(j.total_cost_usd != null && j.is_error !== true && j.num_turns > 1 ? 0 : 1);
  " "$out" >/dev/null 2>&1; then
    echo "skip   $cell (already has result)"
    return
  fi
  rm -rf "$dir"; mkdir -p "$dir" || return 1

  # BROWNFIELD. Every benchmark until now started in an EMPTY directory — which structurally
  # disables the one mechanism that makes Strata a compiler rather than a snippet library: there is
  # no schema to read, no entity to resolve, no repository to wire, no conventions to honour. We
  # were grading Strata with its most powerful mechanism switched off, on the model's home turf.
  # A task with a FIXTURE gets a real pre-existing project copied in first, for BOTH arms.
  local fixture="${FIXTURES[$id]:-}"
  if [ -n "$fixture" ]; then
    cp -r "$FIXTURE_ROOT/$fixture/." "$dir/" || return 1
  fi
  local port="$3"
  local prompt="${TASKS[$id]}"
  local mcp="$EMPTY_MCP"
  if [ "$arm" = "strata" ]; then mcp="$STRATA_MCP"; else prompt="$prompt Don't use Strata."; fi
  # PORT is exported so scaffolds/servers that read process.env.PORT bind a unique port and don't
  # collide across parallel runs. We do NOT tell the session "test it locally" — that nudge pushed
  # sessions into unbounded boot/curl/taskkill churn a human would never allow. Let the session
  # decide its own verification depth, exactly like a manual run; the env var just prevents port
  # clashes if it does choose to boot.
  echo ">>>>   $cell  starting on port $port  ($(date +%H:%M:%S))"
  # env -u strips any API-key vars so `claude` is FORCED to use the logged-in subscription
  # (OAuth) account — never API billing. Runs count against weekly subscription usage exactly
  # like an interactive session; there is no separate or additional charge for headless mode.
  ( cd "$dir" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY_HELPER \
      PORT="$port" \
      timeout "$TIMEOUT" claude -p "$prompt" \
      --output-format json --model "$MODEL" \
      --dangerously-skip-permissions \
      --strict-mcp-config --mcp-config "$mcp" \
      > "$out" 2> "$err" )
  local cost; cost=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).total_cost_usd??'ERR')}catch(e){console.log('ERR')}" "$out" 2>/dev/null)
  echo "done   $cell  cost=$cost  ($(date +%H:%M:%S))"
}

# Parallel scheduler with a concurrency cap. Runs overlap to cut wall-clock time, but cost/turns/
# tokens are per-session and concurrency-independent, so the numbers stay valid. The cap keeps us
# under subscription rate limits and machine resource pressure (too many concurrent npm installs).
# NOTE: duration_ms becomes meaningless under parallelism (runs overlap) — read cost/turns/tokens,
# not wall time, from parallel results.
CONCURRENCY="${STRATA_BENCH_CONCURRENCY:-4}"
mkdir -p "$ROOT" "$OUTDIR"
echo "Strata benchmark harness — model=$MODEL  concurrency=$CONCURRENCY  root=$ROOT"
echo "tasks: $ORDER | arms: $ARMS"
echo "========================================================"

# Build the job list (rep-aware: REPS runs per cell to see through the variance that has
# defeated every single-sample conclusion in this project)
REPS="${STRATA_BENCH_REPS:-1}"
JOBS=()
for id in $ORDER; do for arm in $ARMS; do for rep in $(seq 1 "$REPS"); do JOBS+=("$id:$arm:$rep"); done; done; done

launched=0
portn=3001
for job in "${JOBS[@]}"; do
  IFS=':' read -r id arm rep <<< "$job"
  run_one "$id" "$arm" "$portn" "$rep" &
  portn=$((portn + 1))
  launched=$((launched + 1))
  # After every CONCURRENCY launches, wait for that batch to drain before starting the next.
  if [ $((launched % CONCURRENCY)) -eq 0 ]; then wait; fi
done
wait  # drain any partial final batch

echo "========================================================"
echo "All runs complete. Parse with: node benchmark/harness/report-bench.js"
