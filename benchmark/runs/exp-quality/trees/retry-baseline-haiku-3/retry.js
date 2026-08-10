class RetryError extends Error {
  constructor(message, lastError) {
    super(message);
    this.name = 'RetryError';
    this.lastError = lastError;
  }
}

async function retryWithBackoff(
  fn,
  {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 10000,
    backoffFactor = 2,
    jitterFraction = 0.1,
    shouldRetry = (error) => true,
  } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw new RetryError(
          `Failed after ${attempt} attempt(s)`,
          lastError
        );
      }

      const baseDelay = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt - 1),
        maxDelayMs
      );
      const jitter = baseDelay * jitterFraction * Math.random();
      const delay = baseDelay + jitter;

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = { retryWithBackoff, RetryError };
