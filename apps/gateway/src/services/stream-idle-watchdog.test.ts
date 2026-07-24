import { describe, expect, it, vi } from "vitest";
import { ModelUsageDispatchPersistenceError, ModelUsageSettlementError } from "@goatcitadel/gateway-core";
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
    let releaseHang: (() => void) | undefined;
    const source = (async function* () {
      yield "a";
      await new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
    })();
    const abort = vi.fn(() => releaseHang?.());
    await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 50, abort }))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ModelUsageSettlementError("usage-1", "cancelled", new Error("database offline")),
    new ModelUsageDispatchPersistenceError("usage-1", "mark_dispatch_unknown", new Error("database offline")),
    Object.assign(new Error("dispatch outcome uncertain"), { name: "ModelUsageDispatchUncertainError" }),
  ])("drains an aborted idle read and surfaces authoritative accounting fault %s", async (accountingError) => {
    let rejectRead: ((error: unknown) => void) | undefined;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((_resolve, reject) => {
              rejectRead = reject;
            }),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };

    await expect(
      collect(
        withStreamIdleWatchdog(source, {
          idleTimeoutMs: 20,
          abort: () => rejectRead?.(accountingError),
        }),
      ),
    ).rejects.toBe(accountingError);
  });

  it("stays bounded and blocks redispatch when the provider ignores abort", async () => {
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: () => new Promise<IteratorResult<string>>(() => undefined),
        };
      },
    };

    const result = await Promise.race([
      collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 20, abort: () => undefined })).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve("watchdog-hung"), 250)),
    ]);

    expect(result).toBeInstanceOf(StreamIdleTimeoutError);
    expect((result as Error).name).toBe("ModelUsageDispatchUncertainError");
    expect((result as StreamIdleTimeoutError).code).toBe("stream_idle_timeout");
  });

  it.each([
    new ModelUsageSettlementError("usage-2", "cancelled", new Error("database offline")),
    new ModelUsageDispatchPersistenceError("usage-2", "abandon_intent", new Error("database offline")),
  ])("surfaces authoritative accounting fault %s from consumer cleanup", async (accountingError) => {
    let emitted = false;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: "a" };
          },
          return: async () => {
            throw accountingError;
          },
        };
      },
    };
    const wrapped = withStreamIdleWatchdog(source, { idleTimeoutMs: 1_000 });
    await expect(wrapped.next()).resolves.toEqual({ done: false, value: "a" });
    await expect(wrapped.return(undefined)).rejects.toBe(accountingError);
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
