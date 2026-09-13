import { afterEach, describe, expect, it, vi } from "vitest";
import { withChannelProgressHeartbeat } from "./channel-progress-heartbeat.js";
afterEach(() => vi.useRealTimers());
describe("channel progress heartbeat", () => {
  it("keeps long work visible, never overlaps pulses, and aborts a pulse on completion", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    let release!: () => void;
    let active = 0;
    let maximum = 0;
    const pulse = vi.fn((signal: AbortSignal) => {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise<void>((resolve) => {
        release = () => {
          signal.removeEventListener("abort", release);
          active--;
          resolve();
        };
        signal.addEventListener("abort", release, { once: true });
      });
    });
    const task = withChannelProgressHeartbeat(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      pulse,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pulse).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pulse).toHaveBeenCalledTimes(2);
    finish("completed");
    expect(await task).toBe("completed");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pulse).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
  });
  it("stops on lost ownership and preserves the task result", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pulse = vi.fn(async () => {
      throw new Error("claim lost");
    });
    const task = withChannelProgressHeartbeat(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      pulse,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    finish();
    await task;
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
