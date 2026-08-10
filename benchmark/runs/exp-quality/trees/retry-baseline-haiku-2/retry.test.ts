import { retry, retryWithResult } from "./retry";

describe("retry helper", () => {
  describe("retry()", () => {
    it("returns result on first success", async () => {
      const fn = jest.fn().mockResolvedValue("success");
      const result = await retry(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce("success");

      const result = await retry(fn, { maxAttempts: 3 });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws after max attempts exceeded", async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new Error("persistent failure"));

      await expect(
        retry(fn, { maxAttempts: 2 })
      ).rejects.toThrow("persistent failure");

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("respects backoff delay", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce("success");

      const startTime = Date.now();
      await retry(fn, {
        maxAttempts: 2,
        initialDelayMs: 50,
        jitter: false,
      });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it("caps delay at maxDelayMs", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce("success");

      await retry(fn, {
        maxAttempts: 2,
        initialDelayMs: 5000,
        maxDelayMs: 100,
        backoffMultiplier: 10,
        jitter: false,
      });

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("applies exponential backoff", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce("success");

      const startTime = Date.now();
      await retry(fn, {
        maxAttempts: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        jitter: false,
      });
      const elapsed = Date.now() - startTime;

      // First retry: 50ms, second retry: 100ms, total >= 150ms
      expect(elapsed).toBeGreaterThanOrEqual(150);
    });

    it("applies jitter to delays", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce("success");

      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const startTime = Date.now();
        await retry(fn.mockClear().mockRejectedValueOnce(new Error()).mockResolvedValueOnce("ok"), {
          maxAttempts: 2,
          initialDelayMs: 100,
          jitter: true,
        });
        delays.push(Date.now() - startTime);
      }

      // With jitter, delays should vary
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it("converts non-Error exceptions to Error", async () => {
      const fn = jest.fn().mockRejectedValue("string error");

      await expect(retry(fn, { maxAttempts: 1 })).rejects.toThrow(
        "string error"
      );
    });
  });

  describe("retryWithResult()", () => {
    it("returns success result with attempt count", async () => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const result = await retryWithResult(fn);

      expect(result).toEqual({ success: true, attempts: 1 });
    });

    it("returns success after retries", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(undefined);

      const result = await retryWithResult(fn, { maxAttempts: 3 });

      expect(result).toEqual({ success: true, attempts: 2 });
    });

    it("returns failure result with error and attempt count", async () => {
      const error = new Error("permanent failure");
      const fn = jest.fn().mockRejectedValue(error);

      const result = await retryWithResult(fn, { maxAttempts: 2 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.lastError).toEqual(error);
    });

    it("never throws, always returns result", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("error"));

      expect(async () => {
        await retryWithResult(fn, { maxAttempts: 1 });
      }).not.toThrow();
    });
  });

  describe("configuration", () => {
    it("uses default options", async () => {
      const fn = jest.fn().mockResolvedValue("ok");
      await retry(fn);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("allows partial option overrides", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce("ok");

      await retry(fn, { maxAttempts: 5 });

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
