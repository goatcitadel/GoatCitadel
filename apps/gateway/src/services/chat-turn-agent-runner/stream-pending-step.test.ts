import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStreamPendingStep, normalizeToolActivityHeartbeatMs } from "./stream-pending-step.js";
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
describe("pending stream step", () => {
  it("ticks repeatedly then returns the same step to concurrent waiters", async () => {
    vi.useFakeTimers();
    const next = deferred<IteratorResult<string>>();
    const then = vi.spyOn(next.promise, "then");
    const step = createChatStreamPendingStep(next.promise);
    for (let i = 0; i < 3; i++) {
      const wait = step.wait(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await wait).toEqual({ kind: "tick" });
    }
    expect(then).toHaveBeenCalledTimes(1);
    const a = step.wait(10),
      b = step.wait(10);
    next.resolve({ done: false, value: "chunk" });
    expect(await a).toEqual({ kind: "step", step: { done: false, value: "chunk" } });
    expect(await b).toEqual(await a);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates rejection and cleans the waiter", async () => {
    vi.useFakeTimers();
    const next = deferred<IteratorResult<string>>();
    const step = createChatStreamPendingStep(next.promise);
    const wait = step.wait(10);
    const check = expect(wait).rejects.toThrow("provider failed");
    next.reject(new Error("provider failed"));
    await check;
    expect(vi.getTimerCount()).toBe(0);
    await expect(step.wait(10)).rejects.toThrow("provider failed");
  });
  it.each([true, false])("cancels an abort-ignorant next step; already aborted=%s", async (already) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (already) controller.abort();
    const next = deferred<IteratorResult<string>>();
    const wait = createChatStreamPendingStep(next.promise).wait(5000, controller.signal);
    const check = expect(wait).rejects.toMatchObject({ name: "AbortError" });
    if (!already) controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows canonical settlement during the cancellation grace turn", async () => {
    vi.useFakeTimers();
    const next = deferred<IteratorResult<string>>();
    const controller = new AbortController();
    const step = createChatStreamPendingStep(next.promise);
    const wait = step.wait(5000, controller.signal);
    controller.abort();
    next.resolve({ done: true, value: undefined });
    expect(await wait).toEqual({ kind: "step", step: { done: true, value: undefined } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("normalizes invalid heartbeat values without changing defaults", () => {
    expect(normalizeToolActivityHeartbeatMs(undefined)).toBe(5000);
    expect(normalizeToolActivityHeartbeatMs(NaN)).toBe(5000);
    expect(normalizeToolActivityHeartbeatMs(2)).toBe(10);
    expect(normalizeToolActivityHeartbeatMs(23.7)).toBe(23);
  });
});

it.each(["settle", "tick", "abort"] as const)("removes the abort listener and timers after %s", async (outcome) => {
  vi.useFakeTimers();
  const next = deferred<IteratorResult<string>>();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const wait = createChatStreamPendingStep(next.promise).wait(10, controller.signal);
  const checked = outcome === "abort" ? expect(wait).rejects.toMatchObject({ name: "AbortError" }) : wait;
  if (outcome === "settle") next.resolve({ done: false, value: "chunk" });
  if (outcome === "abort") controller.abort();
  await vi.advanceTimersByTimeAsync(outcome === "tick" ? 10 : 0);
  await checked;
  expect(add).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  expect(vi.getTimerCount()).toBe(0);
});
