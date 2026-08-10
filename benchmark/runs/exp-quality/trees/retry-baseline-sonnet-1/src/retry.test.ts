import { describe, expect, it, jest } from "@jest/globals";
import { computeDelay, retryDefault, retryWithBackoff, RetryAbortedError, RetryExhaustedError } from "./retry";

describe("retryDefault", () => {
  it("retries on 5xx status", () => {
    expect(retryDefault({ status: 500 })).toBe(true);
    expect(retryDefault({ status: 503 })).toBe(true);
  });

  it("retries on 429", () => {
    expect(retryDefault({ status: 429 })).toBe(true);
  });

  it("does not retry on other 4xx", () => {
    expect(retryDefault({ status: 400 })).toBe(false);
    expect(retryDefault({ status: 401 })).toBe(false);
    expect(retryDefault({ status: 404 })).toBe(false);
  });

  it("supports statusCode as an alias for status", () => {
    expect(retryDefault({ statusCode: 500 })).toBe(true);
    expect(retryDefault({ statusCode: 400 })).toBe(false);
  });

  it("retries known transient network error codes", () => {
    expect(retryDefault({ code: "ECONNRESET" })).toBe(true);
    expect(retryDefault({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("retries opaque errors with no status/code by default", () => {
    expect(retryDefault(new Error("boom"))).toBe(true);
  });
});

describe("computeDelay", () => {
  it("stays within [0, baseDelayMs] on the first attempt", () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(1, { baseDelayMs: 100, maxDelayMs: 10_000, factor: 2 });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });

  it("grows the cap exponentially with attempt number", () => {
    const spy = jest.spyOn(Math, "random").mockReturnValue(1);
    expect(computeDelay(1, { baseDelayMs: 100, maxDelayMs: 10_000, factor: 2 })).toBe(100);
    expect(computeDelay(2, { baseDelayMs: 100, maxDelayMs: 10_000, factor: 2 })).toBe(200);
    expect(computeDelay(3, { baseDelayMs: 100, maxDelayMs: 10_000, factor: 2 })).toBe(400);
    spy.mockRestore();
  });

  it("never exceeds maxDelayMs", () => {
    const spy = jest.spyOn(Math, "random").mockReturnValue(1);
    expect(computeDelay(10, { baseDelayMs: 100, maxDelayMs: 1000, factor: 2 })).toBe(1000);
    spy.mockRestore();
  });
});

describe("retryWithBackoff", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and eventually succeeds", async () => {
    const fn = jest
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes the attempt number to fn", async () => {
    const fn = jest
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue("ok");

    await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(fn).toHaveBeenNthCalledWith(1, 1);
    expect(fn).toHaveBeenNthCalledWith(2, 2);
  });

  it("stops immediately on a non-retryable error", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockRejectedValue({ status: 400 });

    await expect(retryWithBackoff(fn, { baseDelayMs: 1, maxAttempts: 5 })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and wraps the last error", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockRejectedValue({ status: 503, message: "down" });

    let caught: unknown;
    try {
      await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }

    expect(fn).toHaveBeenCalledTimes(3);
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(3);
    expect((caught as RetryExhaustedError).lastError).toEqual({ status: 503, message: "down" });
  });

  it("honors a custom shouldRetry predicate", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockRejectedValue(new Error("nope"));
    const shouldRetry = jest.fn<(error: unknown, attempt: number) => boolean>().mockReturnValue(false);

    await expect(retryWithBackoff(fn, { baseDelayMs: 1, shouldRetry })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it("calls onRetry with the error, attempt, and computed delay", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockRejectedValueOnce({ status: 500 }).mockResolvedValue("ok");
    const onRetry = jest.fn<(error: unknown, attempt: number, delayMs: number) => void>();

    await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 2, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ status: 500 }, 1, expect.any(Number));
  });

  it("rejects with RetryAbortedError if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("cancelled by caller");
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockResolvedValue("ok");

    await expect(retryWithBackoff(fn, { signal: controller.signal })).rejects.toThrow(RetryAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts mid-backoff when the signal fires during the delay", async () => {
    const controller = new AbortController();
    const fn = jest.fn<(attempt: number) => Promise<string>>().mockRejectedValue({ status: 500 });

    const promise = retryWithBackoff(fn, { baseDelayMs: 1000, maxDelayMs: 1000, signal: controller.signal });
    setTimeout(() => controller.abort("shutting down"), 10);

    await expect(promise).rejects.toThrow(RetryAbortedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects if maxAttempts < 1", async () => {
    const fn = jest.fn<(attempt: number) => Promise<string>>();
    await expect(retryWithBackoff(fn, { maxAttempts: 0 })).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });
});
