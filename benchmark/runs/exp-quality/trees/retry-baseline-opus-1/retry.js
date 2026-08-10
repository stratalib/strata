/**
 * Call a flaky async function, retrying with exponential backoff + jitter.
 *
 * The core idea: some failures are transient (a server hiccup, a rate-limit
 * blip, a dropped connection). Those are worth trying again after a short,
 * growing pause. Other failures are permanent (a 404, a bad request) and
 * retrying just wastes time and hammers the API — so we don't.
 */

/**
 * Error thrown when every attempt has been exhausted. It carries the last
 * underlying error so the caller can inspect what actually went wrong.
 */
export class RetryError extends Error {
  constructor(message, { attempts, lastError } = {}) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    // `cause` is the standard place Node/JS puts the wrapped error; setting it
    // means `console.log(err.cause)` and error-chaining tools just work.
    this.cause = lastError;
    this.lastError = lastError;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Default policy for deciding whether an error is worth retrying.
 *
 * Retries: network/connection errors, timeouts, HTTP 429, and HTTP 5xx.
 * Does NOT retry: 4xx client errors other than 429 — those won't fix
 * themselves. If the error exposes an HTTP status we key off it; otherwise
 * we assume it's a transport-level failure (which is transient) and retry.
 */
export function defaultShouldRetry(error) {
  const status = getStatus(error);
  if (status === undefined) {
    // No HTTP status => almost always a network/DNS/timeout error. Retry.
    return true;
  }
  if (status === 429) return true; // rate limited — backoff is exactly the fix
  if (status >= 500 && status <= 599) return true; // server-side, transient
  return false; // other 4xx: permanent, don't retry
}

// Pull an HTTP status off whatever shape the error/response happens to have.
function getStatus(error) {
  if (error == null) return undefined;
  if (typeof error.status === "number") return error.status;
  if (typeof error.statusCode === "number") return error.statusCode;
  if (error.response && typeof error.response.status === "number") {
    return error.response.status;
  }
  return undefined;
}

/**
 * Retry an async operation with exponential backoff and jitter.
 *
 * @param {(info: { attempt: number, signal: AbortSignal }) => Promise<any>} fn
 *   The operation to run. Receives the current attempt number (1-based) and an
 *   AbortSignal that fires when the per-attempt timeout elapses. It should be
 *   idempotent — a retry may re-run work that partially succeeded.
 * @param {object} [options]
 * @param {number} [options.retries=3]        Retries AFTER the first try (so 3 => up to 4 calls).
 * @param {number} [options.minDelayMs=200]   Delay before the first retry.
 * @param {number} [options.maxDelayMs=10000] Upper bound on any single delay.
 * @param {number} [options.factor=2]         Multiplier for the exponential growth.
 * @param {number} [options.timeoutMs]        Per-attempt timeout. Omit for no timeout.
 * @param {(error: any) => boolean} [options.shouldRetry]  Override the retry policy.
 * @param {(info) => void} [options.onRetry]  Called before each backoff wait (for logging/metrics).
 * @param {AbortSignal} [options.signal]      Cancel the whole operation from outside.
 * @param {() => number} [options.random=Math.random]  Injectable RNG (makes jitter testable).
 * @returns {Promise<any>} Resolves with fn's result, or rejects with RetryError.
 */
export async function retry(fn, options = {}) {
  const {
    retries = 3,
    minDelayMs = 200,
    maxDelayMs = 10_000,
    factor = 2,
    timeoutMs,
    shouldRetry = defaultShouldRetry,
    onRetry,
    signal,
    random = Math.random,
  } = options;

  if (typeof fn !== "function") {
    throw new TypeError("retry: first argument must be a function");
  }
  if (retries < 0 || !Number.isFinite(retries)) {
    throw new RangeError("retry: retries must be a non-negative finite number");
  }

  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Retry aborted");
    }

    // Wire up the per-attempt timeout. We combine it with any caller-supplied
    // signal so either one can abort the in-flight attempt.
    const attemptController = new AbortController();
    const onOuterAbort = () => attemptController.abort(signal.reason);
    let timeoutId;

    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
    if (timeoutMs != null) {
      timeoutId = setTimeout(() => {
        attemptController.abort(new TimeoutError(timeoutMs, attempt));
      }, timeoutMs);
    }

    try {
      return await fn({ attempt, signal: attemptController.signal });
    } catch (error) {
      lastError = error;

      // If the caller cancelled us from outside, stop immediately — an
      // external abort is not a "flaky API" condition to retry through.
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }

      // A permanent (non-retryable) error is the caller's real problem — throw
      // it raw so they see the true status/message, not a wrapper.
      if (!shouldRetry(error)) {
        throw error;
      }

      // Retryable, but we're out of attempts: wrap so the caller can see how
      // many tries we made while still reaching the cause via `.cause`.
      const isLastAttempt = attempt === retries + 1;
      if (isLastAttempt) {
        throw new RetryError(
          `Operation failed after ${attempt} attempt(s): ${error?.message ?? error}`,
          { attempts: attempt, lastError: error }
        );
      }

      const delay = backoffDelay({
        attempt,
        minDelayMs,
        maxDelayMs,
        factor,
        random,
      });

      onRetry?.({ attempt, delay, error });
      await sleep(delay, signal);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  // Unreachable in practice, but keeps the function total.
  throw new RetryError("Operation failed", { attempts: retries + 1, lastError });
}

/**
 * Compute the delay before a given attempt's retry, using exponential growth
 * capped at maxDelayMs, then "full jitter": a random value in [0, cap].
 *
 * Full jitter (random in [0, cap]) spreads retries out far better than fixed
 * backoff — it prevents many clients from all retrying at the same instant
 * (the "thundering herd"). See AWS's "Exponential Backoff And Jitter".
 */
export function backoffDelay({
  attempt,
  minDelayMs = 200,
  maxDelayMs = 10_000,
  factor = 2,
  random = Math.random,
}) {
  const exponential = minDelayMs * Math.pow(factor, attempt - 1);
  const cap = Math.min(exponential, maxDelayMs);
  return Math.round(random() * cap);
}

/**
 * Error used to signal a per-attempt timeout. It reports no HTTP status, so
 * the default policy treats it as a transient failure and retries it.
 */
export class TimeoutError extends Error {
  constructor(timeoutMs, attempt) {
    super(`Attempt ${attempt} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.attempt = attempt;
  }
}

/**
 * Convenience wrapper around fetch() with retry + per-attempt timeout.
 *
 * Turns non-ok responses into errors carrying `.status`, so the default retry
 * policy (retry 429 + 5xx, give up on other 4xx) applies without extra work.
 *
 * @param {string | URL} url
 * @param {object} [init]              Standard fetch init.
 * @param {object} [retryOptions]      Same options as retry().
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init = {}, retryOptions = {}) {
  return retry(async ({ signal }) => {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      const error = new Error(
        `Request to ${url} failed with status ${response.status}`
      );
      error.status = response.status;
      error.response = response;
      throw error;
    }
    return response;
  }, retryOptions);
}
