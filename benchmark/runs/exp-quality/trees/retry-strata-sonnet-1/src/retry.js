'use strict';

class RetryAbortError extends Error {
  constructor(cause) {
    super(`Retry aborted: ${cause && cause.message ? cause.message : cause}`);
    this.name = 'RetryAbortError';
    this.cause = cause;
  }
}

class RetryExhaustedError extends Error {
  constructor(attempts, cause) {
    super(`Retry exhausted after ${attempts} attempt(s): ${cause && cause.message ? cause.message : cause}`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Delay for attempt N (0-indexed) using full jitter: a random value in
 * [0, min(cap, base * 2^attempt)]. Full jitter avoids every failed caller
 * retrying in lockstep and hammering the API at the same instants.
 */
function computeDelay(attempt, { baseDelayMs, maxDelayMs }) {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const cap = Math.min(exp, maxDelayMs);
  return Math.random() * cap;
}

const DEFAULT_OPTIONS = {
  retries: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  timeoutMs: undefined,
  isRetryable: () => true,
  onRetry: null,
  signal: undefined,
};

/**
 * Call `fn` and retry with exponential backoff + full jitter if it rejects.
 *
 * @param {() => Promise<T>} fn - Called fresh on every attempt (no memoized args).
 * @param {object} [options]
 * @param {number} [options.retries=3] - Max retries after the first attempt (so up to retries+1 calls total).
 * @param {number} [options.baseDelayMs=200] - Backoff base delay.
 * @param {number} [options.maxDelayMs=10000] - Ceiling on any single delay.
 * @param {number} [options.timeoutMs] - Optional per-attempt timeout; a timed-out attempt is treated as a failure and may be retried.
 * @param {(error: unknown, attempt: number) => boolean} [options.isRetryable] - Decide whether an error should be retried. Defaults to retrying everything.
 * @param {(error: unknown, attempt: number, delayMs: number) => void} [options.onRetry] - Called before each backoff sleep; useful for logging/metrics.
 * @param {AbortSignal} [options.signal] - Abort in-flight waiting/attempts early.
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (typeof fn !== 'function') {
    throw new TypeError('retry: fn must be a function');
  }
  if (opts.retries < 0) {
    throw new RangeError('retry: retries must be >= 0');
  }

  let lastError;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal && opts.signal.aborted) {
      throw new RetryAbortError(opts.signal.reason || new Error('Aborted before attempt'));
    }

    try {
      if (opts.timeoutMs) {
        return await callWithTimeout(fn, opts.timeoutMs, opts.signal);
      }
      return await fn();
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === opts.retries;
      const retryable = safeIsRetryable(opts.isRetryable, err, attempt);

      if (isLastAttempt || !retryable) {
        break;
      }

      const delayMs = computeDelay(attempt, opts);
      if (opts.onRetry) {
        try {
          opts.onRetry(err, attempt, delayMs);
        } catch {
          // onRetry is a side-effect hook (logging/metrics); its failure must not
          // mask the real error or abort a retry loop that's otherwise healthy.
        }
      }

      try {
        await sleep(delayMs, opts.signal);
      } catch (abortReason) {
        throw new RetryAbortError(abortReason);
      }
    }
  }

  throw new RetryExhaustedError(opts.retries + 1, lastError);
}

function safeIsRetryable(isRetryable, err, attempt) {
  try {
    return Boolean(isRetryable(err, attempt));
  } catch {
    return false;
  }
}

async function callWithTimeout(fn, timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let timer;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Attempt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  retry,
  RetryAbortError,
  RetryExhaustedError,
  computeDelay,
};
