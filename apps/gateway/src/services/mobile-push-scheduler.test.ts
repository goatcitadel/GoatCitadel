import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMobilePushDeliveryScheduler } from "./mobile-push-scheduler.js";

describe("mobile push delivery scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start at all without a provisioned provider credential", () => {
    const deliverDue = vi.fn(async () => ({ providerAvailable: false, attempted: 0, outcomes: [] }));
    const handle = startMobilePushDeliveryScheduler({
      service: { deliverDue },
      providerAvailable: () => false,
      isClosing: () => false,
      registerInflight: () => undefined,
      onError: () => undefined,
    });

    expect(handle).toBeUndefined();
    vi.advanceTimersByTime(10 * 60_000);
    expect(deliverDue).not.toHaveBeenCalled();
  });

  it("treats a throwing availability probe as unavailable", () => {
    const deliverDue = vi.fn(async () => ({ providerAvailable: false, attempted: 0, outcomes: [] }));
    const handle = startMobilePushDeliveryScheduler({
      service: { deliverDue },
      providerAvailable: () => {
        throw new Error("probe failed");
      },
      isClosing: () => false,
      registerInflight: () => undefined,
      onError: () => undefined,
    });
    expect(handle).toBeUndefined();
    expect(deliverDue).not.toHaveBeenCalled();
  });

  it("drains the outbox on the boot pass and recurring interval when credentialed, then stops cleanly", async () => {
    const deliverDue = vi.fn(async () => ({ providerAvailable: true, attempted: 0, outcomes: [] }));
    const inflight: Array<Promise<void>> = [];
    const handle = startMobilePushDeliveryScheduler({
      service: { deliverDue },
      providerAvailable: () => true,
      isClosing: () => false,
      registerInflight: (task) => inflight.push(task),
      onError: () => undefined,
      intervalMs: 15_000,
      bootDelayMs: 1_000,
    });

    expect(handle).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliverDue).toHaveBeenCalledTimes(1);
    expect(deliverDue).toHaveBeenCalledWith(25);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deliverDue).toHaveBeenCalledTimes(2);
    expect(inflight.length).toBe(2);

    handle!.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliverDue).toHaveBeenCalledTimes(2);
  });

  it("isolates tick failures through onError instead of crashing", async () => {
    const onError = vi.fn();
    const deliverDue = vi.fn(async () => {
      throw new Error("sweep failed");
    });
    const handle = startMobilePushDeliveryScheduler({
      service: { deliverDue },
      providerAvailable: () => true,
      isClosing: () => false,
      registerInflight: () => undefined,
      onError,
      intervalMs: 5_000,
      bootDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliverDue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "mobile push delivery scheduler");
    handle!.stop();
  });
});
