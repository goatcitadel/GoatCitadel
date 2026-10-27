import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForHi } from "./listen-for-hi";
import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("listenForHi", () => {
  it("asks once every poll interval, starting after the first", async () => {
    const ask = vi.fn(async () => undefined);
    const stop = listenForHi(ask, vi.fn());
    await vi.advanceTimersByTimeAsync(SAY_HI_POLL_MS - 1);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAY_HI_POLL_MS * 2);
    expect(ask).toHaveBeenCalledTimes(3);
    stop();
  });

  it("waits for the last question before asking another", async () => {
    let answer!: () => void;
    const ask = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    const stop = listenForHi(ask, vi.fn());
    await vi.advanceTimersByTimeAsync(SAY_HI_POLL_MS * 4);
    expect(ask).toHaveBeenCalledTimes(1);
    answer();
    await vi.advanceTimersByTimeAsync(SAY_HI_POLL_MS);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops asking, and never expires, once stopped", async () => {
    const ask = vi.fn(async () => undefined);
    const onExpired = vi.fn();
    const stop = listenForHi(ask, onExpired);
    await vi.advanceTimersByTimeAsync(SAY_HI_POLL_MS);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SETUP_CODE_TTL_MS);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("expires once, when the code's time is up, and stops asking", async () => {
    const ask = vi.fn(async () => undefined);
    const onExpired = vi.fn();
    listenForHi(ask, onExpired);
    await vi.advanceTimersByTimeAsync(SETUP_CODE_TTL_MS - 1);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const asked = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SETUP_CODE_TTL_MS);
    expect(ask).toHaveBeenCalledTimes(asked);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("can be stopped twice", () => {
    const stop = listenForHi(async () => undefined, vi.fn());
    stop();
    expect(() => stop()).not.toThrow();
  });
});
