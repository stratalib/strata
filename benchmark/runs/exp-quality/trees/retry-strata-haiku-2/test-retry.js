#!/usr/bin/env node
'use strict';
const { createRetryClient, CircuitOpenError, HttpError } = require('./retry');

// Mock fetch that fails the first 2 times, then succeeds
let callCount = 0;
const mockFetch = async (url, opts) => {
  callCount++;
  console.log(`  Attempt ${callCount} to ${url}`);

  if (callCount <= 2) {
    const err = new Error('Connection refused');
    err.name = 'TypeError';
    throw err;
  }

  return {
    ok: true,
    status: 200,
    headers: { get: (key) => key === 'content-type' ? 'application/json' : null },
    json: async () => ({ id: 123, status: 'ok' }),
  };
};

async function demo() {
  console.log('Testing retry client with automatic backoff...\n');

  const client = createRetryClient({
    baseUrl: 'https://api.example.com',
    retries: 3,
    timeoutMs: 5000,
    backoff: { baseMs: 100, maxMs: 1000 },
    fetchImpl: mockFetch,
    onRetry: ({ attempt, delayMs, reason }) => {
      console.log(`  → Retry after ${delayMs}ms: ${reason}`);
    },
  });

  try {
    console.log('GET /users/123');
    const result = await client.get('/users/123');
    console.log(`✓ Success: ${JSON.stringify(result)}\n`);
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
  }

  // Test circuit breaker
  console.log('Testing circuit breaker...\n');
  callCount = 0;

  const failingFetch = async (url, opts) => {
    callCount++;
    console.log(`  Attempt ${callCount} to ${url}`);
    const err = new Error('Server error');
    err.name = 'TypeError';
    throw err;
  };

  const breaker = createRetryClient({
    baseUrl: 'https://api.broken.com',
    retries: 1,
    timeoutMs: 1000,
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
    fetchImpl: failingFetch,
  });

  for (let i = 0; i < 5; i++) {
    try {
      console.log(`Call ${i + 1}`);
      await breaker.get('/endpoint');
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        console.log(`  → Circuit open! Retry in ${err.msRemaining}ms\n`);
      } else if (err instanceof HttpError) {
        console.log(`  → HTTP error after ${err.attempts} attempts\n`);
      }
    }
  }

  console.log('Test complete.');
}

demo().catch(console.error);
