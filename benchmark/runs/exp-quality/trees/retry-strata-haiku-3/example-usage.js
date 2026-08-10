'use strict';
const { createHttpClient, CircuitOpenError, HttpError } = require('./strata/composed-pkg');

// Create a client with retry + backoff + circuit breaker.
// Uses Node 18+ native fetch under the hood — no external dependencies.
const client = createHttpClient({
  baseUrl: 'https://api.example.com',
  timeoutMs: 5000,        // per ATTEMPT, not total
  retries: 3,             // up to 4 total requests (1 try + 3 retries)
  headers: {
    'authorization': 'Bearer YOUR_TOKEN',
  },
  backoff: {
    baseMs: 300,          // first retry waits 0-300ms
    maxMs: 20_000,        // cap backoff at 20s to avoid infinite delays
    jitter: true,         // randomize to avoid thundering herd
  },
  circuitBreaker: {
    failureThreshold: 5,  // open after 5 consecutive failures
    resetTimeoutMs: 30_000, // probe for recovery after 30s
  },
  onRetry: ({ attempt, delayMs, reason }) => {
    console.log(`Retry attempt ${attempt} in ${Math.ceil(delayMs)}ms: ${reason}`);
  },
});

// Example: fetch a user record.
async function getUser(userId) {
  try {
    const user = await client.get(`/users/${userId}`);
    console.log('User:', user);
    return user;
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // The upstream is down. Return stale data from cache or fail gracefully.
      console.error(`Upstream is down; will retry in ${Math.ceil(err.msRemaining / 1000)}s`);
      return null;
    }
    if (err instanceof HttpError) {
      // Log the failure with attempt count and status code.
      console.error(`Failed after ${err.attempts} attempts (HTTP ${err.status}): ${err.message}`);
      // 4xx = caller's fault (bad request, not found, etc.) — don't retry
      // 5xx = server's fault — already retried, stop here
      // 429 = rate limit — respected server's Retry-After, stop here
      return null;
    }
    throw err;
  }
}

// Example: create a resource (POST is NOT retried by default).
// But if the endpoint is idempotent (has an Idempotency-Key), opt in.
async function createOrder(order) {
  try {
    const result = await client.post(
      '/orders',
      order,
      {
        idempotent: true,  // server dedupes via Idempotency-Key
        headers: {
          'idempotency-key': `order-${Date.now()}-${Math.random()}`,
        },
      }
    );
    console.log('Order created:', result);
    return result;
  } catch (err) {
    if (err instanceof HttpError) {
      console.error(`Order creation failed after ${err.attempts} attempts: ${err.message}`);
    }
    throw err;
  }
}

// Example: use the circuit breaker state directly.
async function checkServiceHealth() {
  const state = client.breaker.state;
  switch (state) {
    case 'closed':
      console.log('✓ Upstream is healthy');
      break;
    case 'open':
      console.log('✗ Upstream is down; requests will fail immediately');
      break;
    case 'half_open':
      console.log('~ Testing upstream recovery...');
      break;
  }
  return state;
}

// Example: override retry count for a specific call.
async function getWithMoreRetries(path) {
  return client.get(path, { retries: 5 });  // 5 retries instead of 3
}

// Run an example.
(async () => {
  await checkServiceHealth();
  // await getUser('alice@example.com');
  // await createOrder({ item: 'book', qty: 3 });
})();
