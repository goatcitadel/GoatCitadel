import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  ChannelStreamAuthError,
  ChannelStreamRuntimeService,
  type ChannelStreamAdapter,
  type ChannelStreamEvent,
  type ChannelStreamRunContext,
} from "./channel-stream-runtime-service.js";

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: "r1",
    catalogId: "channel.fake",
    kind: "channel",
    key: "fake",
    label: "Fake",
    enabled: true,
    status: "connected",
    config: { inbound: true },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

function event(id: string): ChannelStreamEvent {
  return {
    idempotencyKey: `fake:conn-1:${id}`,
    eventType: "message",
    message: { eventId: id, account: "a", actorId: "u", content: "hi" },
  };
}

interface Run {
  ctx: ChannelStreamRunContext;
  resolve(): void;
  reject(error: unknown): void;
}

function setup(options: { dispatch?: () => Promise<unknown>; idleTimeoutMs?: number } = {}) {
  const runs: Run[] = [];
  const adapter: ChannelStreamAdapter = {
    channelKey: "fake",
    isInboundEnabled: (c) => c.config.inbound === true,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    run(ctx) {
      return new Promise<void>((resolve, reject) => {
        runs.push({ ctx, resolve: () => resolve(), reject });
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
  let current: IntegrationConnection[] = [connection()];
  const delays: number[] = [];
  const dispatch = vi.fn(async (..._args: unknown[]) => (options.dispatch ? options.dispatch() : { ok: true }));
  const service = new ChannelStreamRuntimeService({
    listConnections: async () => current,
    adapters: [adapter],
    dispatch: dispatch as never,
    recordDevDiagnostic: vi.fn(),
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return {
    service,
    runs,
    delays,
    dispatch,
    setConnections(next: IntegrationConnection[]) {
      current = next;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function nextRun(runs: Run[], count: number): Promise<Run> {
  for (let i = 0; i < 50 && runs.length < count; i += 1) await flush();
  const run = runs[count - 1];
  if (!run) throw new Error(`run ${count} never started`);
  return run;
}

describe("ChannelStreamRuntimeService", () => {
  it("starts one runner per enabled opted-in connection and does not duplicate on unchanged sync", async () => {
    const h = setup();
    await h.service.sync();
    await nextRun(h.runs, 1);
    await h.service.sync();
    await flush();
    expect(h.service.activeRunnerCount).toBe(1);
    expect(h.runs).toHaveLength(1);
    await h.service.close();
  });

  it("skips disabled, disconnected and non-opted-in connections", async () => {
    const h = setup();
    h.setConnections([
      connection({ connectionId: "a", enabled: false }),
      connection({ connectionId: "b", status: "disconnected" }),
      connection({ connectionId: "c", config: {} }),
    ]);
    await h.service.sync();
    await flush();
    expect(h.service.activeRunnerCount).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("aborts a runner when its connection is disabled", async () => {
    const h = setup();
    await h.service.sync();
    const run = await nextRun(h.runs, 1);
    h.setConnections([connection({ enabled: false, updatedAt: "2026-10-16T01:00:00.000Z" })]);
    await h.service.sync();
    await flush();
    expect(run.ctx.signal.aborted).toBe(true);
    expect(h.service.getStatus("conn-1")?.stoppedReason).toBe("disabled");
    expect(h.service.activeRunnerCount).toBe(0);
  });

  it("reconnects with doubling backoff capped at maxMs and records status", async () => {
    const h = setup();
    await h.service.sync();
    for (let i = 1; i <= 9; i += 1) {
      const run = await nextRun(h.runs, i);
      run.reject(new Error(`boom ${i}`));
      await flush();
    }
    await nextRun(h.runs, 10);
    expect(h.delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    const status = h.service.getStatus("conn-1");
    expect(status?.lastError).toContain("boom 9");
    expect(status?.lastReconnectAt).toBeTruthy();
    await h.service.close();
  });

  it("treats a clean server end as a reconnect", async () => {
    const h = setup();
    await h.service.sync();
    (await nextRun(h.runs, 1)).resolve();
    await flush();
    await nextRun(h.runs, 2);
    expect(h.delays).toEqual([1000]);
    await h.service.close();
  });

  it("resets backoff after markReady and a successful emit", async () => {
    const h = setup();
    await h.service.sync();
    (await nextRun(h.runs, 1)).reject(new Error("x"));
    await flush();
    (await nextRun(h.runs, 2)).reject(new Error("y"));
    await flush();
    const third = await nextRun(h.runs, 3);
    third.ctx.markReady();
    expect(h.service.getStatus("conn-1")?.ready).toBe(true);
    await third.ctx.emit(event("e1"), "c1");
    third.reject(new Error("z"));
    await flush();
    await nextRun(h.runs, 4);
    expect(h.delays).toEqual([1000, 2000, 1000]);
    await h.service.close();
  });

  it("stops on ChannelStreamAuthError until the connection changes", async () => {
    const h = setup();
    await h.service.sync();
    (await nextRun(h.runs, 1)).reject(new ChannelStreamAuthError("401"));
    await flush();
    expect(h.service.getStatus("conn-1")?.stoppedReason).toBe("auth_failed");
    expect(h.runs).toHaveLength(1);
    await h.service.sync();
    await flush();
    expect(h.runs).toHaveLength(1);
    h.setConnections([connection({ updatedAt: "2026-10-16T02:00:00.000Z" })]);
    await h.service.sync();
    await nextRun(h.runs, 2);
    expect(h.runs).toHaveLength(2);
    await h.service.close();
  });

  it("restarts when only the storage revision changes", async () => {
    const h = setup();
    await h.service.sync();
    const first = await nextRun(h.runs, 1);
    h.setConnections([connection({ revision: "r2" })]);
    await h.service.sync();
    await nextRun(h.runs, 2);
    expect(first.ctx.signal.aborted).toBe(true);
    await h.service.close();
  });

  it("dispatches emitted events and advances the cursor only after acceptance", async () => {
    const h = setup();
    await h.service.sync();
    const first = await nextRun(h.runs, 1);
    expect(first.ctx.cursor).toBeUndefined();
    await first.ctx.emit(event("e1"), "cursor-1");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "fake:conn-1:e1" });
    expect(h.service.getStatus("conn-1")?.lastInboundAt).toBeTruthy();
    first.reject(new Error("drop"));
    await flush();
    const second = await nextRun(h.runs, 2);
    expect(second.ctx.cursor).toBe("cursor-1");
    await h.service.close();
  });

  it("propagates dispatch failure to the adapter without advancing the cursor", async () => {
    let fail = false;
    const h = setup({
      dispatch: async () => {
        if (fail) throw new Error("store down");
        return {};
      },
    });
    await h.service.sync();
    const first = await nextRun(h.runs, 1);
    await first.ctx.emit(event("e1"), "c1");
    fail = true;
    await expect(first.ctx.emit(event("e2"), "c2")).rejects.toThrow("store down");
    expect(h.service.getStatus("conn-1")?.lastError).toContain("store down");
    first.reject(new Error("store down"));
    await flush();
    const second = await nextRun(h.runs, 2);
    expect(second.ctx.cursor).toBe("c1");
    await h.service.close();
  });

  it("handle runs adapter work with emit's bookkeeping", async () => {
    let fail = true;
    const h = setup({
      dispatch: async () => {
        if (fail) throw new Error("store down");
        return {};
      },
    });
    await h.service.sync();
    const first = await nextRun(h.runs, 1);
    await expect(first.ctx.emit(event("e1"), "c1")).rejects.toThrow("store down");
    expect(h.service.getStatus("conn-1")?.lastError).toContain("store down");
    expect(h.service.getStatus("conn-1")?.lastInboundAt).toBeUndefined();
    fail = false;

    const work = vi.fn(async () => "handled");
    await first.ctx.handle(work, "c2");

    expect(work).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.service.getStatus("conn-1")?.lastInboundAt).toBeTruthy();
    expect(h.service.getStatus("conn-1")).not.toHaveProperty("lastError");
    expect(first.ctx.cursor).toBe("c2");

    await expect(
      first.ctx.handle(async () => {
        throw new Error("handler down");
      }, "c3"),
    ).rejects.toThrow("handler down");
    expect(h.service.getStatus("conn-1")?.lastError).toContain("handler down");
    expect(first.ctx.cursor).toBe("c2");

    first.reject(new Error("drop"));
    await flush();
    const second = await nextRun(h.runs, 2);
    expect(second.ctx.cursor).toBe("c2");
    await h.service.close();
    await expect(second.ctx.handle(work)).rejects.toThrow("Channel stream session is closed.");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("close aborts runners, awaits settlement and blocks later sync", async () => {
    const h = setup();
    await h.service.sync();
    const run = await nextRun(h.runs, 1);
    await h.service.close();
    expect(run.ctx.signal.aborted).toBe(true);
    expect(h.service.activeRunnerCount).toBe(0);
    await h.service.sync();
    await flush();
    expect(h.runs).toHaveLength(1);
  });
});

describe("ChannelStreamRuntimeService liveness and error recovery", () => {
  it("aborts and reconnects a session idle past idleTimeoutMs; touch keeps it alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const h = setup({ idleTimeoutMs: 1_000 });
      await h.service.sync();
      const first = await nextRun(h.runs, 1);
      first.ctx.markReady();
      vi.advanceTimersByTime(800);
      first.ctx.touch();
      vi.advanceTimersByTime(800);
      expect(first.ctx.signal.aborted).toBe(false);
      vi.advanceTimersByTime(300);
      expect(first.ctx.signal.aborted).toBe(true);
      const second = await nextRun(h.runs, 2);
      expect(h.service.getStatus("conn-1")).toMatchObject({ ready: false, lastError: "stream idle timeout" });
      expect(h.service.getStatus("conn-1")?.stoppedReason).toBeUndefined();
      second.ctx.markReady();
      const recovered = h.service.getStatus("conn-1");
      expect(recovered?.ready).toBe(true);
      expect(recovered).not.toHaveProperty("lastError");
      await h.service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no watchdog when the adapter declares no idleTimeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const h = setup();
      await h.service.sync();
      const first = await nextRun(h.runs, 1);
      vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
      expect(first.ctx.signal.aborted).toBe(false);
      await h.service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a stale lastError after the next successful emit", async () => {
    let fail = true;
    const h = setup({
      dispatch: async () => {
        if (fail) throw new Error("store down");
        return {};
      },
    });
    await h.service.sync();
    const first = await nextRun(h.runs, 1);
    await expect(first.ctx.emit(event("e1"), "c1")).rejects.toThrow("store down");
    expect(h.service.getStatus("conn-1")?.lastError).toContain("store down");
    fail = false;
    await first.ctx.emit(event("e2"), "c2");
    expect(h.service.getStatus("conn-1")).not.toHaveProperty("lastError");
    await h.service.close();
  });
});

describe("ChannelStreamRuntimeService supersession and resilience", () => {
  function lateSettlingHarness() {
    const started: Array<{ ctx: ChannelStreamRunContext; settle(): void }> = [];
    const adapter: ChannelStreamAdapter = {
      channelKey: "fake",
      isInboundEnabled: () => true,
      run: (ctx) =>
        new Promise<void>((resolve) => {
          started.push({ ctx, settle: () => resolve() });
        }),
    };
    let current = [connection()];
    const service = new ChannelStreamRuntimeService({
      listConnections: async () => current,
      adapters: [adapter],
      dispatch: vi.fn(async () => ({})),
      recordDevDiagnostic: vi.fn(),
      sleep: async () => undefined,
    });
    return { service, started, setConnections: (next: IntegrationConnection[]) => (current = next) };
  }

  it("prefixes adapter diagnostics once and passes the level through (default info)", async () => {
    const recordDevDiagnostic = vi.fn();
    let captured: ChannelStreamRunContext | undefined;
    const adapter: ChannelStreamAdapter = {
      channelKey: "fake",
      isInboundEnabled: () => true,
      run: (ctx) =>
        new Promise<void>(() => {
          captured = ctx;
        }),
    };
    const service = new ChannelStreamRuntimeService({
      listConnections: async () => [connection()],
      adapters: [adapter],
      dispatch: vi.fn(async () => ({})),
      recordDevDiagnostic,
      sleep: async () => undefined,
    });
    await service.sync();
    await flush();
    captured!.diagnostic("bare_name", "info msg");
    captured!.diagnostic("warn_name", "warn msg", { n: 1 }, "warn");
    const calls = recordDevDiagnostic.mock.calls.map((c) => c[0] as { level: string; event: string });
    expect(calls).toContainEqual(expect.objectContaining({ level: "info", event: "fake.stream.bare_name" }));
    expect(calls).toContainEqual(expect.objectContaining({ level: "warn", event: "fake.stream.warn_name" }));
    void service.close();
  });

  it("does not start the replacement session until the superseded one settles", async () => {
    const h = lateSettlingHarness();
    await h.service.sync();
    await flush();
    expect(h.started).toHaveLength(1);
    h.setConnections([connection({ revision: "r2" })]);
    await h.service.sync();
    await flush();
    expect(h.started[0]!.ctx.signal.aborted).toBe(true);
    expect(h.started).toHaveLength(1);
    h.started[0]!.settle();
    await flush();
    expect(h.started).toHaveLength(2);
    const closing = h.service.close();
    await flush();
    expect(h.started[1]!.ctx.signal.aborted).toBe(true);
    h.started[1]!.settle();
    await closing;
  });

  it("close awaits a retiring runner that was removed", async () => {
    const h = lateSettlingHarness();
    await h.service.sync();
    await flush();
    h.setConnections([connection({ enabled: false })]);
    await h.service.sync();
    let closed = false;
    const closing = h.service.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    h.started[0]!.settle();
    await closing;
    expect(closed).toBe(true);
  });

  it("survives a throwing diagnostics sink and a throwing isInboundEnabled", async () => {
    const runs: ChannelStreamRunContext[] = [];
    const good: ChannelStreamAdapter = {
      channelKey: "fake",
      isInboundEnabled: (c) => {
        if (c.connectionId === "bad") throw new Error("boom");
        return true;
      },
      run: (ctx) =>
        new Promise<void>((_resolve, reject) => {
          runs.push(ctx);
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const service = new ChannelStreamRuntimeService({
      listConnections: async () => [connection({ connectionId: "bad" }), connection({ connectionId: "ok" })],
      adapters: [good],
      dispatch: vi.fn(async () => ({})),
      recordDevDiagnostic: () => {
        throw new Error("sink down");
      },
      sleep: async () => undefined,
    });
    await service.sync();
    await flush();
    expect(runs).toHaveLength(1);
    expect(service.activeRunnerCount).toBe(1);
    await expect(service.close()).resolves.toBeUndefined();
  });
});
