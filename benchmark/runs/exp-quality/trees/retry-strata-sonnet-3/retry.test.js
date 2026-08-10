'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withRetry, backoffDelay, retryAfterMs, RetryError } = require('./retry');

// No real sleeps in tests: pass a fake that resolves instantly but records the delays it was asked for.
function fakeSleep() {
  const calls = [];
  const fn = async (ms) => { calls.push(ms); };
  fn.calls = calls;
  return fn;
}

function httpError(status, message = 'boom') {
  const err = new Error(message);
  err.status = status;
  return err;
}

test('succeeds on the first try with no retries', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { sleepImpl: fakeSleep() });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries a transient failure and eventually succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw httpError(503);
    return 'ok';
  }, { sleepImpl: fakeSleep(), baseMs: 1 });

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('gives up after `retries` attempts and throws RetryError', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw httpError(500); }, { retries: 2, sleepImpl: fakeSleep(), baseMs: 1 }),
    (err) => {
      assert.ok(err instanceof RetryError);
      assert.equal(err.attempts, 3); // 1 initial + 2 retries
      assert.equal(err.cause.status, 500);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('does not retry a non-retryable status (404)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw httpError(404); }, { sleepImpl: fakeSleep() }),
    RetryError,
  );
  assert.equal(calls, 1, 'a 404 fails identically forever, so it is tried exactly once');
});

test('respects a custom isRetryable predicate', async () => {
  let calls = 0;
  const isRetryable = (err) => err.code === 'ECONNRESET';

  await assert.rejects(
    () => withRetry(async () => { calls++; const e = new Error('nope'); e.code = 'EOTHER'; throw e; },
      { isRetryable, sleepImpl: fakeSleep() }),
    RetryError,
  );
  assert.equal(calls, 1);
});

test('calls onRetry with attempt number and delay before each retry', async () => {
  const events = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 2) throw httpError(503);
    return 'ok';
  }, {
    sleepImpl: fakeSleep(),
    baseMs: 1,
    onRetry: (info) => events.push(info),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.equal(typeof events[0].delayMs, 'number');
  assert.equal(events[0].error.status, 503);
});

test('honours Retry-After (seconds) over computed backoff', async () => {
  const sleeper = fakeSleep();
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 2) {
      const err = httpError(429);
      err.retryAfter = '2';
      throw err;
    }
    return 'ok';
  }, { sleepImpl: sleeper, baseMs: 1 });

  assert.equal(sleeper.calls[0], 2000);
});

test('backoffDelay stays within [0, min(maxMs, baseMs * 2^attempt)]', () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const delay = backoffDelay(attempt, { baseMs: 100, maxMs: 1000 });
    assert.ok(delay >= 0, `delay ${delay} should be >= 0`);
    assert.ok(delay <= Math.min(1000, 100 * 2 ** attempt), `delay ${delay} should respect the cap`);
  }
});

test('retryAfterMs parses a numeric seconds value', () => {
  assert.equal(retryAfterMs({ retryAfter: '5' }), 5000);
});

test('retryAfterMs parses an HTTP-date', () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = retryAfterMs({ retryAfter: future });
  assert.ok(ms > 8000 && ms <= 10_000, `expected ~10000ms, got ${ms}`);
});

test('retryAfterMs returns null when absent', () => {
  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs(null), null);
});

test('a network error with no status is treated as retryable', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 2) { const e = new Error('ECONNRESET'); throw e; }
    return 'ok';
  }, { sleepImpl: fakeSleep(), baseMs: 1 });

  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('err.permanent === true short-circuits retries regardless of status', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; const e = httpError(503); e.permanent = true; throw e; },
      { sleepImpl: fakeSleep() }),
    RetryError,
  );
  assert.equal(calls, 1);
});
