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

  it("stays bounded and blocks fallback when a utility provider ignores abort", async () => {
    const result = runBoundedUtilityModelCall({
      timeoutMs: 20,
      timeoutMessage: "utility timed out",
      start: () => new Promise(() => undefined),
    }).catch((error) => error);

    const failure = await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve("utility-helper-hung"), 250)),
    ]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ModelUsageDispatchUncertainError");
    expect((failure as Error).message).toContain("utility timed out");
  });
});
