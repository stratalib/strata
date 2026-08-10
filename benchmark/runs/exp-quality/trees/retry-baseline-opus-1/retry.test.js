import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retry,
  backoffDelay,
  defaultShouldRetry,
  fetchWithRetry,
  RetryError,
  TimeoutError,
} from "./retry.js";

// A small helper: a function that fails `failCount` times, then succeeds.
// Records how many times it was called so we can assert on retry behavior.
function flaky(failCount, { errorFactory } = {}) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls <= failCount) {
      throw (errorFactory ? errorFactory(calls) : new Error(`fail ${calls}`));
    }
    return `ok after ${calls}`;
  };
  fn.calls = () => calls;
  return fn;
}

// An error carrying an HTTP status, like a real API client would surface.
function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

test("succeeds on first try without retrying", async () => {
  const fn = flaky(0);
  const result = await retry(fn, { minDelayMs: 1 });
  assert.equal(result, "ok after 1");
  assert.equal(fn.calls(), 1);
});

test("retries then succeeds", async () => {
  const fn = flaky(2);
  const result = await retry(fn, { minDelayMs: 1, retries: 3 });
  assert.equal(result, "ok after 3");
  assert.equal(fn.calls(), 3);
});

test("exhausts retries and throws RetryError with cause", async () => {
  const fn = flaky(10);
  await assert.rejects(
    retry(fn, { minDelayMs: 1, retries: 2 }),
    (err) => {
      assert.ok(err instanceof RetryError);
      assert.equal(err.attempts, 3); // 1 initial + 2 retries
      assert.ok(err.cause instanceof Error);
      assert.match(err.cause.message, /fail 3/);
      return true;
    }
  );
  assert.equal(fn.calls(), 3);
});

test("retries: 0 means exactly one attempt", async () => {
  const fn = flaky(10);
  await assert.rejects(retry(fn, { retries: 0, minDelayMs: 1 }), RetryError);
  assert.equal(fn.calls(), 1);
});

test("does not retry a permanent error and surfaces it raw", async () => {
  const fn = flaky(10, { errorFactory: () => httpError(404) });
  await assert.rejects(
    retry(fn, { minDelayMs: 1, retries: 5 }),
    (err) => {
      // Raw error, NOT wrapped in RetryError — caller sees the real status.
      assert.ok(!(err instanceof RetryError));
      assert.equal(err.status, 404);
      return true;
    }
  );
  assert.equal(fn.calls(), 1);
});

test("retries a 429 and a 503 by default", async () => {
  for (const status of [429, 503]) {
    const fn = flaky(1, { errorFactory: () => httpError(status) });
    const result = await retry(fn, { minDelayMs: 1, retries: 2 });
    assert.equal(result, "ok after 2");
    assert.equal(fn.calls(), 2, `status ${status} should have retried`);
  }
});

test("custom shouldRetry overrides the default policy", async () => {
  const fn = flaky(10, { errorFactory: () => httpError(400) });
  // Force-retry a 400 (normally permanent). It should now retry to exhaustion.
  await assert.rejects(
    retry(fn, { minDelayMs: 1, retries: 2, shouldRetry: () => true }),
    RetryError
  );
  assert.equal(fn.calls(), 3);
});

test("onRetry fires once per backoff with attempt/delay/error", async () => {
  const events = [];
  const fn = flaky(2);
  await retry(fn, {
    minDelayMs: 1,
    retries: 3,
    onRetry: (info) => events.push(info),
  });
  assert.equal(events.length, 2); // two failures => two backoffs
  assert.equal(events[0].attempt, 1);
  assert.equal(events[1].attempt, 2);
  assert.ok(events[0].error instanceof Error);
  assert.equal(typeof events[0].delay, "number");
});

test("defaultShouldRetry classifies errors correctly", () => {
  assert.equal(defaultShouldRetry(new Error("network down")), true); // no status
  assert.equal(defaultShouldRetry(httpError(429)), true);
  assert.equal(defaultShouldRetry(httpError(500)), true);
  assert.equal(defaultShouldRetry(httpError(503)), true);
  assert.equal(defaultShouldRetry(httpError(400)), false);
  assert.equal(defaultShouldRetry(httpError(404)), false);
  assert.equal(defaultShouldRetry(httpError(401)), false);
  // statusCode and response.status shapes are also understood
  assert.equal(defaultShouldRetry({ statusCode: 502 }), true);
  assert.equal(defaultShouldRetry({ response: { status: 418 } }), false);
});

test("backoffDelay grows exponentially and is capped", () => {
  // With random() pinned to 1, full-jitter returns the full cap, so we can
  // check the exponential ceiling deterministically.
  const one = () => 1;
  assert.equal(backoffDelay({ attempt: 1, minDelayMs: 100, factor: 2, random: one }), 100);
  assert.equal(backoffDelay({ attempt: 2, minDelayMs: 100, factor: 2, random: one }), 200);
  assert.equal(backoffDelay({ attempt: 3, minDelayMs: 100, factor: 2, random: one }), 400);
  // Capped at maxDelayMs regardless of how high the exponential climbs.
  assert.equal(
    backoffDelay({ attempt: 10, minDelayMs: 100, factor: 2, maxDelayMs: 1000, random: one }),
    1000
  );
});

test("backoffDelay applies full jitter within [0, cap]", () => {
  // random() = 0.5 => half of the cap.
  const half = () => 0.5;
  assert.equal(backoffDelay({ attempt: 2, minDelayMs: 100, factor: 2, random: half }), 100);
  // random() = 0 => zero delay (a legitimate full-jitter outcome).
  assert.equal(backoffDelay({ attempt: 5, minDelayMs: 100, random: () => 0 }), 0);
});

test("per-attempt timeout aborts a hanging call and is retried", async () => {
  let calls = 0;
  const fn = async ({ signal }) => {
    calls += 1;
    if (calls === 1) {
      // Hang until aborted by the timeout.
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return "recovered";
  };
  const result = await retry(fn, { minDelayMs: 1, retries: 2, timeoutMs: 20 });
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("timeout error is a TimeoutError and retryable by default", async () => {
  const fn = async ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  await assert.rejects(
    retry(fn, { minDelayMs: 1, retries: 1, timeoutMs: 15 }),
    (err) => {
      assert.ok(err instanceof RetryError);
      assert.ok(err.cause instanceof TimeoutError);
      return true;
    }
  );
});

test("external AbortSignal cancels immediately and throws raw abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  const fn = async () => {
    controller.abort(reason);
    throw new Error("transient"); // would normally retry
  };
  await assert.rejects(
    retry(fn, { minDelayMs: 50, retries: 5, signal: controller.signal }),
    (err) => {
      // Aborted mid-flight: raw reason, not RetryError, and no further tries.
      assert.equal(err, reason);
      return true;
    }
  );
});

test("aborting before start throws without calling fn", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already gone"));
  let called = false;
  await assert.rejects(
    retry(
      async () => {
        called = true;
      },
      { signal: controller.signal }
    ),
    /already gone/
  );
  assert.equal(called, false);
});

test("rejects a non-function first argument", async () => {
  await assert.rejects(retry(42), TypeError);
});

test("fetchWithRetry retries a 500 then returns the ok response", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 500 });
    return new Response("ok", { status: 200 });
  };
  try {
    const res = await fetchWithRetry("https://example.test", {}, { minDelayMs: 1, retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchWithRetry gives up on a 404 without retrying", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("nope", { status: 404 });
  };
  try {
    await assert.rejects(
      fetchWithRetry("https://example.test", {}, { minDelayMs: 1, retries: 3 }),
      (err) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
