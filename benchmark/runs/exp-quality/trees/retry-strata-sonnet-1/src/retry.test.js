'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retry, RetryAbortError, RetryExhaustedError, computeDelay } = require('./retry');

// Deterministic delays for assertions on timing/order without real sleeps.
function withNoJitter(fn) {
  const original = Math.random;
  Math.random = () => 1; // full jitter formula becomes `cap`, i.e. the max delay each attempt
  return fn().finally(() => {
    Math.random = original;
  });
}

test('resolves immediately when fn succeeds on first try', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries on failure and eventually succeeds', async () => {
  let calls = 0;
  const result = await withNoJitter(() =>
    retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'recovered';
      },
      { retries: 5, baseDelayMs: 1, maxDelayMs: 1 }
    )
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('throws RetryExhaustedError after exhausting all retries', async () => {
  let calls = 0;
  await withNoJitter(() =>
    assert.rejects(
      () =>
        retry(
          async () => {
            calls++;
            throw new Error('always fails');
          },
          { retries: 2, baseDelayMs: 1, maxDelayMs: 1 }
        ),
      (err) => {
        assert.ok(err instanceof RetryExhaustedError);
        assert.equal(err.attempts, 3); // initial attempt + 2 retries
        assert.equal(err.cause.message, 'always fails');
        return true;
      }
    )
  );
  assert.equal(calls, 3);
});

test('does not retry when isRetryable returns false', async () => {
  let calls = 0;
  class PermanentError extends Error {}

  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new PermanentError('do not retry me');
        },
        {
          retries: 5,
          baseDelayMs: 1,
          maxDelayMs: 1,
          isRetryable: (err) => !(err instanceof PermanentError),
        }
      ),
    RetryExhaustedError
  );
  assert.equal(calls, 1);
});

test('calls onRetry with error, attempt index, and delay before each retry', async () => {
  const events = [];
  let calls = 0;

  await withNoJitter(() =>
    retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`fail-${calls}`);
        return 'done';
      },
      {
        retries: 5,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        onRetry: (err, attempt, delayMs) => {
          events.push({ message: err.message, attempt, delayMs });
        },
      }
    )
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 0);
  assert.equal(events[0].message, 'fail-1');
  assert.equal(events[1].attempt, 1);
  assert.equal(events[1].message, 'fail-2');
  assert.ok(events[0].delayMs > 0);
});

test('a throwing onRetry does not break the retry loop', async () => {
  let calls = 0;
  const result = await withNoJitter(() =>
    retry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('flaky');
        return 'ok';
      },
      {
        retries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        onRetry: () => {
          throw new Error('logging backend is down');
        },
      }
    )
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('per-attempt timeout causes a retry, and a fast attempt after wins', async () => {
  let calls = 0;
  const result = await withNoJitter(() =>
    retry(
      () => {
        calls++;
        if (calls === 1) {
          return new Promise((resolve) => setTimeout(() => resolve('too-slow'), 100));
        }
        return Promise.resolve('fast');
      },
      { retries: 2, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10 }
    )
  );
  assert.equal(result, 'fast');
  assert.equal(calls, 2);
});

test('rejects immediately with RetryAbortError if signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));

  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          return 'should not run';
        },
        { signal: controller.signal }
      ),
    RetryAbortError
  );
  assert.equal(calls, 0);
});

test('aborts mid-backoff via signal', async () => {
  const controller = new AbortController();
  let calls = 0;

  const promise = retry(
    async () => {
      calls++;
      throw new Error('flaky');
    },
    { retries: 10, baseDelayMs: 1000, maxDelayMs: 1000, signal: controller.signal }
  );

  setTimeout(() => controller.abort(new Error('user cancelled')), 20);

  await assert.rejects(() => promise, RetryAbortError);
  assert.equal(calls, 1);
});

test('does not retry when retries is 0', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new Error('nope');
        },
        { retries: 0 }
      ),
    (err) => {
      assert.ok(err instanceof RetryExhaustedError);
      assert.equal(err.attempts, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('rejects a negative retries option', async () => {
  await assert.rejects(() => retry(async () => 'x', { retries: -1 }), RangeError);
});

test('rejects a non-function fn argument', async () => {
  await assert.rejects(() => retry('not a function'), TypeError);
});

test('computeDelay stays within [0, min(cap, base * 2^attempt)]', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 5000 };
  for (let attempt = 0; attempt < 10; attempt++) {
    const delay = computeDelay(attempt, opts);
    const expectedCap = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
    assert.ok(delay >= 0, `delay ${delay} should be >= 0`);
    assert.ok(delay <= expectedCap, `delay ${delay} should be <= ${expectedCap}`);
  }
});

test('computeDelay is capped by maxDelayMs for large attempt counts', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
  const delay = computeDelay(20, opts);
  assert.ok(delay <= opts.maxDelayMs);
});
