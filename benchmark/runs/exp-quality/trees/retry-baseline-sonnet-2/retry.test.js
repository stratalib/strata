'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retryWithBackoff, fetchWithRetry } = require('./retry');

// Keep tests fast: tiny base delay and no jitter unless a test targets jitter/timing itself.
const FAST = { baseDelayMs: 1, maxDelayMs: 5, jitter: 0 };

test('resolves immediately when fn succeeds on first try', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls += 1;
    return 'ok';
  }, FAST);

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries on failure and eventually succeeds', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  }, { ...FAST, retries: 5 });

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('throws the last error once retries are exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls += 1;
      throw new Error(`fail ${calls}`);
    }, { ...FAST, retries: 2 }),
    /fail 3/
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test('does not retry when retries is 0', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls += 1;
      throw new Error('nope');
    }, { ...FAST, retries: 0 }),
    /nope/
  );
  assert.equal(calls, 1);
});

test('rejects synchronously-thrown TypeError for non-function fn', async () => {
  await assert.rejects(() => retryWithBackoff(null), TypeError);
});

test('rejects RangeError for negative retries', async () => {
  await assert.rejects(() => retryWithBackoff(async () => {}, { retries: -1 }), RangeError);
});

test('honors custom isRetryable and stops retrying on non-retryable error', async () => {
  let calls = 0;
  class PermanentError extends Error {}

  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls += 1;
      throw new PermanentError('permanent');
    }, {
      ...FAST,
      retries: 5,
      isRetryable: (err) => !(err instanceof PermanentError),
    }),
    PermanentError
  );
  assert.equal(calls, 1);
});

test('calls onRetry with error, attempt number, and delay before each retry', async () => {
  const events = [];
  let calls = 0;

  await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`err${calls}`);
    return 'done';
  }, {
    ...FAST,
    retries: 5,
    onRetry: (error, attempt, delayMs) => {
      events.push({ message: error.message, attempt, delayMs });
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 0);
  assert.equal(events[0].message, 'err1');
  assert.equal(events[1].attempt, 1);
  assert.equal(events[1].message, 'err2');
  for (const e of events) {
    assert.ok(e.delayMs >= 0 && e.delayMs <= FAST.maxDelayMs);
  }
});

test('backoff grows exponentially and is capped at maxDelayMs (no jitter)', async () => {
  const delays = [];
  let calls = 0;

  await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 5) throw new Error('flaky');
    return 'ok';
  }, {
    baseDelayMs: 10,
    maxDelayMs: 60,
    factor: 2,
    jitter: 0,
    retries: 10,
    onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
  });

  // attempts 0..3 -> 10, 20, 40, 60(capped from 80)
  assert.deepEqual(delays, [10, 20, 40, 60]);
});

test('jitter keeps delay within [floor, capped] and varies output', async () => {
  const samples = new Set();
  for (let i = 0; i < 20; i++) {
    let calls = 0;
    await retryWithBackoff(async () => {
      calls += 1;
      if (calls < 2) throw new Error('flaky');
      return 'ok';
    }, {
      baseDelayMs: 100,
      maxDelayMs: 100,
      factor: 2,
      jitter: 0.5,
      retries: 1,
      onRetry: (_e, _a, delayMs) => samples.add(delayMs),
    });
  }
  for (const d of samples) {
    assert.ok(d >= 50 && d <= 100, `delay ${d} out of expected [50,100] range`);
  }
  assert.ok(samples.size > 1, 'expected jitter to produce varying delays');
});

test('AbortError from fn is not retried by default', async () => {
  let calls = 0;
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';

  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls += 1;
      throw abortError;
    }, { ...FAST, retries: 5 }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(calls, 1);
});

test('pre-aborted signal prevents any call to fn', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls += 1;
      return 'should not happen';
    }, { ...FAST, signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(calls, 0);
});

test('aborting during a backoff wait stops retries promptly', async () => {
  const controller = new AbortController();
  let calls = 0;

  const promise = retryWithBackoff(async () => {
    calls += 1;
    throw new Error('flaky');
  }, {
    baseDelayMs: 1000,
    maxDelayMs: 1000,
    jitter: 0,
    retries: 5,
    signal: controller.signal,
  });

  // Abort shortly after the first failure, well before the 1s backoff would elapse.
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(promise, (err) => err.name === 'AbortError');
  assert.equal(calls, 1);
});

// --- fetchWithRetry ---

function stubFetch(responses) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  };
}

function fakeResponse(status) {
  return { ok: status >= 200 && status < 300, status };
}

test('fetchWithRetry retries on 500 then succeeds', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = stubFetch([fakeResponse(500), fakeResponse(500), fakeResponse(200)]);

  const res = await fetchWithRetry('https://example.test/api', {}, FAST);
  assert.equal(res.status, 200);
});

test('fetchWithRetry does not retry on 404', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => { calls += 1; return fakeResponse(404); };

  const res = await fetchWithRetry('https://example.test/api', {}, { ...FAST, retries: 3 });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test('fetchWithRetry retries on 429', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = stubFetch([fakeResponse(429), fakeResponse(200)]);

  const res = await fetchWithRetry('https://example.test/api', {}, FAST);
  assert.equal(res.status, 200);
});

test('fetchWithRetry retries on network-level throw (no status)', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = stubFetch([new TypeError('fetch failed'), fakeResponse(200)]);

  const res = await fetchWithRetry('https://example.test/api', {}, FAST);
  assert.equal(res.status, 200);
});

test('fetchWithRetry surfaces final error status after exhausting retries', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => fakeResponse(503);

  await assert.rejects(
    () => fetchWithRetry('https://example.test/api', {}, { ...FAST, retries: 2 }),
    (err) => err.status === 503
  );
});
