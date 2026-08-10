// A helper for calling a flaky API with automatic retries and exponential
// backoff. Zero dependencies — relies on the global `fetch` built into Node 18+.

/**
 * Error thrown when all retry attempts are exhausted. Carries the underlying
 * cause (the last error or a synthesized one for a bad HTTP response) so the
 * caller can inspect what actually went wrong.
 */
export class RetryError extends Error {
  constructor(message, { attempts, cause } = {}) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    // `cause` is the standard Error field (Node 16.9+); preserving it means a
    // caller still gets the real network error / status, not just our wrapper.
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Default decision on whether a *thrown error* is worth retrying.
 *
 * We retry transient transport failures (DNS hiccups, resets, timeouts) but NOT
 * things like AbortError from the caller's own signal — if the caller cancelled,
 * hammering the API is the last thing they want.
 */
function defaultShouldRetryError(error) {
  if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return false;
  }
  return true;
}

/**
 * Default decision on whether an HTTP *response* is worth retrying.
 *
 * 429 (rate limited) and 5xx (server-side) are transient — the same request may
 * well succeed later. Other 4xx are the client's fault (bad auth, bad input) and
 * will fail identically no matter how many times we try, so we give up fast.
 */
function defaultShouldRetryResponse(response) {
  return response.status === 429 || response.status >= 500;
}

/**
 * Sleep that respects an AbortSignal, so a cancelled call doesn't sit idle for
 * the full backoff delay before noticing it was aborted.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
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
 * If the server told us how long to wait (Retry-After header), honour it —
 * the server knows better than our backoff formula does. Supports both the
 * seconds form (`Retry-After: 5`) and the HTTP-date form.
 * Returns a delay in ms, or null if there's no usable header.
 */
function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);

  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());

  return null;
}

/**
 * Compute the backoff delay for a given attempt using exponential growth with
 * "full jitter": a random value in [0, exponential-cap]. Jitter is not decorative
 * — without it, many clients that failed at the same instant retry at the same
 * instants forever (a thundering herd), so we deliberately spread them out.
 *
 * @param {number} attempt      zero-based attempt index (0 = first retry)
 * @param {number} baseMs       delay for the first retry before jitter
 * @param {number} maxDelayMs   ceiling so backoff can't grow unbounded
 * @param {() => number} random injectable RNG for deterministic tests
 */
function backoffMs(attempt, baseMs, maxDelayMs, random = Math.random) {
  const exponential = baseMs * 2 ** attempt;
  const capped = Math.min(exponential, maxDelayMs);
  return Math.round(random() * capped);
}

/**
 * Call an async function, retrying with exponential backoff + jitter on failure.
 *
 * This is the generic core — it knows nothing about HTTP. `fetchWithRetry` below
 * is a thin HTTP-flavoured wrapper on top of it.
 *
 * @template T
 * @param {() => Promise<T>} fn                the operation to attempt
 * @param {object} [options]
 * @param {number} [options.retries=3]         retries AFTER the first try (4 calls total)
 * @param {number} [options.baseMs=300]        first-retry delay before jitter
 * @param {number} [options.maxDelayMs=10000]  ceiling on any single backoff wait
 * @param {(error: unknown, attempt: number) => boolean} [options.shouldRetry]
 * @param {AbortSignal} [options.signal]       cancels waiting and stops retrying
 * @param {(info: object) => void} [options.onRetry]  observability hook per retry
 * @param {() => number} [options.random]      injectable RNG (tests)
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    baseMs = 300,
    maxDelayMs = 10_000,
    shouldRetry = defaultShouldRetryError,
    signal,
    onRetry,
    random = Math.random,
  } = options;

  let lastError;
  // retries + 1 total attempts: the initial try plus `retries` more.
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === retries;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }
      // A retry directive can ride along on the error (see fetchWithRetry, which
      // attaches the server's Retry-After). Otherwise fall back to computed backoff.
      const delay = error?.retryAfterMs ?? backoffMs(attempt, baseMs, maxDelayMs, random);
      onRetry?.({ attempt, delay, error });
      await sleep(delay, signal);
    }
  }
  // Unreachable in practice: the loop either returns or throws. Kept for safety.
  throw lastError;
}

/**
 * `fetch` with retries + backoff for a flaky HTTP API.
 *
 * On a retryable *response* (429/5xx by default) we retry; on a non-retryable
 * response we return it as-is and let the caller deal with it — a 404 is a valid
 * answer, not an error to throw. Only when retries are exhausted on a still-bad
 * response do we surface a RetryError.
 *
 * @param {string | URL | Request} url
 * @param {RequestInit & {
 *   retries?: number,
 *   baseMs?: number,
 *   maxDelayMs?: number,
 *   shouldRetryResponse?: (response: Response) => boolean,
 *   shouldRetryError?: (error: unknown) => boolean,
 *   onRetry?: (info: object) => void,
 *   random?: () => number,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    retries = 3,
    baseMs = 300,
    maxDelayMs = 10_000,
    shouldRetryResponse = defaultShouldRetryResponse,
    shouldRetryError = defaultShouldRetryError,
    onRetry,
    random = Math.random,
    fetchImpl = fetch,
    signal,
    ...fetchInit
  } = options;

  let lastResponse;

  try {
    return await withRetry(
      async () => {
        const response = await fetchImpl(url, { ...fetchInit, signal });
        if (shouldRetryResponse(response)) {
          lastResponse = response;
          // Throw a sentinel so withRetry's backoff loop kicks in. We tag it with
          // the status and any server-provided Retry-After so the delay can honour it.
          const err = new Error(`Retryable HTTP status ${response.status}`);
          err.name = 'HttpRetryableError';
          err.status = response.status;
          err.response = response;
          const ra = retryAfterMs(response);
          // Honour the server's Retry-After, but cap it at maxDelayMs so a
          // misconfigured (or hostile) `Retry-After: 86400` can't block us for a day.
          if (ra !== null) err.retryAfterMs = Math.min(ra, maxDelayMs);
          throw err;
        }
        return response;
      },
      {
        retries,
        baseMs,
        maxDelayMs,
        signal,
        onRetry,
        random,
        // A thrown sentinel is always retryable; real transport errors defer to
        // the caller's error predicate.
        shouldRetry: (error, attempt) =>
          error?.name === 'HttpRetryableError' || shouldRetryError(error, attempt),
      },
    );
  } catch (error) {
    // Exhausted retries on a bad-but-retryable response: return the last response
    // rather than throwing, so the caller can still read the body/status. This is
    // the option I'd defend — a caller that wants to throw can check `.ok`, but a
    // caller that got a real 503 body back can't un-throw it.
    if (error?.name === 'HttpRetryableError' && lastResponse) {
      return lastResponse;
    }
    // A genuine transport error that couldn't be recovered: wrap it so the caller
    // sees a consistent RetryError with the attempt count and the real cause.
    throw new RetryError(
      `Request to ${String(url)} failed after ${retries + 1} attempt(s): ${error?.message ?? error}`,
      { attempts: retries + 1, cause: error },
    );
  }
}

export const _internals = { backoffMs, retryAfterMs, defaultShouldRetryResponse, sleep };
