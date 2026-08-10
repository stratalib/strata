# Strata Recall Benchmark — Results

**Date:** 2026-06-23 07:27:09 UTC
**Model:** `claude-haiku-4-5-20251001`
**Recall Library Size:** 510 recalls
**Tasks Run:** 12

---

## Executive Summary

| Metric | V2 (pre-fetch) | Baseline (no Strata) |
|--------|----------------|----------------------|
| Total tokens | 23,608 | 32,703 |
| vs baseline | saved 9,095 (27.8%) | — |
| Avg time | 9.11s | 14.25s |
| API turns | 1/1/1/1/1/1/1/1/1/1/1/1 | 1 |
| No-retry rate | 12/12 | — |
| Retries triggered | 0 | — |

---

## Task 1: User Authentication System

**Prompt:**
> Build a complete Node.js user authentication system with: signup (email + bcrypt password hash), login (returns JWT access token + refresh token), logout (invalidate refresh token), and password reset (send reset email with time-limited token). Use Express. Include the route handlers, middleware, and token management logic.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 612 | 115 |
| Output tokens | 2,435 | 3,579 |
| **Total**     | **3,047** | **3,694** |
| vs baseline   | saved 647 (17.5%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 13,173ms | 17,108ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `auth.password.passwordvalidation.v1`, `auth.jwt.tokenhandling.v1`, `auth-password-reset-flow` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-01-auth/with-strata-v2.txt`
- `benchmark/task-01-auth/without-strata.txt`

---

## Task 2: Email Sending Service

**Prompt:**
> Build a Node.js email service module that sends: welcome emails on signup, password reset emails with a secure token link, and generic notification emails. Use nodemailer with SMTP config. Support HTML and plain-text bodies, retry on failure (3 attempts), and a queue so sending does not block the request. Return the full implementation.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 553 | 121 |
| Output tokens | 2,060 | 3,243 |
| **Total**     | **2,613** | **3,364** |
| vs baseline   | saved 751 (22.3%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 15,995ms | 18,412ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `communication.email.full.v1`, `queue-worker-pool` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-02-email/with-strata-v2.txt`
- `benchmark/task-02-email/without-strata.txt`

---

## Task 3: File Upload Service

**Prompt:**
> Build a Node.js Express file upload service using multer. Support: single and multiple file uploads, file type validation (images: jpg/png/gif, documents: pdf/docx), size limits (10MB per file), storing files to a local ./uploads directory with hashed filenames, and returning a public URL. Include the multer config, route handlers, and error handling for invalid types or oversized files.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 565 | 138 |
| Output tokens | 1,213 | 1,867 |
| **Total**     | **1,778** | **2,005** |
| vs baseline   | saved 227 (11.3%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 8,854ms | 9,359ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `file-storage-s3-upload`, `form-validation`, `timeseries-storage` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-03-file-upload/with-strata-v2.txt`
- `benchmark/task-03-file-upload/without-strata.txt`

---

## Task 4: Push Notification Service

**Prompt:**
> Build a Node.js notification service that supports: sending push notifications via Firebase Cloud Messaging (FCM), storing user device tokens in a map/store, sending to a single user by userId, broadcasting to all users, and handling FCM errors (invalid token, quota exceeded). Include the FCM client setup, token storage, and the send/broadcast methods.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 575 | 124 |
| Output tokens | 1,288 | 3,335 |
| **Total**     | **1,863** | **3,459** |
| vs baseline   | saved 1,596 (46.1%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 9,607ms | 19,254ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `notifications.fcm.v1`, `api.middleware.error.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-04-notifications/with-strata-v2.txt`
- `benchmark/task-04-notifications/without-strata.txt`

---

## Task 5: Full-Text Product Search

**Prompt:**
> Build a Node.js product search module. Support: keyword search across name, description, and category fields, filtering by price range and category, sorting by relevance or price, and pagination (page + limit). Use an in-memory product array for storage. Return the search function, filter logic, and an Express GET /products/search endpoint with query parameter parsing.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 604 | 125 |
| Output tokens | 1,685 | 3,191 |
| **Total**     | **2,289** | **3,316** |
| vs baseline   | saved 1,027 (31.0%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 10,008ms | 19,488ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `search.in-memory.v1`, `database-cursor-pagination` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-05-search/with-strata-v2.txt`
- `benchmark/task-05-search/without-strata.txt`

---

## Task 6: Threaded Comment System

**Prompt:**
> Build a Node.js Express REST API for a threaded comment system. Support: POST /comments (create top-level comment), POST /comments/:id/reply (reply to a comment), GET /comments?postId=X (list comments with replies nested), PUT /comments/:id (edit own comment), DELETE /comments/:id (soft delete). Comments have: id, postId, parentId, authorId, body, createdAt, deletedAt. Return all route handlers and data logic.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 631 | 156 |
| Output tokens | 1,570 | 2,215 |
| **Total**     | **2,201** | **2,371** |
| vs baseline   | saved 170 (7.2%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 9,095ms | 10,284ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `crud.create.comment.v1`, `crud.full.data.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-06-comments/with-strata-v2.txt`
- `benchmark/task-06-comments/without-strata.txt`

---

## Task 7: Cursor-Paginated REST API

**Prompt:**
> Build a Node.js Express endpoint for cursor-based pagination of a large dataset. GET /items?cursor=<encoded>&limit=20 should: decode the cursor (base64 encoded timestamp+id), query from that position, return items + nextCursor + hasMore. Implement the cursor encode/decode helpers and the route handler. Handle edge cases: first page (no cursor), last page (no nextCursor), invalid cursor.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 797 | 143 |
| Output tokens | 609 | 1,588 |
| **Total**     | **1,406** | **1,731** |
| vs baseline   | saved 325 (18.8%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 5,606ms | 9,890ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `database-cursor-pagination` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-07-pagination/with-strata-v2.txt`
- `benchmark/task-07-pagination/without-strata.txt`

---

## Task 8: Shopping Cart with Sessions

**Prompt:**
> Build a Node.js Express shopping cart system using express-session. Support: GET /cart (view cart), POST /cart/items (add item with productId, quantity, price), PUT /cart/items/:productId (update quantity), DELETE /cart/items/:productId (remove item), POST /cart/clear (empty cart), GET /cart/total (sum of price*quantity). Store cart in session. Return full route handlers and session middleware config.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 840 | 148 |
| Output tokens | 907 | 1,747 |
| **Total**     | **1,747** | **1,895** |
| vs baseline   | saved 148 (7.8%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 6,619ms | 10,570ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `cart.session.express.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-08-cart/with-strata-v2.txt`
- `benchmark/task-08-cart/without-strata.txt`

---

## Task 9: Role-Based Access Control

**Prompt:**
> Build a Node.js RBAC (role-based access control) system for Express. Define roles: admin, editor, viewer. Each role has a set of permissions (e.g., admin: [read, write, delete], editor: [read, write], viewer: [read]). Implement: a requirePermission(permission) middleware that checks the req.user.role, a checkRole(role) middleware, and an assignRole(userId, role) function. Return the full middleware and permission definitions.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 640 | 159 |
| Output tokens | 1,233 | 3,960 |
| **Total**     | **1,873** | **4,119** |
| vs baseline   | saved 2,246 (54.5%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 8,252ms | 21,043ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `auth.rbac.express.v1`, `api.endpoint.user.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-09-rbac/with-strata-v2.txt`
- `benchmark/task-09-rbac/without-strata.txt`

---

## Task 10: Real-Time Chat with WebSockets

**Prompt:**
> Build a Node.js real-time chat server using the ws package (WebSocket). Support: user join (send {type:"join", username}), broadcast message to all connected users ({type:"message", from, text}), private message to a specific user ({type:"dm", to, text}), user leave notification. Track connected users by username. Return the WebSocket server setup, message routing logic, and connection/disconnection handlers.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 614 | 142 |
| Output tokens | 1,027 | 2,163 |
| **Total**     | **1,641** | **2,305** |
| vs baseline   | saved 664 (28.8%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 8,006ms | 12,668ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `realtime.ws.chat.v1`, `read-replica-routing`, `auth.session.sessionmanagement.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-10-chat/with-strata-v2.txt`
- `benchmark/task-10-chat/without-strata.txt`

---

## Task 11: JWT Auth Middleware

**Prompt:**
> Build a JWT authentication middleware for Express. Extract Bearer tokens from the Authorization header, verify them against a secret, and attach the decoded payload to req.user. Return 401 for missing, expired, or invalid tokens with a clear error code. Also expose a standalone verifyJWT(token, secret) helper and an authenticateRequest(req, secret) function for non-middleware contexts.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 824 | 131 |
| Output tokens | 576 | 711 |
| **Total**     | **1,400** | **842** |
| vs baseline   | +558 overhead (66.3%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 5,978ms | 4,005ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `auth.jwt.tokenhandling.v1` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-11-jwt-middleware/with-strata-v2.txt`
- `benchmark/task-11-jwt-middleware/without-strata.txt`

---

## Task 12: Password Reset Flow

**Prompt:**
> Build a Node.js password reset flow. Generate a secure random token, hash it for storage, persist it with an expiry timestamp and user email. Send a reset email containing a link with the raw token. On confirmation: look up the token hash, validate expiry, ensure it has not been used, update the password, mark the token as used, and clean up expired tokens for that user. Enforce a rate limit of 5 reset attempts per hour per email.

### Token Comparison

| | V2 pre-fetch | Baseline |
|--|-------------|----------|
| Input tokens  | 659 | 148 |
| Output tokens | 1,091 | 3,454 |
| **Total**     | **1,750** | **3,602** |
| vs baseline   | saved 1,852 (51.4%) | — |

### Timing

| | V2 | Baseline |
|--|--|--|
| Wall time | 8,149ms | 18,908ms |
| API turns | 1 | 1 |

### V2 Recall Activity

| Pre-fetched IDs | `auth-password-reset-flow` |
|---|---|
| Retries | 0 |
| Cards relevant? | ✅ YES — used on first attempt |

### Output Files

- `benchmark/task-12-password-reset/with-strata-v2.txt`
- `benchmark/task-12-password-reset/without-strata.txt`

---

## Verdict

| | |
|--|--|
| V2 vs baseline | saved 9,095 (27.8%) |
| V2 retries | 0 total across all tasks |

---

## Library Signals

*Derived from analyzing Claude's output against delivered assemblies.*

### Per-Task Usage

| Task | Exports | ✅ Clean | 🔁 Wrapped | ❌ Ignored | 🆕 Invented |
|------|---------|---------|-----------|----------|----------|
| User Authentication System | 10 | hashedPassword, validationResult, verifyJWT, signJWT, createTokenPair, initiateReset, validateToken | — | refreshAccessToken, decodeJWT, completeReset | authMiddleware |
| Email Sending Service | 7 | welcomeEmail, passwordResetEmail, verificationEmail, createTransport, sendWithRetry, createEmailService | — | notificationEmail | sendWelcomeEmail, sendPasswordResetEmail, sendNotificationEmail, sendVerificationEmail |
| File Upload Service | — | — | — | — | — |
| Push Notification Service | 8 | initFCM, addDeviceToken, removeDeviceToken, getUserTokens, getAllUsers, sendToUser, broadcastToAll, errorResponse | — | — | — |
| Full-Text Product Search | 13 | — | searchItems | performSearch, filterItems, sortItems, paginateItems, encodeCursor, decodeCursor, CursorPaginator, items, nextCursor, prevCursor, hasMore, count | searchProducts, filterProducts, sortProducts, paginateProducts, setupSearchRoute |
| Threaded Comment System | 11 | create, readOne, readMany, update, softDelete, buildWhere | — | result, data, success, createRepository, paginate | — |
| Cursor-Paginated REST API | 8 | encodeCursor, decodeCursor | — | CursorPaginator, items, nextCursor, prevCursor, hasMore, count | — |
| Shopping Cart with Sessions | 7 | addItem, updateQuantity, removeItem, clearCart, getTotal, getCart | — | initCart | — |
| Role-Based Access Control | 8 | createRbac, requireRole, requirePermission | — | requireAnyPermission, requireOwnerOrRole, result, data, success | assignRole, mockAuth |
| Real-Time Chat with WebSockets | 5 | createChatServer, broadcastToRoom, sendPrivate, sessionToken, sessionData | — | — | — |
| JWT Auth Middleware | 5 | verifyJWT | — | signJWT, createTokenPair, refreshAccessToken, decodeJWT | jwtAuthMiddleware, verifyTokenHelper, authenticateRequest |
| Password Reset Flow | 3 | initiateReset, completeReset, validateToken | — | — | checkRateLimit |

### Invented Functions — Library Backlog

*Functions Claude wrote from scratch that don't exist in any delivered recall.*
*High frequency = strong candidate for a new recall.*

| Function | Times Invented |
|----------|----------------|
| `authMiddleware` | 1 |
| `sendWelcomeEmail` | 1 |
| `sendPasswordResetEmail` | 1 |
| `sendNotificationEmail` | 1 |
| `sendVerificationEmail` | 1 |
| `searchProducts` | 1 |
| `filterProducts` | 1 |
| `sortProducts` | 1 |
| `paginateProducts` | 1 |
| `setupSearchRoute` | 1 |
| `assignRole` | 1 |
| `mockAuth` | 1 |
| `jwtAuthMiddleware` | 1 |
| `verifyTokenHelper` | 1 |
| `authenticateRequest` | 1 |
| `checkRateLimit` | 1 |

### Most Ignored Exports

*Delivered but never used — recall may be over-broad or mis-tagged.*

| Export | Times Ignored |
|--------|---------------|
| `refreshAccessToken` | 2 |
| `decodeJWT` | 2 |
| `CursorPaginator` | 2 |
| `items` | 2 |
| `nextCursor` | 2 |
| `prevCursor` | 2 |
| `hasMore` | 2 |
| `count` | 2 |
| `result` | 2 |
| `data` | 2 |

