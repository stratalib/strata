import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, fetchWithRetry, RetryError, _internals } from '../src/retry.js';

// A fake Response good enough for our helper: it reads .status, .headers.get, .ok.
function fakeResponse(status, { retryAfter } = {}) {
  const headers = new Map();
  if (retryAfter !== undefined) headers.set('retry-after', String(retryAfter));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
  };
}

// A fetch stub that returns/throws from a queued script of outcomes, one per call.
function scriptedFetch(script) {
  let i = 0;
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  };
  impl.callCount = () => i;
  impl.calls = calls;
  return impl;
}

// baseMs 0 + random()=>0 means every backoff resolves to 0ms: fast, deterministic.
const fast = { baseMs: 0, random: () => 0 };

test('withRetry returns on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  }, fast);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  }, { ...fast, retries: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry exhausts retries and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error(`fail-${calls}`);
    }, { ...fast, retries: 2 }),
    /fail-3/,
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('withRetry stops immediately when shouldRetry says no', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('do-not-retry');
    }, { ...fast, retries: 5, shouldRetry: () => false }),
    /do-not-retry/,
  );
  assert.equal(calls, 1);
});

test('withRetry calls onRetry once per retry with attempt + delay', async () => {
  const seen = [];
  await withRetry(async () => {
    if (seen.length < 2) throw new Error('x');
    return 'ok';
  }, { ...fast, retries: 5, onRetry: (info) => seen.push(info) });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].attempt, 0);
  assert.equal(seen[1].attempt, 1);
});

test('withRetry aborts via signal without running further attempts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = withRetry(async () => {
    calls++;
    controller.abort();
    throw new Error('boom');
  }, { baseMs: 1000, random: () => 1, retries: 5, signal: controller.signal });
  await assert.rejects(promise, (e) => e.name === 'AbortError');
  assert.equal(calls, 1);
});

test('fetchWithRetry returns immediately on 2xx', async () => {
  const fetchImpl = scriptedFetch([fakeResponse(200)]);
  const res = await fetchWithRetry('https://api.test/x', { ...fast, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.callCount(), 1);
});

test('fetchWithRetry retries on 503 then succeeds', async () => {
  const fetchImpl = scriptedFetch([
    fakeResponse(503),
    fakeResponse(503),
    fakeResponse(200),
  ]);
  const res = await fetchWithRetry('https://api.test/x', { ...fast, retries: 5, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.callCount(), 3);
});

test('fetchWithRetry does NOT retry a 404 (client error)', async () => {
  const fetchImpl = scriptedFetch([fakeResponse(404)]);
  const res = await fetchWithRetry('https://api.test/x', { ...fast, retries: 5, fetchImpl });
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.callCount(), 1);
});

test('fetchWithRetry returns the last bad response after exhausting retries', async () => {
  const fetchImpl = scriptedFetch([fakeResponse(500)]);
  const res = await fetchWithRetry('https://api.test/x', { ...fast, retries: 2, fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.callCount(), 3); // 1 + 2 retries
});

test('fetchWithRetry retries on a thrown transport error, then wraps in RetryError', async () => {
  const fetchImpl = scriptedFetch([new Error('ECONNRESET')]);
  await assert.rejects(
    fetchWithRetry('https://api.test/x', { ...fast, retries: 2, fetchImpl }),
    (e) => e instanceof RetryError && e.attempts === 3 && /ECONNRESET/.test(e.cause.message),
  );
  assert.equal(fetchImpl.callCount(), 3);
});

test('fetchWithRetry recovers from a transport error then a success', async () => {
  const fetchImpl = scriptedFetch([new Error('ETIMEDOUT'), fakeResponse(200)]);
  const res = await fetchWithRetry('https://api.test/x', { ...fast, retries: 3, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.callCount(), 2);
});

test('fetchWithRetry honours Retry-After (seconds) over computed backoff, capped at maxDelayMs', async () => {
  const delays = [];
  const fetchImpl = scriptedFetch([fakeResponse(429, { retryAfter: 2 }), fakeResponse(200)]);
  await fetchWithRetry('https://api.test/x', {
    baseMs: 0,
    random: () => 0,
    retries: 3,
    maxDelayMs: 50, // header asks for 2000ms; the cap must win, keeping the test fast
    fetchImpl,
    onRetry: (info) => delays.push(info.delay),
  });
  assert.equal(delays[0], 50); // capped, not the raw 2000 from the header
});

test('backoffMs grows exponentially and respects the cap', () => {
  const { backoffMs } = _internals;
  // random()=>1 gives the full (un-jittered) value so we can see the curve.
  assert.equal(backoffMs(0, 100, 10_000, () => 1), 100);
  assert.equal(backoffMs(1, 100, 10_000, () => 1), 200);
  assert.equal(backoffMs(2, 100, 10_000, () => 1), 400);
  assert.equal(backoffMs(10, 100, 1_000, () => 1), 1_000); // capped
});

test('retryAfterMs parses seconds and http-date, ignores garbage', () => {
  const { retryAfterMs } = _internals;
  assert.equal(retryAfterMs(fakeResponse(429, { retryAfter: 5 })), 5000);
  assert.equal(retryAfterMs(fakeResponse(200)), null);
  const future = new Date(Date.now() + 3000).toUTCString();
  const ms = retryAfterMs(fakeResponse(429, { retryAfter: future }));
  assert.ok(ms > 1000 && ms <= 3000);
});
