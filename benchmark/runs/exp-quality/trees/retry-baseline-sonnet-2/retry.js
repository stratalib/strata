'use strict';

/**
 * Calls an async function and retries with exponential backoff + jitter
 * if it throws. Retries are attempted for any rejection except AbortError
 * (which signals the caller wants to give up, e.g. via `signal`) and except
 * errors flagged non-retryable via `isRetryable`.
 *
 * @param {() => Promise<any>} fn - Function to call. Receives no args; wrap
 *   with a closure if you need to pass parameters (e.g. an AbortSignal).
 * @param {object} [options]
 * @param {number} [options.retries=3] - Max retry attempts after the first call.
 * @param {number} [options.baseDelayMs=200] - Base delay for backoff.
 * @param {number} [options.maxDelayMs=10000] - Cap on any single delay.
 * @param {number} [options.factor=2] - Exponential growth factor.
 * @param {number} [options.jitter=0.5] - Fraction of the delay randomized,
 *   in [0, 1]. 0 disables jitter. Full jitter avoids retry storms when many
 *   callers back off in lockstep.
 * @param {(error: any, attempt: number) => boolean} [options.isRetryable] -
 *   Predicate deciding whether an error should trigger a retry. Defaults to
 *   "retry everything except AbortError".
 * @param {(error: any, attempt: number, delayMs: number) => void} [options.onRetry] -
 *   Called before each retry delay, for logging/metrics.
 * @param {AbortSignal} [options.signal] - If provided and already aborted,
 *   or aborted during a backoff wait, retrying stops immediately.
 * @returns {Promise<any>} Resolves with fn's result, or rejects with the
 *   last error once retries are exhausted.
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 200,
    maxDelayMs = 10000,
    factor = 2,
    jitter = 0.5,
    isRetryable = defaultIsRetryable,
    onRetry,
    signal,
  } = options;

  if (typeof fn !== 'function') {
    throw new TypeError('retryWithBackoff: fn must be a function');
  }
  if (retries < 0) {
    throw new RangeError('retryWithBackoff: retries must be >= 0');
  }

  let attempt = 0;

  while (true) {
    throwIfAborted(signal);

    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt >= retries;
      if (isLastAttempt || !isRetryable(error, attempt)) {
        throw error;
      }

      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, factor, jitter);
      if (onRetry) onRetry(error, attempt, delayMs);

      await delay(delayMs, signal);
      attempt += 1;
    }
  }
}

function defaultIsRetryable(error) {
  return error?.name !== 'AbortError';
}

function computeDelay(attempt, baseDelayMs, maxDelayMs, factor, jitter) {
  const exponential = baseDelayMs * Math.pow(factor, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  if (jitter <= 0) return capped;
  // Full jitter within the jittered fraction: keeps a floor of (1 - jitter) * capped
  // so delays don't occasionally collapse to ~0 and hammer the flaky API immediately.
  const jitterFloor = capped * (1 - jitter);
  return jitterFloor + Math.random() * (capped - jitterFloor);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(makeAbortError());
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function makeAbortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Convenience wrapper: fetch a URL with retryWithBackoff, treating network
 * errors and 5xx/429 responses as retryable. 4xx (other than 429) is
 * treated as a permanent failure since retrying won't fix a bad request.
 *
 * @param {string} url
 * @param {object} [fetchOptions] - Passed through to fetch.
 * @param {object} [retryOptions] - Passed through to retryWithBackoff.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, fetchOptions = {}, retryOptions = {}) {
  return retryWithBackoff(async () => {
    const response = await fetch(url, fetchOptions);
    if (!response.ok && isRetryableStatus(response.status)) {
      const error = new Error(`Request failed with status ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }
    return response;
  }, {
    isRetryable: (error, attempt) => {
      if (error?.name === 'AbortError') return false;
      if (typeof error?.status === 'number') return isRetryableStatus(error.status);
      // Network-level failures (DNS, connection reset, etc.) have no status; retry them.
      return true;
    },
    ...retryOptions,
  });
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

module.exports = {
  retryWithBackoff,
  fetchWithRetry,
};
