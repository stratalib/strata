#!/usr/bin/env node
'use strict';
const { createRetryClient, CircuitOpenError, HttpError } = require('./retry');

// Create a resilient client for a flaky API.
const client = createRetryClient({
  baseUrl: 'https://api.example.com',
  retries: 4,                  // Retry up to 4 times after the initial attempt
  timeoutMs: 5000,             // Each attempt times out after 5 seconds
  backoff: {
    baseMs: 500,               // Start with 500ms delay on first retry
    maxMs: 30000,              // Cap at 30 seconds
    jitter: true,              // Add random jitter to spread load
  },
  circuitBreaker: {
    failureThreshold: 5,       // Open circuit after 5 consecutive failures
    resetTimeoutMs: 30000,     // Wait 30 seconds before trying to recover
  },
  onRetry: ({ attempt, delayMs, reason }) => {
    console.log(`[Retry #${attempt}] Waiting ${Math.round(delayMs)}ms — ${reason}`);
  },
});

async function main() {
  // GET request (idempotent, always retried on failure)
  try {
    const user = await client.get('/users/42');
    console.log('User:', user);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      console.error(`Circuit open for ${err.msRemaining}ms — upstream is down`);
    } else if (err instanceof HttpError) {
      console.error(`Failed after ${err.attempts} attempts: HTTP ${err.status}`);
    } else {
      console.error('Request failed:', err.message);
    }
  }

  // POST request (not retried by default — it's not idempotent)
  try {
    const result = await client.post('/orders', {
      userId: 42,
      items: ['widget', 'gadget'],
    });
    console.log('Order created:', result);
  } catch (err) {
    console.error('Order creation failed:', err.message);
  }

  // POST with idempotency key — now it WILL retry (server will dedupe)
  try {
    const idempotencyKey = 'order-' + Date.now();
    const result = await client.post(
      '/orders',
      { userId: 42, items: ['widget'] },
      {
        idempotent: true,  // Opt-in to retries for this POST
        headers: { 'idempotency-key': idempotencyKey },
      }
    );
    console.log('Order created (with retry):', result);
  } catch (err) {
    console.error('Order failed:', err.message);
  }

  // Override retry count for a single request
  try {
    const result = await client.get('/urgent', {
      retries: 0,  // No retries for this one — fail fast
    });
    console.log('Urgent data:', result);
  } catch (err) {
    console.error('Urgent request failed:', err.message);
  }
}

main().catch(console.error);
