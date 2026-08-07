import { ModelUsageDispatchPersistenceError, ModelUsageSettlementError } from "@goatcitadel/gateway-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";

describe("runBoundedUtilityModelCall", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts and drains the provider call before surfacing timeout", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const result = runBoundedUtilityModelCall({
      timeoutMs: 25,
      timeoutMessage: "utility timed out",
      start: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              queueMicrotask(() => reject(new Error("provider cancelled")));
            },
            { once: true },
          );
        }),
    });

    const expectation = expect(result).rejects.toThrow("utility timed out");
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(observedAbort).toBe(true);
  });

  it("allows timeout fallback when successful usage settlement finishes shortly after abort", async () => {
    vi.useFakeTimers();
    const result = runBoundedUtilityModelCall({
      timeoutMs: 25,
      timeoutMessage: "utility timed out",
      start: (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => resolve("settled"), 750);
            },
            { once: true },
          );
        }),
    }).catch((error) => error as Error);

    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(750);

    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("Error");
    expect(failure.message).toBe("utility timed out");
  });

  it.each([
    [
      "terminal settlement persistence",
      () => new ModelUsageSettlementError("usage-1", "cancelled", new Error("database offline")),
    ],
    [
      "pre-acceptance dispatch persistence",
      () => new ModelUsageDispatchPersistenceError("usage-1", "abandon_intent", new Error("database offline")),
    ],
    [
      "accepted dispatch uncertainty",
      () => ({ name: "ModelUsageDispatchUncertainError", message: "dispatch outcome uncertain" }),
    ],
  ])("surfaces %s instead of the timeout fallback", async (_label, createFault) => {
    vi.useFakeTimers();
    const accountingFault = createFault();
    const result = runBoundedUtilityModelCall({
      timeoutMs: 25,
      timeoutMessage: "utility timed out",
      start: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => queueMicrotask(() => reject(accountingFault)), { once: true });
        }),
    });

    const expectation = expect(result).rejects.toBe(accountingFault);
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it("preserves a delayed authoritative accounting failure during settlement grace", async () => {
    vi.useFakeTimers();
    const accountingFault = new ModelUsageSettlementError("usage-1", "cancelled", new Error("database offline"));
    const result = runBoundedUtilityModelCall({
      timeoutMs: 25,
      timeoutMessage: "utility timed out",
      start: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => reject(accountingFault), 750);
            },
            { once: true },
          );
        }),
    });

    const expectation = expect(result).rejects.toBe(accountingFault);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(750);
    await expectation;
  });

  it("stays bounded and blocks fallback when a utility provider ignores abort", async () => {
    vi.useFakeTimers();
    const result = runBoundedUtilityModelCall({
      timeoutMs: 20,
      timeoutMessage: "utility timed out",
      start: () => new Promise(() => undefined),
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(3_000);

    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ModelUsageDispatchUncertainError");
    expect((failure as Error).message).toContain("utility timed out");
  });
});
