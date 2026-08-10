'use strict';
const { createHttpClient, backoffDelay, CircuitOpenError, HttpError } = require('strata-composed');

/**
 * Create a resilient API client with automatic retry and backoff.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]     - Base URL for the API
 * @param {number} [opts.retries=3]   - Number of retries after the first attempt
 * @param {number} [opts.timeoutMs=10000] - Per-attempt timeout
 * @param {object} [opts.headers]     - Default headers to send with every request
 * @param {object} [opts.backoff]     - Backoff options: { baseMs, maxMs, jitter }
 * @param {object} [opts.circuitBreaker] - Circuit breaker config: { failureThreshold, resetTimeoutMs }
 * @param {Function} [opts.onRetry]   - Callback: ({ attempt, delayMs, reason }) => void
 * @returns {object} HTTP client with get/post/put/patch/delete/head methods
 *
 * Example:
 *   const client = createRetryClient({ baseUrl: 'https://api.example.com', retries: 5 });
 *   try {
 *     const data = await client.get('/endpoint');
 *   } catch (err) {
 *     if (err instanceof CircuitOpenError) console.log('Circuit open, retry in', err.msRemaining, 'ms');
 *     else if (err instanceof HttpError) console.log('Failed after', err.attempts, 'attempts');
 *   }
 */
function createRetryClient(opts) {
  return createHttpClient(opts);
}

module.exports = {
  createRetryClient,
  backoffDelay,
  CircuitOpenError,
  HttpError,
};
