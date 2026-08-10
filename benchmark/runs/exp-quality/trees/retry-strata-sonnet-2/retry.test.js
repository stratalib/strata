'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRetryClient, HttpError, CircuitOpenError } = require('./retry');

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('succeeds immediately when the API is healthy', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(200, { ok: true });
    },
    backoff: { baseMs: 1 },
  });

  const result = await client.get('/thing');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('retries on 503 and eventually succeeds', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return jsonResponse(503, { error: 'unavailable' });
      return jsonResponse(200, { ok: true });
    },
    retries: 3,
    backoff: { baseMs: 1 },
  });

  const result = await client.get('/thing');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test('gives up after exhausting retries and throws HttpError', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(500, { error: 'boom' });
    },
    retries: 2,
    backoff: { baseMs: 1 },
  });

  await assert.rejects(() => client.get('/thing'), HttpError);
  assert.equal(calls, 3); // 1 initial attempt + 2 retries
});

test('does not retry a non-retryable 4xx', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(404, { error: 'not found' });
    },
    retries: 3,
    backoff: { baseMs: 1 },
  });

  await assert.rejects(() => client.get('/thing'), HttpError);
  assert.equal(calls, 1);
});

test('does not retry a non-idempotent POST by default', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(500, { error: 'boom' });
    },
    retries: 3,
    backoff: { baseMs: 1 },
  });

  await assert.rejects(() => client.post('/thing', { a: 1 }), HttpError);
  assert.equal(calls, 1);
});

test('retries a POST when explicitly marked idempotent', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      if (calls < 2) return jsonResponse(503, { error: 'unavailable' });
      return jsonResponse(200, { ok: true });
    },
    retries: 2,
    backoff: { baseMs: 1 },
  });

  const result = await client.post('/thing', { a: 1 }, { idempotent: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('calls onRetry with attempt number and delay for each retry', async () => {
  let calls = 0;
  const retryEvents = [];
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return jsonResponse(502, { error: 'bad gateway' });
      return jsonResponse(200, { ok: true });
    },
    retries: 3,
    backoff: { baseMs: 1 },
    onRetry: (info) => retryEvents.push(info),
  });

  await client.get('/thing');
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].attempt, 1);
  assert.equal(retryEvents[1].attempt, 2);
});

test('circuit breaker opens after repeated failures and fails fast', async () => {
  let calls = 0;
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(500, { error: 'boom' });
    },
    retries: 0,
    backoff: { baseMs: 1 },
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
  });

  await assert.rejects(() => client.get('/thing'), HttpError);
  await assert.rejects(() => client.get('/thing'), HttpError);
  assert.equal(calls, 2);

  // Circuit is now open: the third call must fail without touching fetchImpl again.
  await assert.rejects(() => client.get('/thing'), CircuitOpenError);
  assert.equal(calls, 2);
});

test('honors Retry-After header instead of computed backoff', async () => {
  let calls = 0;
  const delays = [];
  const client = createRetryClient({
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0' });
      return jsonResponse(200, { ok: true });
    },
    retries: 1,
    backoff: { baseMs: 5000 }, // deliberately large, to prove Retry-After wins
    onRetry: (info) => delays.push(info.delayMs),
  });

  await client.get('/thing');
  assert.equal(delays[0], 0);
});
