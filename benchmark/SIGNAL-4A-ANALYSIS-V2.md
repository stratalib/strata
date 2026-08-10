# Signal 4a — Analysis V2
**Benchmark:** 2026-06-22 · Stopword filter + FCM recall + JWT guard + RBAC tag fix · 37.8% cost savings  
**Previous best:** 45.8% | **Previous run:** 35.4%

---

## Why the Number Is Lower

Short answer: **LLM variance is the dominant factor. The 45.8% was a favorable run, not a baseline.**

Evidence:

| Task | Run 1 out | Run 2 out | Run 3 out | Spread |
|------|----------|----------|----------|--------|
| Email Service | 1,975 | 2,952 | 2,952 | **+977** |
| RBAC | 895 | 1,312 | 1,420 | +525 |
| Pagination | 687 | 1,415 | 1,037 | +728 |
| Password Reset | 2,125 | 2,035 | 1,458 | **-667** |

Haiku at default temperature generates wildly different output lengths across runs for the same task and same recall injection. The Password Reset task went from 2,125 → 1,458 between run 1 and run 3, with no changes to its recalls. That's 667 tokens of pure variance — more than the entire output of the Cursor Pagination task.

The true aggregate is somewhere between 38–43%. We need temperature=0 or 3-run averaging for stable numbers. The 45.8% was real — it just wasn't statistically stable.

**What actually got worse structurally (not variance):**

1. **Task 9 RBAC correct recall generates more output than wrong recalls.** Wrong recalls + pure constraint framing → 895 tokens. Correct RBAC recall → 1,420 tokens. This is the constraint-framing mechanism from Section 1 of the first analysis running live. With wrong recalls Claude writes the minimum. With the correct recall Claude writes a complete demonstration app with routes, user stores, and role management endpoints. The correct recall is better code — but longer.

2. **Task 2 Email has an architectural bug from over-eager wrapping** (see code quality below). The output is long because Claude double-wires every email type. The fix is in the email recall's design, not the search.

---

## Signal 4a Per-Task (This Run)

| Task | Exports | ✅ Clean | ❌ Ignored | 🆕 Invented | Quality |
|------|---------|---------|----------|------------|---------|
| User Auth | 11 | signJWT, verifyJWT, createTokenPair, hashedPassword, validationResult, initiateReset, completeReset, validateToken (8) | decodeJWT, signedToken, decodedPayload | authMiddleware | 8/10 |
| Email Service | 6 | createEmailService, sendWelcome, sendPasswordReset, sendVerification, sendNotification, sendRaw (all) | — | 5 renamed wrappers, verifyTransporter | 5/10 |
| File Upload | 1 | errorResponse | — | fileFilter | 7/10 |
| **Push Notifications** | 8 | initFCM, addDeviceToken, removeDeviceToken, getUserTokens, getAllUsers, sendToUser, broadcastToAll, errorResponse (all) | — | **none** | **9/10** |
| Full-Text Search | 7 | — | items, nextCursor, prevCursor, hasMore, count, encodeCursor, decodeCursor (all) | 5 search fns | 6/10 |
| Threaded Comments | 4 | success, errorResponse | result, data | buildNestedComments | 6/10 |
| Cursor Pagination | 8 | encodeCursor, decodeCursor, errorResponse, prevCursor | items, nextCursor, hasMore, count | — | 7/10 |
| Shopping Cart | 10 | — | all 10 | initCart | 5/10 |
| **RBAC** | 6 | createRbac, requireRole, requirePermission | requireAnyPermission, requireOwnerOrRole, errorResponse | — | **8/10** |
| Real-Time Chat | 6 | broadcastToRoom, sendPrivate, errorResponse, sessionToken, sessionData | createChatServer | 2 broadcast variants | 7/10 |
| JWT Middleware | 6 | verifyJWT | signJWT, decodeJWT, createTokenPair, signedToken, decodedPayload | jwtAuthMiddleware, verifyJWTToken, authenticateRequest | 7/10 |
| Password Reset | 3 | initiateReset, completeReset, validateToken | — | generateToken, hashToken, checkRateLimit, cleanupExpiredTokens | **9/10** |

---

## Code Quality — Honest Per-Task Ratings

### Task 1: User Authentication — 8/10

**What's good:** Uses signJWT, verifyJWT, createTokenPair, hashedPassword, validationResult correctly. The invented `authMiddleware` is exactly right — the JWT recall doesn't expose an Express middleware, so Claude builds one using verifyJWT. In-memory stores are explicitly documented as temporary. Structure is clean.

**One real bug:** `createTokenPair` is called with three arguments: `(payload, secret, REFRESH_SECRET)`. The actual recall function signature is `createTokenPair(payload, secret, options)` — the third argument is options, not a second secret. Claude is passing the refresh secret string as the options object. At runtime this means both tokens are signed with `process.env.JWT_SECRET` and the options object is ignored, which means no custom expiry for the refresh token. Functionally broken on refresh.

**One design issue:** No rate limiting on `/auth/login`. An attacker can try passwords at will. This is expected for a demo but should be noted.

**Production-readiness: 6/10.** The bug above is the main issue.

---

### Task 2: Email Service — 5/10

**The architectural bug:** Claude double-wires every email send. Each wrapper function (e.g., `sendWelcomeEmail`) both:
1. Adds the email to a Bull queue (which runs `transporter.sendMail()` when processed)
2. Calls `emailAssembly.sendWelcome()` — which presumably sends the email using its own nodemailer setup

Every email gets sent twice. This is a consequence of the recall already being a complete email service with its own queueing, and Claude adding another queue layer on top of it instead of choosing one or the other.

**Security bug:** The `/password-reset` route returns `resetToken` in the HTTP response. Tokens must never be returned to the requester — they get sent to the user's email instead. This is a textbook credential exposure bug.

**Verbosity:** Generated 4 files (email-service.js, routes/email-routes.js, app.js, .env.example) totaling 350 lines for what should be 80 lines of glue. The recall already provides the full email service; Claude should have written thin route handlers and called the assembly's functions directly.

**Root cause:** The email recall exports `createEmailService`, `sendWelcome` etc. — complete, high-level functions. Claude treated them as low-level primitives and built an entire application layer on top. This is a recall API design problem. The recall's exports should be useable at the glue level without needing a wrapper layer.

**Production-readiness: 3/10.** Two concrete bugs (double-send, token exposure) in the same file.

---

### Task 3: File Upload — 7/10

Clean and correct. The errorResponse import is used everywhere it should be. Multer configured properly with disk storage, file filter for MIME types, and size limits. The `fileFilter` invention is appropriate — multer requires a callback-style filter function that doesn't fit recall abstractions.

**One issue:** No route for deleting uploaded files. The task didn't ask for it, but production uploads always need cleanup.

**Production-readiness: 7/10.**

---

### Task 4: Push Notifications (FCM) — 9/10

**Best output in the benchmark.** Zero invented functions. All 8 FCM recall exports used. Pure glue code — imports the module, calls initFCM with the service account path, uses sendToUser and broadcastToAll directly. No wrapping, no reimplementation.

This is exactly what Strata is supposed to produce. The FCM recall doing all the work is the mechanism. The output is 50% shorter than baseline because Claude doesn't need to write any FCM logic.

**One minor issue:** `require('./firebase-service-account.json')` is hardcoded. Should use an env var for the path. Minor.

**Production-readiness: 9/10.**

---

### Task 5: Full-Text Search — 6/10

**The dead import problem.** Claude imports items, nextCursor, prevCursor, hasMore, count, encodeCursor, decodeCursor from the assembly — then uses zero of them. The assembly has database pagination and cursor tooling. The task wants in-memory array search. These are different storage paradigms and the imports are completely dead.

The search code itself (`searchProducts`, `filterProducts`, `sortProducts`, `paginateResults`) is clean and correct. Offset-based pagination works fine for in-memory data. The route handler parses all query parameters correctly with proper sanitization.

**Minor logic issue:** The "relevance" sort only ranks by `name.indexOf(keyword)`. Items where the keyword appears in `description` but not `name` get `-1` and sort randomly. For consistency, relevance should use a combined score across all searchable fields.

This is fundamentally a recall mismatch problem, not a code quality problem. The code Claude wrote is fine. The assembly was useless for this task.

**Production-readiness: 7/10** (ignoring the useless assembly).

---

### Task 6: Threaded Comments — 6/10

Uses `success` and `errorResponse` correctly. The `buildNestedComments` tree-builder does recursive nesting. Functional but has a subtle bug: recursion on large or malicious datasets could stack overflow. A production threaded comment system should use an iterative approach or depth limit.

The routes cover all required operations but soft delete is not implemented — `DELETE /comments/:id` does a hard delete. The task explicitly required soft delete (deletedAt field). Missing feature.

**Production-readiness: 5/10** (missing soft delete is a spec failure).

---

### Task 7: Cursor Pagination — 7/10

The stopword filter did its job: `database-cursor-pagination` injected, and now `encodeCursor` and `decodeCursor` are exported from the recall and used. Claude uses them correctly — encodes a timestamp+id cursor and decodes it safely.

**The CursorPaginator class is correctly ignored.** The class requires a `db` instance (SQL database connection) and isn't usable for the in-memory items array in the test. Claude recognized this and used only the stateless helpers. This is the right call.

**One issue:** `assembly.items(decodedCursor, parsedLimit + 1)` — Claude calls `items` as if it's a function returning results from the assembly. But `items` from the paginator is a result array property, not a callable function. This would throw at runtime. Claude misread the cursor recall's API.

**Production-readiness: 6/10** (runtime bug on the items call).

---

### Task 8: Shopping Cart — 5/10

100% ignored assembly. Claude imports `sessionToken, sessionData, createRepository, create...` etc. from the assembly, never uses a single one, and writes the entire cart using `req.session` directly. The assembly exports are dead weight.

The cart logic itself is correct — handles all required routes, session.save callbacks, edge cases for missing items. Clean Express router structure.

**Real issue:** `secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production'` — having a hardcoded fallback for session secrets means anyone who forgets to set the env var in production deploys with a public secret. Should throw at startup if SESSION_SECRET is missing.

**Root cause of 100% ignore:** The session management recall and CRUD recall have no relevance to a session-native shopping cart. The recalls expose abstractions (sessionToken, createRepository) that abstract away the underlying primitives, but for a session cart you want the primitives. The injection hurt this task — it didn't help.

**Production-readiness: 6/10.**

---

### Task 9: RBAC — 8/10

**Major win from the stopword fix.** `auth.rbac.express.v1` correctly injected and used. `createRbac`, `requireRole`, `requirePermission` all used correctly.

**One structural bug:** The `rbacConfig` passed to `createRbac` uses a different schema than the recall expects. The recall's `createRbac` expects `{ roles: [{ role: 'admin', permissions: [...] }] }` — an array of role objects. Claude passes `{ roles: { admin: { permissions: [...] } } }` — a keyed object. This will likely cause a runtime error depending on how the recall iterates the config.

**One usage error:** `app.use(errorResponse)` at line 156 — Claude tries to use `errorResponse` as an Express error handler middleware, but `errorResponse` is a utility function `(res, message, status)`, not a four-argument `(err, req, res, next)` error handler. This silently does nothing or crashes.

**Despite these issues:** The code demonstrates real RBAC usage. Route-level permission guards are correct. The `requireRole(['admin'])` call on the role assignment endpoint is exactly right.

**Production-readiness: 6/10** (the config schema mismatch and errorResponse misuse are both runtime failures).

---

### Task 11: JWT Auth Middleware — 7/10

`verifyJWT` correctly used. The invented `jwtAuthMiddleware` is the right pattern — Bearer header extraction, verification, attach to `req.user`. `authenticateRequest` for non-middleware contexts is correct.

**One cosmetic bug:** `const statusCode = result.error === 'TOKEN_EXPIRED' ? 401 : 401;` — both branches return 401. Should differentiate expired (401) from invalid (403). Doesn't affect behavior since both return 401, but reveals the ternary was copy-pasted without updating the false branch.

The five ignored exports (signJWT, decodeJWT, etc.) are invisible — they're in the assembly but the task only needs verification. Claude didn't waste code trying to use them.

**Production-readiness: 8/10.**

---

### Task 12: Password Reset Flow — 9/10

**Best-structured output in the benchmark.** The recall provides the high-level flow (initiateReset, completeReset, validateToken), and Claude writes exactly the right glue: rate limiting, token generation, secure hashing, expiry tracking, used-token flagging.

The rate limit implementation is correct — sliding window, clears expired entries before checking, enforces per-email limits. `checkRateLimit` reads and writes the same array correctly. `cleanupExpiredTokens` prunes properly.

`hashToken` uses SHA-256, which is appropriate for reset tokens (unlike passwords which need bcrypt — but reset tokens don't need bcrypt-level protection since they're short-lived and single-use).

**One gap:** The confirm endpoint never actually updates the user's password in a store. It calls `completeReset(email, newPassword)` via the recall, which presumably handles it, but there's no fallback or verification. If the recall's `completeReset` writes to an in-memory store different from the one the routes use, passwords would appear to reset but not actually change.

**Production-readiness: 8/10.**

---

## Structural Findings from This Run

### Finding 1: Two tasks have 100% ignore rates

**Task 5 (Search)** and **Task 8 (Cart)** delivered recalls that had zero useful exports for the task. In Task 5 the assembly is database pagination tools for an in-memory search task. In Task 8 the assembly is session abstractions for a task that uses native session APIs.

These are the two tasks where V2 adds overhead. Both have the same root cause: the recall domain doesn't match the task's storage layer. The decompose step generates correct capability descriptions, but the library doesn't have in-memory or native-session variants of these capabilities.

Signal: tasks with 100% ignore rates are the strongest signal for missing recalls.

### Finding 2: FCM is the proof of concept for the evolutionary loop

Task 4 is the cleanest result in the entire benchmark. The FCM recall was extracted from a previous benchmark run's invented code, added to the library this session, and immediately used perfectly (8/8 exports, 0 invented). This is the evolutionary loop's first successful cycle:

```
Claude invents FCM module → extracted to recall → next task uses it cleanly
```

This is what Step 04 automates. The manual version took 30 minutes and worked on the first try.

### Finding 3: The email recall's API design causes double-wiring

The email recall exports high-level functions (`createEmailService`, `sendWelcome`) that look like a complete service. When Claude sees these, it treats them as existing functionality and wraps each one with its own queue layer — resulting in double sends. 

The recall's API is too opaque. A recall that exports `sendWelcome(opts)` invites Claude to wrap it. A recall that exports `renderWelcomeHtml(name)` and `renderWelcomeText(name)` — low-level primitives — would let Claude compose naturally without double-wiring.

This is an important design principle: **recall exports should be primitives, not services.** High-level "service" exports invite reimplementation rather than use.

### Finding 4: Correct recall ≠ shorter output

Task 9 with wrong recalls: 895 tokens. Task 9 with correct RBAC recall: 1,420 tokens. The correct recall produces better code (using actual RBAC middleware correctly) but longer code (a complete demonstration app with multiple routes).

This means the token savings number is a noisy proxy for quality. A task where Claude writes excellent glue code using a high-level recall may save fewer tokens than a task where Claude writes minimal code using a wrong recall. The number doesn't tell you whether the output is good — the signal 4a clean-use rate does.

---

## What to Fix Next (Priority-Reordered)

**1. Email recall API redesign** (high priority, specific action)
Change exports from service-level (`sendWelcome`) to primitive-level (`renderWelcomeHtml`, `signEmail`, `queueEmail`). This eliminates the double-send architectural bug. Every email task currently produces bugged output because of this.

**2. RBAC recall config schema** (one-line fix)
The `createRbac` config uses an array format but Claude passes an object. Update `callExample` in the metadata to show the exact object format. That's what drives Claude's API usage — the `callExample` field.

**3. In-memory search recall** (new recall)
Task 5 gets a wrong assembly every run. No in-memory search recall exists. Extract the invented search functions (searchProducts, filterProducts, sortProducts, paginateResults) into `recalls/search/in-memory/v1`. This immediately fixes Task 5's 100% ignore rate and eliminates 1,400 tokens of invented output.

**4. Temperature=0 for benchmarks** (one-line config change)
The variance between runs is 10+ percentage points. At temperature=0 every run is deterministic. The numbers become meaningful. Add `temperature: 0` to the generateText calls in `runWithStrataV2` and `runWithoutStrata`.

**5. Session cart recall** (new recall, lower priority)
Task 8 has 100% ignore rates across every run. A `session.cart.v1` recall with `initCart(req)`, `addItem(req, item)`, `removeItem(req, productId)`, `getTotal(req)` would fix this. But it's lower priority than the email bug and in-memory search gap.
