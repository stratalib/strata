import { describe, it, expect, afterEach, vi } from 'vitest';
import { retryWithBackoff } from './retry';

describe('retryWithBackoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first attempt if successful', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    const promise = retryWithBackoff(fn, { maxAttempts: 3 });
    promise.catch(() => {}); // Suppress unhandled rejection warning
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom max attempts', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('failed'));
    const promise = retryWithBackoff(fn, { maxAttempts: 5 });
    promise.catch(() => {}); // Suppress unhandled rejection warning
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('uses exponential backoff with default multiplier', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('failed'));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      jitterFraction: 0,
    });
    promise.catch(() => {}); // Suppress unhandled rejection warning

    // First call
    expect(fn).toHaveBeenCalledTimes(1);

    // After first retry delay (100ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // After second retry delay (200ms)
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    // After third retry delay (400ms)
    await vi.advanceTimersByTimeAsync(400);
    expect(fn).toHaveBeenCalledTimes(4);

    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('failed');
  });

  it('caps delay at max delay', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('failed'));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 500,
      backoffMultiplier: 2,
      jitterFraction: 0,
    });
    promise.catch(() => {}); // Suppress unhandled rejection warning

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    // 4th attempt would have 800ms delay, but capped at 500ms
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('applies jitter to delays', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('failed'));

    const originalRandom = Math.random;
    let callCount = 0;
    Math.random = () => {
      callCount++;
      return callCount === 1 ? 0.5 : 0.7;
    };

    try {
      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        jitterFraction: 0.1,
      });
      promise.catch(() => {}); // Suppress unhandled rejection warning

      // First retry at 100ms + (100 * 0.1 * 0.5) = 105ms
      await vi.advanceTimersByTimeAsync(105);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry at 200ms + (200 * 0.1 * 0.7) = 214ms
      await vi.advanceTimersByTimeAsync(214);
      expect(fn).toHaveBeenCalledTimes(3);

      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow('failed');
    } finally {
      Math.random = originalRandom;
    }
  });

  it('respects shouldRetry predicate', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient error'))
      .mockRejectedValueOnce(new Error('permanent error'));

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      shouldRetry: (error) => !error.message.includes('permanent'),
    });
    promise.catch(() => {}); // Suppress unhandled rejection warning

    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('permanent error');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on non-Error values thrown', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce('string error')
      .mockResolvedValueOnce('success');

    const promise = retryWithBackoff(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry if shouldRetry returns false on first attempt', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('failed'));
    try {
      await retryWithBackoff(fn, {
        shouldRetry: () => false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toBe('failed');
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('handles successful promise without retries', async () => {
    const testValue = { data: 'test' };
    const fn = vi.fn().mockResolvedValue(testValue);

    const result = await retryWithBackoff(fn);

    expect(result).toBe(testValue);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('works with async functions that take time', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) {
        throw new Error('first attempt fails');
      }
      return 'delayed success';
    });

    const promise = retryWithBackoff(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('delayed success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
