'use strict';

// Retry helper for flaky APIs: exponential backoff with full jitter, a circuit breaker so a
// dead upstream fails fast instead of being hammered, and Retry-After support for 429/503.
// Built on strata-composed's http.resilient-client.v1 (see strata/lib.js for the implementation).
const { createHttpClient, HttpError, CircuitOpenError } = require('strata-composed');

/**
 * One-off GET-with-retry for a single URL. Convenience wrapper for the common case;
 * for repeated calls to the same host, use createRetryClient() instead so the circuit
 * breaker state is shared across calls.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.retries=3]     - retries after the first attempt (so up to 4 requests)
 * @param {number} [opts.timeoutMs=10000] - per attempt, not for the whole call
 * @param {Function} [opts.onRetry]     - ({ attempt, delayMs, reason }) => void
 */
async function fetchWithRetry(url, opts = {}) {
  const client = createHttpClient({ circuitBreaker: false, ...opts });
  return client.get(url, opts);
}

/**
 * A reusable client for a given base URL. Prefer this over fetchWithRetry when calling the
 * same API repeatedly — the circuit breaker then actually protects you, instead of resetting
 * on every call.
 */
function createRetryClient(opts = {}) {
  return createHttpClient(opts);
}

module.exports = { fetchWithRetry, createRetryClient, HttpError, CircuitOpenError };
