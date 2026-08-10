/**
 * Retry an async operation with exponential backoff + full jitter.
 *
 * "Full jitter" means each delay is a random value between 0 and the current
 * exponential ceiling, so a fleet of clients failing at once doesn't retry in
 * lockstep and stampede the API (the "thundering herd"). This is the strategy
 * AWS recommends for backoff.
 */

/**
 * Sleep for `ms`, resolving early-rejecting if the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal) {
  // Prefer the reason the caller supplied to abort(reason); fall back to a
  // standard AbortError so callers can branch on err.name.
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Default retryability check for a rejected operation.
 *
 * Retries on network-ish errors and on HTTP 429 / 5xx, where the error is
 * assumed to carry a numeric `status` or `statusCode` (as fetch-wrapping code
 * commonly attaches). A 4xx other than 429 is treated as the caller's fault and
 * is NOT retried — the same request will just fail the same way.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function defaultIsRetryable(error) {
  if (!error || typeof error !== 'object') return true;

  // Explicit opt-out wins over any status heuristic.
  if (error.retryable === false) return false;
  if (error.retryable === true) return true;

  const status = error.status ?? error.statusCode;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status <= 599);
  }

  // Common transient network error codes (Node's fetch/undici, http, dns).
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  if (typeof error.code === 'string' && transientCodes.has(error.code)) {
    return true;
  }

  // No status, no known code: assume transient and let attempt limits stop us.
  return true;
}

/**
 * @template T
 * @param {(context: { attempt: number, signal?: AbortSignal }) => Promise<T>} fn
 *   The operation to run. Receives the 1-based attempt number and the signal.
 * @param {object} [options]
 * @param {number} [options.retries=3]        Max retries AFTER the first try (so retries+1 total attempts).
 * @param {number} [options.minDelayMs=200]   Base delay; the exponential ceiling starts here.
 * @param {number} [options.maxDelayMs=10000] Cap on any single backoff delay.
 * @param {number} [options.factor=2]         Exponential growth factor.
 * @param {(error: unknown) => boolean} [options.isRetryable=defaultIsRetryable]
 * @param {(info: { error: unknown, attempt: number, delayMs: number }) => void} [options.onRetry]
 * @param {AbortSignal} [options.signal]      Cancels pending retries and sleeps.
 * @param {() => number} [options.random=Math.random] Injectable RNG for the jitter (tests).
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  const {
    retries = 3,
    minDelayMs = 200,
    maxDelayMs = 10000,
    factor = 2,
    isRetryable = defaultIsRetryable,
    onRetry,
    signal,
    random = Math.random,
  } = options;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError('retries must be a non-negative integer');
  }
  if (!(minDelayMs >= 0) || !(maxDelayMs >= 0)) {
    throw new TypeError('minDelayMs and maxDelayMs must be non-negative');
  }
  if (!(factor >= 1)) {
    throw new TypeError('factor must be >= 1');
  }

  let attempt = 0;
  // Loop runs at most retries+1 times: the first try plus `retries` retries.
  while (true) {
    attempt += 1;
    if (signal?.aborted) throw abortError(signal);

    try {
      return await fn({ attempt, signal });
    } catch (error) {
      const outOfAttempts = attempt > retries;
      if (outOfAttempts || !isRetryable(error)) {
        throw error;
      }

      // Exponential ceiling for this attempt, capped, then full jitter.
      const ceiling = Math.min(maxDelayMs, minDelayMs * factor ** (attempt - 1));
      const delayMs = Math.floor(random() * ceiling);

      onRetry?.({ error, attempt, delayMs });

      await delay(delayMs, signal);
    }
  }
}

export default retry;
