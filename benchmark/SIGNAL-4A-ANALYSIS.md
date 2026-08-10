# Signal 4a — Usage Analysis Report
**Benchmark:** 2026-06-22 · Haiku 4.5 · 12 tasks · 507 recalls loaded  
**Headline:** 45.8% cost savings, 32.6% token savings, 0 retries

---

## 1. What Actually Drives the Savings

The top-line result hides two completely different mechanisms working simultaneously. Understanding which one is responsible for what determines what we build next.

### Mechanism A — Content Anchoring
Claude uses actual functions from the delivered recall. It imports them, calls them, skips reimplementing them. Token reduction is proportional to how many functions it doesn't have to write.

### Mechanism B — Constraint Framing
The system prompt says: *"Write ONLY glue code. Do NOT reimplement anything the strata file provides."* This framing forces a minimal, focused output regardless of whether the recall content is relevant.

**The critical evidence:** Task 9 (RBAC) injected three completely wrong recalls (`rest-to-graphql-mapping`, `api.middleware.error.v1`, `kubernetes-service`). None relevant to RBAC. Yet it saved **72.3%** (895 vs 5,048 output tokens). The baseline wrote a full RBAC system with extensive documentation, error handling prose, and repetition. V2's constraint framing made Claude write exactly what was asked, nothing more.

This means Strata has **two sources of value** that must be measured separately:

| Source | Primary driver | When it fires |
|--------|---------------|---------------|
| Content anchoring | Right recall, right exports | Tasks where recall maps to domain |
| Constraint framing | System prompt instruction | All tasks with any recall injected |

Both are real. Neither is sufficient alone. If we only deliver constraints with no recall content, Claude still saves tokens but the code quality degrades. If we deliver perfect recalls with no constraint framing, Claude still rewrites things.

---

## 2. The Three Savings Tiers

Sorting tasks by output token savings reveals a clear pattern:

### Tier 1 — High compression (49%–72%)
Tasks where the baseline would generate verbose, repetitive, or exploratory output.

| Task | Baseline out | V2 out | Reduction |
|------|-------------|--------|-----------|
| RBAC (Task 9) | 5,048 | 895 | 82.3% |
| Push Notifications (Task 4) | 3,165 | 1,319 | 58.3% |
| Full-Text Search (Task 5) | 3,557 | 1,379 | 61.2% |
| User Auth (Task 1) | 2,999 | 1,708 | 43.0% |

The RBAC result is the most extreme: baseline Claude wrote extensive RBAC with full docstrings, a permission hierarchy explanation, example usage, and redundant checks. V2 wrote a clean 118-line implementation and stopped.

### Tier 2 — Moderate compression (20%–40%)
Tasks with domain recall hits. Claude anchored to the recall exports and wrote thin wiring.

| Task | Baseline out | V2 out | Reduction |
|------|-------------|--------|-----------|
| Cursor Pagination (Task 7) | 1,731 | 687 | 60.3% |
| Email Service (Task 2) | 3,178 | 1,975 | 37.8% |
| Password Reset (Task 12) | 2,940 | 2,125 | 27.7% |
| Comments API (Task 6) | 2,391 | 1,357 | 43.3% |

### Tier 3 — Near-zero or overhead
Tasks that are short to begin with, or where Claude uses native APIs directly rather than any recall.

| Task | Baseline out | V2 out | Delta |
|------|-------------|--------|-------|
| JWT Middleware (Task 11) | 1,002 | 635 | +5 overhead |
| Shopping Cart (Task 8) | 1,768 | 1,394 | +66 overhead |
| Chat WebSocket (Task 10) | 1,948 | 1,386 | 7.1% |

**The overhead cases are not failures.** They're tasks where the baseline was already concise. The +5 and +66 token overheads are the cost of the constraint injection itself. They're acceptable. The issue is that we're not achieving content anchoring on these tasks — only constraint framing — so we barely break even.

---

## 3. JWT Over-Injection: The Single Largest Waste

`signedToken` was ignored **5 times**. `decodedPayload` was ignored **4 times**. Both come from a single recall: `auth.jwt.tokenhandling.v1`.

This recall appears in: Shopping Cart, Push Notifications, Full-Text Search, JWT Middleware, Password Reset. That's every task decompose tagged with anything auth-adjacent.

The root problem: decompose generates "JWT authentication" or "token management" as a capability for almost any task that mentions users. Then `auth.jwt.tokenhandling.v1` scores high because its tags include `["auth", "jwt", "token", "sign", "refresh"]` — all generic enough to match half the library.

**The cost:** every JWT injection adds ~120 tokens to input (the signature block in the system prompt). Across 5 spurious injections, that's ~600 input tokens wasted. At Haiku pricing ($0.80/M), that's noise. But the signal is what matters: we're injecting a recall into tasks where it cannot possibly help, burning one of MAX_ASSEMBLY=3 slots, and crowding out a potentially useful recall.

In Task 4 (Push Notifications), that slot could have been a `notifications.fcm.v1` recall (which doesn't exist yet). In Task 8 (Cart), that slot could have been `auth.session.express.v1` (which does exist and would have been relevant).

**Fix path:** Add a domain specificity guard in `mapCapabilitiesToRecalls`. If a capability maps to a generic auth recall AND the task prompt contains specific package names (FCM, express-session, socket.io), deprioritize the generic auth recall unless its domain exactly matches.

---

## 4. Recall Export Gap Analysis

### 4a. JWT recall: wrong abstraction level
The recall's `implementation.js` exposes `execute(inputs)` — an action-dispatch pattern requiring `{action: 'verify', token, secret}`. Its metadata exports `signedToken` and `decodedPayload` as output names — these are **values returned from execute(), not callable functions**.

Claude treats them as functions: `decodedPayload(token, secret)`. In Task 11:
```javascript
const payload = decodedPayload(token, secret);  // Claude calls it as a function
```
This works because Claude adapts intelligently, but it's API friction. The recall's interface contradicts how Claude uses it. This causes the `signedToken` ignored count — Claude can't use a token-value in most contexts, so it ignores it.

**Fix:** Add direct function exports to the recall — `verifyJWT(token, secret)` and `signJWT(payload, secret)` — instead of the action-dispatch pattern.

### 4b. Cursor recall: missing encode/decode in outputs
`database-cursor-pagination` metadata says outputs are `[items, nextCursor, prevCursor, hasMore, count]`. Nothing about cursor encoding. But every cursor pagination implementation needs `encodeCursor` and `decodeCursor`.

In Task 7, Claude invented both from scratch:
```javascript
const encodeCursor = (timestamp, id) => Buffer.from(`${timestamp}:${id}`).toString('base64');
const decodeCursor = (cursor) => { ... Buffer.from(cursor, 'base64').toString('utf-8') ... };
```
These should live in the recall. They're predictable, reusable, and represent the most error-prone part of cursor pagination (base64 decode errors, split logic, type coercion).

**Fix:** Add `encodeCursor(timestamp, id)` and `decodeCursor(cursor)` to the cursor recall's implementation and outputs list.

### 4c. RBAC recall not found by decompose
`auth.rbac.express.v1` exists in the library with exactly the right exports: `requirePermission`, `checkRole`, `assignRole`. But Task 9 decompose generated something like "GraphQL mapping" or "service routing" instead of "RBAC middleware". The recall was never in the candidate pool.

**Root cause:** The decompose prompt asks for domain-specific modules. "role-based access control middleware" is the right description, but the recall's tags may not match the capability string decompose produces. The recall tags are too terse (`["rbac", "middleware", "auth", "permissions"]`) for a fuzzy search to bridge the gap reliably.

**Fix:** Improve the recall's tags with task-description phrases: `["requirePermission", "checkRole", "assignRole", "role-based access control express middleware", "permission check middleware"]`. Tags should include the exact function names users ask for.

---

## 5. Missing Recalls (Invented Function Backlog)

These functions were invented by Claude across tasks. They don't exist in any delivered recall. High-frequency invention = recall candidate.

### `notifications.fcm.v1` (Priority: HIGH)
Task 4 invented 7 functions: `handleFCMError`, `addDeviceToken`, `removeDeviceToken`, `getUserTokens`, `getAllUsers`, `sendToUser`, `broadcastToAll`. This is a complete, self-contained module. Claude wrote it correctly and cleanly in one shot. A real recall would eliminate ~800 output tokens per FCM task.

The invented code is already production-quality — it handles invalid token cleanup, quota errors, and multicast. It should be extracted directly into a recall.

### `search.in-memory.v1` (Priority: MEDIUM)
Task 5 invented 5 functions: `searchProducts`, `filterProducts`, `sortProducts`, `paginate`, `executeSearch`. The `database-fulltext-search` recall that was injected is SQL-based (Postgres/MySQL). The task asked for in-memory search over a JS array. Domain match failed because the recall targets a different storage layer.

Two options: (a) create a separate `search.in-memory.v1` recall, or (b) add a storage-layer tag to the existing recall so decompose can distinguish "in-memory array search" from "database full-text search".

### `auth.rbac.v1` exports (Priority: HIGH)
Task 9 invented 5 functions: `assignRole`, `getPermissions`, `requirePermission`, `checkRole`, `attachUserRole`. The recall exists but wasn't found. Fix the decompose/tag gap first; if it still isn't found, the recall needs better tag coverage.

### `cursor.encode-decode` (Priority: LOW)
Only invented once. But the fix is surgical — add two functions to an existing recall. Low effort, directly eliminates a recurring invented pattern.

---

## 6. The "Baseline Length" Hypothesis

The most actionable insight from the savings distribution: **the savings are proportional to how much the baseline would have written, not to how relevant the recall is**.

| Task | Baseline tokens | V2 tokens | Right recall? | Savings |
|------|----------------|-----------|---------------|---------|
| RBAC | 5,207 | 1,440 | ❌ Wrong | 72.3% |
| Search | 3,682 | 1,874 | ⚠️ Partial | 49.1% |
| Notifications | 3,289 | 1,841 | ❌ Wrong | 44.0% |
| Cart | 1,916 | 1,982 | ⚠️ Partial | -3.4% |
| JWT Middleware | 1,133 | 1,138 | ✅ Right | -0.4% |

Tasks where baseline would write 3,000+ tokens → V2 always saves, even with wrong recalls.  
Tasks where baseline writes <2,000 tokens → V2 breaks even or loses.

**Implication for the Strata vision:** The system will always deliver strong ROI for complex tasks (auth flows, notification systems, search, RBAC) because these are verbose-by-nature. Simple utility tasks (JWT middleware, pagination) are already short — Strata doesn't hurt them but doesn't dramatically help them either.

This suggests the sweet spot for recall injection is **domain-complexity-gated**: only inject when the task scope implies significant output. A simple "build a JWT verifier" task might not need a recall injected at all — the baseline is already 1,000 tokens.

---

## 7. What Works Perfectly and Should Not Be Changed

### Zero retry rate (12/12)
Claude never rejected any assembly, even the obviously wrong ones. The retry mechanism exists as a safety net — it's never been needed. The system prompt constraint is well-calibrated: Claude always finds something useful in the injected recall (even if just `errorResponse` from an error handler) and builds on it.

### `errorResponse` as universal glue
`api.middleware.error.v1` and `api.error.handler.v1` were injected across 7 tasks. `errorResponse` was cleanly used in: File Upload, RBAC, Cursor Pagination, Product Search, JWT Middleware. It's the most-used single export across the entire benchmark.

This is not accidental — `errorResponse(res, message, status)` is a pattern every Express task needs. It's small (fits in the recall signature block), unambiguous (one function, one purpose), and universally applicable. It should be elevated in the library: tagged more aggressively and treated as a default co-injection for any Express task.

### Assembly hash filenames
No naming collisions, no file system issues across 12 concurrent task directories. The `assembly_{hash}.js` naming is stable.

---

## 8. Actionable Next Steps (Priority Order)

### Immediate (this session or next)
1. **Fix cursor recall** — add `encodeCursor(timestamp, id)` and `decodeCursor(cursor)` to `implementation.js` and `outputs` in `metadata.json`. One surgical edit, immediately reduces invented count.
2. **Fix RBAC recall tags** — add function names and natural-language phrases to `metadata.json` tags so decompose finds it. One line edit.
3. **Fix JWT recall interface** — expose `verifyJWT(token, secret)` and `signJWT(payload, secret)` as direct exports. Reduces the `signedToken`/`decodedPayload` confusion.
4. **Add JWT specificity guard** — in `mapCapabilitiesToRecalls`, deprioritize `auth.jwt.tokenhandling.v1` when capability string doesn't contain "jwt" or "token" explicitly.

### Short-term (next milestone)
5. **Create `notifications.fcm.v1`** recall — extract the Task 4 invented output verbatim, clean it up, add metadata. The implementation is already written.
6. **Create `search.in-memory.v1`** recall — extract Task 5 invented functions, parameterize the product array as input.
7. **Add storage-layer tags** to `database-fulltext-search` so decompose distinguishes SQL from in-memory.

### Structural (Step 02 completion)
8. **Compile per-recall fitness signals** — `glue_ratio` (clean uses / total exports delivered) and `reference_rate` (was it ever imported) from this data into `cache/signals.json`. The data is already here; we just need a script to persist it.
9. **Baseline length gate** — in `runWithStrataV2`, skip recall injection for tasks where the estimated output length is below a threshold (use decompose's complexity estimate or prompt length as a proxy). The near-zero savings on short tasks suggests injection overhead is the bottleneck there.

---

## 9. Summary Table

| Finding | Impact | Fix |
|---------|--------|-----|
| Constraint framing is the primary savings mechanism | HIGH | Already working; do not weaken it |
| JWT over-injected into 5/12 tasks | MEDIUM | Specificity guard in mapCapabilitiesToRecalls |
| RBAC recall not found by decompose | HIGH | Fix tags on auth.rbac.express.v1 |
| Cursor recall missing encode/decode | LOW | Add 2 functions to implementation.js |
| JWT recall's action-dispatch API causes friction | MEDIUM | Expose direct function exports |
| No FCM recall → full invention | HIGH | Create notifications.fcm.v1 |
| No in-memory search recall → full invention | MEDIUM | Create search.in-memory.v1 |
| Savings proportional to baseline length, not recall quality | STRUCTURAL | Consider length-gated injection |
| errorResponse is the most universally useful export | POSITIVE | Tag it as default Express co-injection |
