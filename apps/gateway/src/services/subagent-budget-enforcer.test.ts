import { describe, expect, it } from "vitest";
import { computeChildDepth, enforceMaxDepth, runWithChildTimeout } from "./subagent-budget-enforcer.js";

describe("computeChildDepth", () => {
  it("returns 1 when no parent depth is provided", () => {
    expect(computeChildDepth(undefined)).toBe(1);
  });
  it("returns parentDepth + 1", () => {
    expect(computeChildDepth(3)).toBe(4);
  });
});

describe("enforceMaxDepth", () => {
  it("returns nothing when depth is within budget", () => {
    expect(() => enforceMaxDepth({ depth: 2, maxDepth: 4 })).not.toThrow();
  });
  it("throws max_depth_exceeded when depth equals or exceeds maxDepth", () => {
    expect(() => enforceMaxDepth({ depth: 4, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
    expect(() => enforceMaxDepth({ depth: 5, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
  });
});

describe("runWithChildTimeout", () => {
  it("returns the operation result when it resolves before the timeout", async () => {
    const result = await runWithChildTimeout({
      timeoutSeconds: 1,
      run: async () => "ok",
    });
    expect(result).toBe("ok");
  });
  it("does not start a timeout timer when timeoutSeconds is non-positive", async () => {
    const result = await runWithChildTimeout({
      timeoutSeconds: 0,
      run: async () => "unbounded",
    });
    expect(result).toBe("unbounded");
  });
  it("rejects with timeout_exceeded when the operation runs past the timeout", async () => {
    await expect(
      runWithChildTimeout({
        timeoutSeconds: 0.05,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "late";
        },
      }),
    ).rejects.toThrowError(/timeout_exceeded/);
  });
  it("reports late child completion after timeout without changing the timeout result", async () => {
    const lateEvents: unknown[] = [];
    let resolveRun: (value: string) => void = () => undefined;
    const result = runWithChildTimeout({
      timeoutSeconds: 0.01,
      run: async () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
      onLateSettle: (event) => {
        lateEvents.push(event);
      },
    });

    await expect(result).rejects.toThrowError(/timeout_exceeded/);
    resolveRun("late success");
    await flushSettledPromises();

    expect(lateEvents).toEqual([
      expect.objectContaining({
        status: "completed",
        value: "late success",
        elapsedMs: expect.any(Number),
      }),
    ]);
  });
  it("reports late child failure after timeout without replacing the timeout error", async () => {
    const lateEvents: unknown[] = [];
    let rejectRun: (error: Error) => void = () => undefined;
    const result = runWithChildTimeout({
      timeoutSeconds: 0.01,
      run: async () =>
        new Promise<string>((_resolve, reject) => {
          rejectRun = reject;
        }),
      onLateSettle: (event) => {
        lateEvents.push(event);
      },
    });

    await expect(result).rejects.toThrowError(/timeout_exceeded/);
    rejectRun(new Error("late child crash"));
    await flushSettledPromises();

    expect(lateEvents).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ message: "late child crash" }),
        elapsedMs: expect.any(Number),
      }),
    ]);
  });
});

async function flushSettledPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
