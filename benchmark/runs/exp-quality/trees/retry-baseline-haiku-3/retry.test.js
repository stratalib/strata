const { retryWithBackoff, RetryError } = require('./retry');

async function runTests() {
  let testsPassed = 0;
  let testsFailed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      testsPassed++;
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.message}`);
      testsFailed++;
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
  }

  function assertTrue(value, message) {
    if (!value) {
      throw new Error(message);
    }
  }

  // Test 1: Succeeds on first attempt
  await test('succeeds on first attempt', async () => {
    const result = await retryWithBackoff(() => Promise.resolve('success'));
    assertEqual(result, 'success', 'should return result');
  });

  // Test 2: Retries and eventually succeeds
  await test('retries and eventually succeeds', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    };
    const result = await retryWithBackoff(fn);
    assertEqual(attempts, 3, 'should retry twice then succeed');
    assertEqual(result, 'success', 'should return result');
  });

  // Test 3: Gives up after maxAttempts
  await test('gives up after maxAttempts', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('always fails');
    };
    try {
      await retryWithBackoff(fn, { maxAttempts: 3 });
      throw new Error('should have thrown');
    } catch (error) {
      assertTrue(
        error instanceof RetryError,
        'should throw RetryError'
      );
      assertEqual(attempts, 3, 'should attempt exactly maxAttempts times');
      assertTrue(
        error.message.includes('3 attempt'),
        'should mention attempt count'
      );
    }
  });

  // Test 4: Respects shouldRetry predicate
  await test('respects shouldRetry predicate', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      const error = new Error('fail');
      error.code = attempts < 2 ? 'TIMEOUT' : 'PARSE_ERROR';
      throw error;
    };
    const shouldRetry = (error) => error.code === 'TIMEOUT';
    try {
      await retryWithBackoff(fn, { maxAttempts: 5, shouldRetry });
      throw new Error('should have thrown');
    } catch (error) {
      assertTrue(
        error instanceof RetryError,
        'should throw RetryError'
      );
      assertEqual(attempts, 2, 'should stop on first non-retryable error');
    }
  });

  // Test 5: Exponential backoff timing
  await test('exponential backoff timing', async () => {
    let attempts = 0;
    const timestamps = [];
    const fn = async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts < 3) throw new Error('fail');
    };
    await retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 50,
      backoffFactor: 2,
      jitterFraction: 0,
    });
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];
    assertTrue(
      delay1 >= 50 && delay1 < 100,
      `first delay should be ~50ms, got ${delay1}ms`
    );
    assertTrue(
      delay2 >= 100 && delay2 < 150,
      `second delay should be ~100ms, got ${delay2}ms`
    );
  });

  // Test 6: Respects maxDelayMs cap
  await test('respects maxDelayMs cap', async () => {
    let attempts = 0;
    const timestamps = [];
    const fn = async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts < 4) throw new Error('fail');
    };
    await retryWithBackoff(fn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 200,
      jitterFraction: 0,
    });
    const delay3 = timestamps[3] - timestamps[2];
    assertTrue(
      delay3 <= 220,
      `third delay should be capped at ~200ms, got ${delay3}ms`
    );
  });

  // Test 7: Adds jitter to delays
  await test('adds jitter to delays', async () => {
    let attempts = 0;
    const delays = [];
    const fn = async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
    };
    // Run multiple times to verify jitter exists
    for (let i = 0; i < 5; i++) {
      attempts = 0;
      const timestamps = [];
      const innerFn = async () => {
        timestamps.push(Date.now());
        attempts++;
        if (attempts < 2) throw new Error('fail');
      };
      await retryWithBackoff(innerFn, {
        maxAttempts: 2,
        initialDelayMs: 1000,
        jitterFraction: 0.5,
      });
      delays.push(timestamps[1] - timestamps[0]);
    }
    // Delays should vary due to jitter
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);
    assertTrue(
      maxDelay > minDelay,
      `delays should vary due to jitter: ${delays}`
    );
  });

  // Test 8: Preserves error chain
  await test('preserves error chain', async () => {
    const originalError = new Error('original');
    const fn = async () => {
      throw originalError;
    };
    try {
      await retryWithBackoff(fn, { maxAttempts: 1 });
      throw new Error('should have thrown');
    } catch (error) {
      assertEqual(
        error.lastError,
        originalError,
        'should preserve original error'
      );
    }
  });

  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
