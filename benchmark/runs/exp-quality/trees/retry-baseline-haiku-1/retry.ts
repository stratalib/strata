export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFraction?: number;
  shouldRetry?: (error: Error) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFraction: 0.1,
  shouldRetry: () => true,
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      if (attempt === config.maxAttempts || !config.shouldRetry(err)) {
        throw err;
      }

      const delayMs = calculateBackoffDelay(
        attempt - 1,
        config.initialDelayMs,
        config.maxDelayMs,
        config.backoffMultiplier,
        config.jitterFraction,
      );

      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('Retry failed');
}

function calculateBackoffDelay(
  attemptNumber: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitterFraction: number,
): number {
  const exponentialDelay = Math.min(
    initialDelayMs * Math.pow(backoffMultiplier, attemptNumber),
    maxDelayMs,
  );

  const jitter = exponentialDelay * jitterFraction * Math.random();
  return exponentialDelay + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
