import { retryWithBackoff } from './retry';

// Example 1: Basic API call with retry
async function fetchUserData(userId: string): Promise<{ id: string; name: string }> {
  return retryWithBackoff(async () => {
    const response = await fetch(`https://api.example.com/users/${userId}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  });
}

// Example 2: Retry only transient errors (not 4xx errors)
async function callFlakyApiEndpoint(): Promise<string> {
  return retryWithBackoff(
    async () => {
      const response = await fetch('https://api.example.com/data');
      if (response.status === 429 || response.status >= 500) {
        // Transient error - retry it
        throw new Error(`Transient error: ${response.status}`);
      }
      if (!response.ok) {
        // Permanent error - don't retry
        throw new Error(`Permanent error: ${response.status}`);
      }
      return response.text();
    },
    {
      maxAttempts: 5,
      initialDelayMs: 200,
      maxDelayMs: 5000,
      shouldRetry: (error) => {
        // Only retry if the error looks transient
        return error.message.includes('Transient') || error.message.includes('timeout');
      },
    },
  );
}

// Example 3: Database operation with exponential backoff
async function insertWithRetry(record: Record<string, unknown>): Promise<void> {
  return retryWithBackoff(
    async () => {
      // Simulate database insert
      const success = Math.random() > 0.3; // 70% success rate
      if (!success) {
        throw new Error('Connection timeout');
      }
    },
    {
      maxAttempts: 3,
      initialDelayMs: 50,
      maxDelayMs: 2000,
      backoffMultiplier: 2,
      jitterFraction: 0.1, // Add ±10% jitter to prevent thundering herd
    },
  );
}

export { fetchUserData, callFlakyApiEndpoint, insertWithRetry };
