import { afterEach, describe, expect, it, vi } from "vitest";
import { wait } from "./wait.js";

describe("wait", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(wait(1000, controller.signal)).resolves.toBeUndefined();
  });

  it("does not leak abort listeners when timers resolve normally", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    // Mirrors the live-tail poll calling wait() repeatedly on one request signal.
    const pending = Promise.all([
      wait(200, controller.signal),
      wait(200, controller.signal),
      wait(200, controller.signal),
    ]);
    vi.advanceTimersByTime(200);
    await pending;

    // Every abort listener registered must be removed once its timer fires;
    // otherwise listeners accumulate on the long-lived request signal.
    expect(addSpy).toHaveBeenCalledTimes(3);
    expect(removeSpy).toHaveBeenCalledTimes(3);
  });

  it("clears the timer and resolves when aborted before the delay elapses", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = wait(1000, controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });
});
