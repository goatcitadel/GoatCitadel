import { describe, expect, it, vi } from "vitest";
import { StreamIdleTimeoutError, withStreamIdleWatchdog } from "./stream-idle-watchdog.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

async function* emitWithDelays<T>(items: T[], delayMs: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield item;
  }
}

describe("withStreamIdleWatchdog", () => {
  it("passes chunks through and re-arms between chunks", async () => {
    const chunks = await collect(withStreamIdleWatchdog(emitWithDelays(["a", "b", "c"], 30), { idleTimeoutMs: 200 }));
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("throws StreamIdleTimeoutError and aborts when the source hangs after emitting", async () => {
    const source = (async function* () {
      yield "a";
      await new Promise(() => {});
    })();
    const abort = vi.fn();
    await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 50, abort }))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("throws when the source never emits at all", async () => {
    const source = (async function* () {
      await new Promise(() => {});
      yield "unreachable"; // the promise above never settles
    })() as AsyncIterable<string>;
    await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 50 }))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
  });

  it("propagates source errors unchanged", async () => {
    const source = (async function* () {
      yield "a";
      throw new Error("boom");
    })();
    await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 1000 }))).rejects.toThrow("boom");
  });

  it("reports the configured idle bound through onTrip", async () => {
    const source = (async function* () {
      await new Promise(() => {});
      yield "unreachable"; // the promise above never settles
    })() as AsyncIterable<string>;
    const onTrip = vi.fn();
    await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 40, onTrip }))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
    expect(onTrip).toHaveBeenCalledWith(40);
  });

  it("marks the error with a stable machine-readable code", async () => {
    const source = (async function* () {
      await new Promise(() => {});
      yield "unreachable"; // the promise above never settles
    })() as AsyncIterable<string>;
    const failure = await collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 30 })).catch((error) => error);
    expect(failure).toBeInstanceOf(StreamIdleTimeoutError);
    expect((failure as StreamIdleTimeoutError).code).toBe("stream_idle_timeout");
  });
});
