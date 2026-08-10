export interface RetryOptions {
  /** Maximum number of attempts, including the first. Default 5. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 200. */
  baseDelayMs?: number;
  /** Delay is capped at this value regardless of attempt count. Default 10_000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each attempt. Default 2. */
  factor?: number;
  /** Decide whether a given error should trigger a retry. Default: retryDefault. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each sleep, useful for logging/metrics. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Aborts the retry loop early, rejecting with the signal's reason. */
  signal?: AbortSignal;
}

export class RetryAbortedError extends Error {
  constructor(reason?: unknown) {
    super("Retry loop aborted");
    this.name = "RetryAbortedError";
    this.cause = reason;
  }
}

export class RetryExhaustedError extends Error {
  readonly lastError: unknown;
  readonly attempts: number;

  constructor(attempts: number, lastError: unknown) {
    super(`Retry failed after ${attempts} attempt(s)`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.cause = lastError;
  }
}

interface HttpLikeError {
  status?: number;
  statusCode?: number;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

/**
 * Retries network/5xx/429 failures; treats other 4xx as non-retryable since
 * a retry can't fix a malformed request or auth failure.
 */
export function retryDefault(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }

  const code = (error as { code?: string } | undefined)?.code;
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  // Unknown shape (e.g. plain thrown string/Error with no status/code) — retry
  // by default since flaky APIs often throw opaque errors on transient failure.
  return true;
}

function extractStatus(error: unknown): number | undefined {
  const e = error as HttpLikeError | undefined;
  return e?.status ?? e?.statusCode;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortedError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new RetryAbortedError(signal?.reason));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Full-jitter exponential backoff: delay is chosen uniformly from [0, cap],
 * where cap grows exponentially. Spreads retries from concurrent callers
 * instead of having them all retry in lockstep.
 */
export function computeDelay(
  attempt: number,
  { baseDelayMs = 200, maxDelayMs = 10_000, factor = 2 }: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "factor"> = {},
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
  return Math.random() * cap;
}

/**
 * Calls `fn`, retrying with exponential backoff + full jitter on failure.
 *
 * `fn` receives the current attempt number (1-indexed) in case it wants to
 * vary behavior (e.g. tighter per-attempt timeout on later tries).
 */
export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, shouldRetry = retryDefault, onRetry, signal } = options;

  if (maxAttempts < 1) {
    throw new RangeError("maxAttempts must be >= 1");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new RetryAbortedError(signal.reason);
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        break;
      }

      const delayMs = computeDelay(attempt, options);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, signal);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}
