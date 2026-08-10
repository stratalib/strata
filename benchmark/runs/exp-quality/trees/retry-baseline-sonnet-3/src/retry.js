/**
 * Retry a flaky async operation with exponential backoff and jitter.
 *
 * @template T
 * @param {() => Promise<T>} fn - The operation to attempt. Called once per try.
 * @param {object} [options]
 * @param {number} [options.retries=3] - Max number of retries after the initial attempt.
 * @param {number} [options.baseDelayMs=200] - Base delay for backoff calculation.
 * @param {number} [options.maxDelayMs=10000] - Upper bound on any single delay.
 * @param {(error: unknown, attempt: number) => boolean} [options.isRetryable] - Decide whether
 *   an error should trigger another attempt. Defaults to retrying network errors, timeouts,
 *   429, and 5xx HTTP responses.
 * @param {(info: { error: unknown, attempt: number, delayMs: number }) => void} [options.onRetry] -
 *   Called before each retry delay, useful for logging/metrics.
 * @param {AbortSignal} [options.signal] - Aborts both in-flight attempts and pending backoff waits.
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 200,
    maxDelayMs = 10000,
    isRetryable = defaultIsRetryable,
    onRetry,
    signal,
  } = options;

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

      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.({ error, attempt, delayMs });
      await sleep(delayMs, signal);
      attempt++;
    }
  }
}

/**
 * Full-jitter exponential backoff: random value in [0, min(maxDelayMs, base * 2^attempt)].
 * Full jitter (rather than a fixed or capped-additive delay) spreads retries out best under
 * many concurrent clients, avoiding synchronized retry storms against the same flaky API.
 * @param {number} attempt
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {number}
 */
function computeBackoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * cap;
}

/**
 * @param {unknown} error
 * @param {number} _attempt
 * @returns {boolean}
 */
function defaultIsRetryable(error, _attempt) {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }

  // Node's fetch throws TypeError for network-level failures (DNS, connection refused, etc).
  if (error instanceof TypeError) {
    return true;
  }

  if (error && typeof error === 'object' && 'name' in error) {
    // AbortError from a timeout (not from the caller's own signal) is retryable.
    if (error.name === 'TimeoutError') {
      return true;
    }
  }

  return false;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

/** Error type carrying an HTTP status, thrown by {@link fetchJson}. */
class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {Response} response
   */
  constructor(message, status, response) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.response = response;
  }
}

/**
 * Fetch JSON from a URL, applying a per-attempt timeout and throwing {@link HttpError}
 * on non-OK responses so {@link retryWithBackoff}'s default policy can classify it.
 *
 * @param {string | URL} url
 * @param {object} [options]
 * @param {RequestInit} [options.init] - Passed through to fetch.
 * @param {number} [options.timeoutMs=10000] - Per-attempt timeout.
 * @param {AbortSignal} [options.signal] - External abort signal, combined with the timeout.
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, options = {}) {
  const { init, timeoutMs = 10000, signal } = options;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, { ...init, signal: combinedSignal });

  if (!response.ok) {
    throw new HttpError(`Request to ${url} failed with status ${response.status}`, response.status, response);
  }

  return response.json();
}

module.exports = {
  retryWithBackoff,
  computeBackoffDelay,
  defaultIsRetryable,
  fetchJson,
  HttpError,
};
