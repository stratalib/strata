# Resilient API Retry Helper

This project provides a production-grade HTTP client with automatic retry, exponential backoff, and circuit breaker.

## Quick Start

The retry helper is in `strata/composed-pkg/index.js`. It's imported in `server.js`:

```javascript
const { createHttpClient, CircuitOpenError } = require('strata-composed');

const upstream = createHttpClient({
  baseUrl: 'https://api.example.com',
  timeoutMs: 5000,        // per attempt, not total
  retries: 3,             // up to 4 total requests (1 try + 3 retries)
  headers: { authorization: 'Bearer token' },
});

// GET — automatically retried on 5xx/429/408
const data = await upstream.get('/items/123');

// POST — NOT retried by default (could double-charge)
try {
  await upstream.post('/charges', { amount: 100 });
} catch (err) {
  if (err instanceof CircuitOpenError) {
    // Upstream is down; backoff and retry from caller
    res.status(503).json({ error: 'service temporarily unavailable' });
  }
}

// POST with Idempotency-Key — safe to retry
await upstream.post('/charges', { amount: 100 }, {
  idempotent: true,
  headers: { 'idempotency-key': 'order-123' }
});
```

## What It Does

**Exponential backoff + jitter** — Prevents thundering herd when a service recovers. Random delays spread retries across time.

**Idempotency-aware** — GET/HEAD/PUT/DELETE are retried automatically. POST/PATCH only if explicitly marked `idempotent: true`.

**Retry-After header** — Honors server's `Retry-After` header if present (both seconds and HTTP-date formats).

**Circuit breaker** — After 5 consecutive failures, rejects requests immediately for 30s, then probes with one request. Fails fast instead of hammering a dead service.

**Timeout per attempt** — Each retry gets its own timeout. A hung connection doesn't burn the entire retry budget.

**Non-retryable errors** — 4xx (except 429) and 408 fail immediately. Retrying a 400 "bad request" just wastes budget.

## Configuration (from .env)

```
UPSTREAM_URL=http://localhost:4000
UPSTREAM_TIMEOUT_MS=5000
UPSTREAM_RETRIES=3
UPSTREAM_KEY=optional-bearer-token
```

## Error Handling

```javascript
try {
  const result = await upstream.get('/path');
} catch (err) {
  if (err instanceof CircuitOpenError) {
    // Circuit is open; backoff before retrying from caller
    console.log('Retry in', err.msRemaining, 'ms');
  } else {
    // Network error or all retries exhausted
    console.error(err.message);
    console.error('Status:', err.status);
    console.error('Attempts:', err.attempts);
  }
}
```

## Testing

```bash
npm install
node strata/verify.js         # end-to-end test
node strata/selftest.js       # unit tests only
```

The test suite covers: transient failures (5xx), retry budgets, non-retryable errors (4xx), idempotency, circuit breaker state transitions, and header parsing.
