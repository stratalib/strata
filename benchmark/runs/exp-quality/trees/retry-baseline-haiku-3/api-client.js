const { retryWithBackoff } = require('./retry');

// Example: wrapping a fetch call with retry logic
async function fetchWithRetry(url, options = {}) {
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        timeout: 5000,
        ...options,
      });

      // Treat 5xx errors and timeouts as retryable, but not 4xx client errors
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status >= 500;
        throw error;
      }

      return response.json();
    },
    {
      maxAttempts: 4,
      initialDelayMs: 200,
      maxDelayMs: 5000,
      backoffFactor: 2,
      jitterFraction: 0.1,
      shouldRetry: (error) => {
        // Retry on network errors and server errors, but not client errors
        if (error.retryable === false) return false;
        if (error.message === 'timeout') return true;
        if (error.code === 'ECONNREFUSED') return true;
        if (error.status >= 500) return true;
        return true; // Retry by default (network errors, etc.)
      },
    }
  );
}

module.exports = { fetchWithRetry };
