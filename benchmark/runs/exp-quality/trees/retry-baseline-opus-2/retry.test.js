import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { retry, defaultIsRetryable } from './retry.js';

// Run `body()` while faking setTimeout, driving fake time forward between the
// microtask turns so backoff sleeps resolve instantly instead of really waiting.
// This keeps the delay-assertion tests deterministic AND fast.
async function withFastTime(body) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const promise = body();
    // Let scheduled timers register, then advance far enough to fire all of
    // them, repeatedly, until the operation settles.
    let settled = false;
    promise.then(() => (settled = true), () => (settled = true));
    for (let i = 0; i < 100 && !settled; i++) {
      await Promise.resolve();
      mock.timers.tick(60000);
    }
    return await promise;
  } finally {
    mock.timers.reset();
  }
}

// Helper: a fn that fails `failTimes` times then succeeds, recording each call.
function flaky(failTimes, { error, value = 'ok' } = {}) {
  let calls = 0;
  const makeError = error ?? (() => new Error('boom'));
  const fn = async () => {
    calls += 1;
    if (calls <= failTimes) {
      throw typeof makeError === 'function' ? makeError(calls) : makeError;
    }
    return value;
  };
  fn.getCalls = () => calls;
  return fn;
}

// Zero jitter + zero delay so timing never slows the suite.
const fast = { minDelayMs: 0, maxDelayMs: 0, random: () => 0 };

test('returns immediately on first success', async () => {
  const fn = flaky(0);
  const result = await retry(fn, fast);
  assert.equal(result, 'ok');
  assert.equal(fn.getCalls(), 1);
});

test('retries then succeeds within the attempt budget', async () => {
  const fn = flaky(2);
  const result = await retry(fn, { ...fast, retries: 3 });
  assert.equal(result, 'ok');
  assert.equal(fn.getCalls(), 3); // 2 failures + 1 success
});

test('gives up after retries+1 total attempts and throws the last error', async () => {
  const fn = flaky(99, { error: () => new Error('always fails') });
  await assert.rejects(
    retry(fn, { ...fast, retries: 2 }),
    /always fails/,
  );
  assert.equal(fn.getCalls(), 3); // 1 initial + 2 retries
});

test('does not retry when isRetryable returns false', async () => {
  const fn = flaky(99, { error: () => new Error('permanent') });
  await assert.rejects(
    retry(fn, { ...fast, retries: 5, isRetryable: () => false }),
    /permanent/,
  );
  assert.equal(fn.getCalls(), 1); // never retried
});

test('passes attempt number into fn (1-based, increasing)', async () => {
  const seen = [];
  const fn = async ({ attempt }) => {
    seen.push(attempt);
    if (attempt < 3) throw new Error('retry me');
    return 'done';
  };
  const result = await retry(fn, { ...fast, retries: 5 });
  assert.equal(result, 'done');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('onRetry fires once per retry with growing (capped) delays', async () => {
  const events = [];
  const fn = flaky(3);
  await withFastTime(() => retry(fn, {
    retries: 5,
    minDelayMs: 100,
    maxDelayMs: 1000,
    factor: 2,
    random: () => 1, // full jitter at the ceiling → deterministic max delay
    onRetry: (info) => events.push(info),
  }));
  assert.equal(events.length, 3);
  // ceilings: 100, 200, 400 → floor(1 * ceiling) but random()=1 needs care:
  // Math.floor(0.999.. ) — we use () => 1 so floor(1*ceiling) = ceiling.
  assert.deepEqual(events.map((e) => e.delayMs), [100, 200, 400]);
  assert.deepEqual(events.map((e) => e.attempt), [1, 2, 3]);
});

test('delay is capped at maxDelayMs', async () => {
  const events = [];
  const fn = flaky(5);
  await withFastTime(() => retry(fn, {
    retries: 10,
    minDelayMs: 100,
    maxDelayMs: 300,
    factor: 10,
    random: () => 1,
    onRetry: (info) => events.push(info),
  }));
  // ceilings would be 100, 1000, 10000... but capped at 300.
  assert.deepEqual(events.map((e) => e.delayMs), [100, 300, 300, 300, 300]);
});

test('jitter stays within [0, ceiling)', async () => {
  const events = [];
  const fn = flaky(3);
  await withFastTime(() => retry(fn, {
    retries: 5,
    minDelayMs: 100,
    maxDelayMs: 10000,
    factor: 2,
    random: () => 0.5,
    onRetry: (info) => events.push(info),
  }));
  // floor(0.5 * ceiling): ceilings 100,200,400 → 50,100,200
  assert.deepEqual(events.map((e) => e.delayMs), [50, 100, 200]);
});

test('aborts before the first attempt if signal already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const fn = flaky(0);
  await assert.rejects(
    retry(fn, { ...fast, signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(fn.getCalls(), 0);
});

test('abort during backoff stops retrying and rejects', async () => {
  const controller = new AbortController();
  const fn = flaky(99, { error: () => new Error('boom') });
  // Real (small) delay so we can abort mid-sleep.
  const promise = retry(fn, {
    retries: 10,
    minDelayMs: 50,
    maxDelayMs: 50,
    random: () => 1,
    signal: controller.signal,
  });
  // Abort shortly after the first failure schedules a backoff.
  setTimeout(() => controller.abort(new Error('caller gave up')), 10);
  await assert.rejects(promise, /caller gave up/);
  assert.equal(fn.getCalls(), 1); // failed once, then aborted during backoff
});

test('abort reason propagates when it is an Error', async () => {
  const controller = new AbortController();
  const reason = new Error('custom reason');
  controller.abort(reason);
  await assert.rejects(
    retry(flaky(0), { ...fast, signal: controller.signal }),
    (err) => err === reason,
  );
});

test('validates option types', async () => {
  await assert.rejects(retry(flaky(0), { retries: -1 }), TypeError);
  await assert.rejects(retry(flaky(0), { retries: 1.5 }), TypeError);
  await assert.rejects(retry(flaky(0), { factor: 0 }), TypeError);
  await assert.rejects(retry(flaky(0), { minDelayMs: -5 }), TypeError);
});

// --- defaultIsRetryable ---

test('defaultIsRetryable: retries 429 and 5xx, not other 4xx', () => {
  assert.equal(defaultIsRetryable({ status: 429 }), true);
  assert.equal(defaultIsRetryable({ status: 500 }), true);
  assert.equal(defaultIsRetryable({ status: 503 }), true);
  assert.equal(defaultIsRetryable({ statusCode: 502 }), true);
  assert.equal(defaultIsRetryable({ status: 400 }), false);
  assert.equal(defaultIsRetryable({ status: 404 }), false);
  assert.equal(defaultIsRetryable({ status: 401 }), false);
});

test('defaultIsRetryable: honors explicit retryable flag over status', () => {
  assert.equal(defaultIsRetryable({ status: 500, retryable: false }), false);
  assert.equal(defaultIsRetryable({ status: 400, retryable: true }), true);
});

test('defaultIsRetryable: retries known transient network codes', () => {
  assert.equal(defaultIsRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(defaultIsRetryable({ code: 'ETIMEDOUT' }), true);
  assert.equal(defaultIsRetryable({ code: 'UND_ERR_CONNECT_TIMEOUT' }), true);
});

test('defaultIsRetryable: unknown errors default to retryable', () => {
  assert.equal(defaultIsRetryable(new Error('mystery')), true);
  assert.equal(defaultIsRetryable(null), true);
  assert.equal(defaultIsRetryable('string error'), true);
});
