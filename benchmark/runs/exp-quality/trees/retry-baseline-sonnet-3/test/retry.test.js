const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  retryWithBackoff,
  computeBackoffDelay,
  defaultIsRetryable,
  fetchJson,
  HttpError,
} = require('../src/retry');

test('retryWithBackoff: returns immediately on success, no retries', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retryWithBackoff: retries a retryable error then succeeds', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) {
        throw new TypeError('network down');
      }
      return 'ok';
    },
    { baseDelayMs: 1, maxDelayMs: 2 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retryWithBackoff: gives up after exhausting retries and throws last error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new TypeError(`fail ${calls}`);
        },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    /fail 3/,
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test('retryWithBackoff: does not retry a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new HttpError('bad request', 400, /** @type {any} */ ({}));
        },
        { baseDelayMs: 1, maxDelayMs: 2 },
      ),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test('retryWithBackoff: retries 429 and 5xx HttpErrors', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 2) {
          throw new HttpError('server error', status, /** @type {any} */ ({}));
        }
        return 'recovered';
      },
      { baseDelayMs: 1, maxDelayMs: 2 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  }
});

test('retryWithBackoff: custom isRetryable overrides default policy', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new TypeError('would normally retry');
        },
        { baseDelayMs: 1, maxDelayMs: 2, isRetryable: () => false },
      ),
  );
  assert.equal(calls, 1);
});

test('retryWithBackoff: onRetry is called with error, attempt, and delay before each retry', async () => {
  const events = [];
  let calls = 0;
  await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError('flaky');
      return 'ok';
    },
    {
      baseDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (info) => events.push(info),
    },
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 0);
  assert.equal(events[1].attempt, 1);
  assert.ok(events[0].error instanceof TypeError);
  assert.ok(typeof events[0].delayMs === 'number');
});

test('retryWithBackoff: aborts immediately via signal before first attempt', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          return 'should not run';
        },
        { signal: controller.signal },
      ),
    /cancelled by caller/,
  );
  assert.equal(calls, 0);
});

test('retryWithBackoff: aborts during backoff wait', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = retryWithBackoff(
    async () => {
      calls++;
      throw new TypeError('flaky');
    },
    { baseDelayMs: 1000, maxDelayMs: 1000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error('cancelled mid-wait')), 10);
  await assert.rejects(() => promise, /cancelled mid-wait/);
  assert.equal(calls, 1);
});

test('computeBackoffDelay: is bounded by maxDelayMs and non-negative', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const delay = computeBackoffDelay(attempt, 100, 5000);
    assert.ok(delay >= 0);
    assert.ok(delay <= 5000);
  }
});

test('computeBackoffDelay: grows with attempt number (upper bound doubles) until capped', () => {
  const cap0 = Math.min(5000, 100 * 2 ** 0);
  const cap3 = Math.min(5000, 100 * 2 ** 3);
  assert.equal(cap0, 100);
  assert.equal(cap3, 800);
  assert.ok(cap3 > cap0);
});

test('defaultIsRetryable: retries TypeError, 429, 5xx; rejects other 4xx', () => {
  assert.equal(defaultIsRetryable(new TypeError('x'), 0), true);
  assert.equal(defaultIsRetryable(new HttpError('x', 429, /** @type {any} */ ({})), 0), true);
  assert.equal(defaultIsRetryable(new HttpError('x', 500, /** @type {any} */ ({})), 0), true);
  assert.equal(defaultIsRetryable(new HttpError('x', 502, /** @type {any} */ ({})), 0), true);
  assert.equal(defaultIsRetryable(new HttpError('x', 404, /** @type {any} */ ({})), 0), false);
  assert.equal(defaultIsRetryable(new HttpError('x', 401, /** @type {any} */ ({})), 0), false);
  assert.equal(defaultIsRetryable(new Error('random'), 0), false);
});

test('fetchJson: returns parsed JSON on 200', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const data = await fetchJson(`http://localhost:${port}/`);
    assert.deepEqual(data, { hello: 'world' });
  } finally {
    server.close();
  }
});

test('fetchJson: throws HttpError with status on non-OK response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => fetchJson(`http://localhost:${port}/`),
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('fetchJson: times out and rejects when server hangs past timeoutMs', async () => {
  const server = http.createServer(() => {
    // Never respond.
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await assert.rejects(() => fetchJson(`http://localhost:${port}/`, { timeoutMs: 50 }));
  } finally {
    server.close();
  }
});

test('integration: retryWithBackoff + fetchJson recovers from a server that fails twice then succeeds', async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount < 3) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attempt: requestCount }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const data = await retryWithBackoff(() => fetchJson(`http://localhost:${port}/`), {
      baseDelayMs: 1,
      maxDelayMs: 5,
    });
    assert.equal(data.ok, true);
    assert.equal(requestCount, 3);
  } finally {
    server.close();
  }
});
