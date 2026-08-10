'use strict';
// Retry helper for calls to a flaky API: exponential backoff with full jitter, honours
// Retry-After, and never retries a call that already told us it will fail identically forever.
//
// This wraps an arbitrary async function, not just fetch — the caller decides what "call the API"
// means (fetch, an SDK method, a DB round-trip), and just needs to throw on failure.

class RetryError extends Error {
  constructor(message, { attempts, cause }) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with FULL JITTER: delay is a random value in [0, min(maxMs, baseMs * 2^attempt)].
 *
 * Plain exponential backoff (no jitter) synchronizes every caller onto the same retry instants — a
 * recovering service gets hit by the whole fleet at t=1s, then again at t=2s, and never recovers.
 * Randomizing across the whole window spreads that load out (AWS's "Exponential Backoff and Jitter").
 */
function backoffDelay(attempt, { baseMs = 300, maxMs = 20_000 } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * exponential;
}

/** A 429/503 often carries Retry-After (seconds, or an HTTP-date). The server's own number beats our guess. */
function retryAfterMs(err) {
  const header = err && err.headers && typeof err.headers.get === 'function'
    ? err.headers.get('retry-after')
    : err && err.retryAfter;
  if (header == null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const date = new Date(header).getTime();
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return null;
}

// Retrying a request that already changed state risks doing it twice (e.g. charging a customer
// twice). Off by default; the caller opts in with `idempotent: true` when they know the call is
// safe to repeat (a GET, or a write guarded by an idempotency key).
const DEFAULT_IS_RETRYABLE = (err) => {
  // A caller-set `err.permanent` is authoritative: it will fail identically forever, don't retry.
  if (err && err.permanent === true) return false;
  if (err && err.permanent === false) return true;

  const status = err && (err.status ?? err.statusCode);
  if (status != null) {
    // 5xx = server broken, 429 = told to slow down, 408 = we timed out. A 4xx (other than 408/429)
    // will fail identically forever — retrying it just burns the budget.
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }

  // No status: a network-level failure (DNS, connection reset, our own timeout). Treat as transient —
  // an unrecognized failure is more often a blip than a permanent one.
  return true;
};

/**
 * Call `fn`, retrying on failure with exponential backoff + jitter.
 *
 * @param {() => Promise<any>} fn        The flaky call. Invoked fresh on every attempt.
 * @param {object} [opts]
 * @param {number} [opts.retries=3]      Retries after the first attempt (so up to retries+1 calls).
 * @param {number} [opts.baseMs=300]     Backoff base, doubled every attempt.
 * @param {number} [opts.maxMs=20000]    Backoff ceiling.
 * @param {(err) => boolean} [opts.isRetryable]  Decide whether a given error is worth retrying.
 * @param {(info: {attempt: number, delayMs: number, error: Error}) => void} [opts.onRetry]
 * @param {Function} [opts.sleepImpl]    Injectable for tests.
 * @returns {Promise<any>} whatever `fn` resolves to.
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseMs = 300,
    maxMs = 20_000,
    isRetryable = DEFAULT_IS_RETRYABLE,
    onRetry = null,
    sleepImpl = sleep,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === retries || !isRetryable(err)) {
        throw new RetryError(
          `failed after ${attempt + 1} attempt(s): ${err && err.message ? err.message : err}`,
          { attempts: attempt + 1, cause: err },
        );
      }

      const delayMs = retryAfterMs(err) ?? backoffDelay(attempt, { baseMs, maxMs });
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleepImpl(delayMs);
    }
  }

  // Unreachable — the loop always returns or throws — but keeps the function's type honest.
  throw lastError;
}

module.exports = { withRetry, backoffDelay, retryAfterMs, RetryError };
