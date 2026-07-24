import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SharedHostDrainDisabledError,
  SharedHostLifecycleService,
  resolveSharedHostDrainTimeoutMs,
  resolveSharedHostLifecycleEnabled,
} from "./shared-host-lifecycle-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedHostLifecycleService", () => {
  it("keeps default local mode always available and refuses an unconfigured drain", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("shared-host evidence must not gate local mode");
    });
    const lifecycle = new SharedHostLifecycleService({ enabled: false, onEvent });
    lifecycle.markAccepting();

    const reservation = lifecycle.tryReserve("api", "local-request");
    expect(reservation.admitted).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({
      enabled: false,
      mode: "local_always_available",
      state: "accepting",
      admission: "open",
      activeCount: 0,
    });
    await expect(
      lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "test", actorId: "operator" }),
    ).rejects.toBeInstanceOf(SharedHostDrainDisabledError);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("closes admission synchronously before awaiting admitted work", async () => {
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const first = lifecycle.tryReserve("agent", "agent-1");
    expect(first.admitted).toBe(true);

    const draining = lifecycle.drain({ mode: "pause", timeoutMs: 100, reason: "scale_down", actorId: "ops" });
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", admission: "closed", activeCount: 1 });
    expect(lifecycle.tryReserve("api", "late-api")).toMatchObject({
      admitted: false,
      state: "draining",
    });
    if (first.admitted) first.reservation.release();

    await expect(draining).resolves.toMatchObject({ outcome: "quiesced", snapshot: { state: "quiesced" } });
  });

  it("keeps pause drains truthful on timeout and force-aborts outstanding reservations before closing", async () => {
    const transitions: string[] = [];
    const lifecycle = new SharedHostLifecycleService({
      enabled: true,
      onEvent: (event) => transitions.push(`${event.from}->${event.to}`),
    });
    lifecycle.markAccepting();
    const admitted = lifecycle.tryReserve("worker", "worker-1");
    if (!admitted.admitted) throw new Error("expected worker admission");
    const onAbort = vi.fn();
    admitted.reservation.signal.addEventListener("abort", onAbort);

    await expect(
      lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "pause", actorId: "ops" }),
    ).resolves.toMatchObject({ outcome: "timed_out", snapshot: { state: "draining", activeCount: 1 } });
    expect(onAbort).not.toHaveBeenCalled();

    await expect(
      lifecycle.drain({ mode: "force", timeoutMs: 10, reason: "force", actorId: "ops" }),
    ).resolves.toMatchObject({
      outcome: "closing",
      snapshot: {
        state: "closing",
        activeCount: 1,
        drain: { timedOut: true, forcedOutstandingCount: 1 },
      },
    });
    expect(onAbort).toHaveBeenCalledTimes(1);
    await lifecycle.flushSignals();
    expect(transitions).toContain("draining->closing");
    expect(transitions).not.toContain("draining->quiesced");
    expect(lifecycle.snapshot()).toMatchObject({ state: "closing", activeCount: 1 });
    admitted.reservation.release();
  });

  it("refuses to label active work quiesced outside the bounded force path", () => {
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const admitted = lifecycle.tryReserve("cron", "cron-1");
    expect(admitted.admitted).toBe(true);
    expect(() => lifecycle.markClosing()).toThrow(/bounded force drain/i);
    expect(lifecycle.snapshot()).toMatchObject({ state: "accepting", activeCount: 1 });
    if (admitted.admitted) admitted.reservation.release();
  });

  it("uses an explicit startup-abort branch without pretending the process accepted work", () => {
    const transitions: string[] = [];
    const lifecycle = new SharedHostLifecycleService({
      enabled: true,
      onEvent: (event) => transitions.push(`${event.from}->${event.to}`),
    });
    lifecycle.abortStartup();
    lifecycle.markClosed();
    expect(lifecycle.snapshot().state).toBe("closed");
    return lifecycle.flushSignals().then(() => {
      expect(transitions).toEqual(["starting->closing", "closing->closed"]);
    });
  });

  it("captures synchronous evidence sink failures and exposes them at the flush boundary", async () => {
    const lifecycle = new SharedHostLifecycleService({
      enabled: true,
      onEvent: () => {
        throw new Error("audit unavailable");
      },
    });
    expect(() => lifecycle.markAccepting()).not.toThrow();
    await expect(lifecycle.flushSignals()).rejects.toThrow(/evidence signals failed/i);
    expect(lifecycle.snapshot()).toMatchObject({
      state: "accepting",
      readiness: "degraded",
      evidence: { state: "degraded", failedCount: 1 },
    });
  });

  it("replays failed evidence with the original event id before restoring readiness", async () => {
    let fail = true;
    const delivered: string[] = [];
    const lifecycle = new SharedHostLifecycleService({
      enabled: true,
      onEvent: (event) => {
        if (fail) throw new Error("realtime unavailable");
        delivered.push(event.eventId);
      },
    });
    lifecycle.markAccepting();
    await expect(lifecycle.flushSignals()).rejects.toThrow(/evidence signals failed/i);
    fail = false;
    await lifecycle.replayFailedSignals();
    expect(delivered).toHaveLength(1);
    expect(lifecycle.snapshot()).toMatchObject({ readiness: "ready", evidence: { state: "healthy" } });
  });
});

describe("shared-host environment parsing", () => {
  it("requires explicit opt-in and bounds the drain budget", () => {
    expect(resolveSharedHostLifecycleEnabled({})).toBe(false);
    expect(resolveSharedHostLifecycleEnabled({ GOATCITADEL_SHARED_HOST_DRAIN_ENABLED: "true" })).toBe(true);
    expect(resolveSharedHostDrainTimeoutMs({ GOATCITADEL_SHARED_HOST_DRAIN_TIMEOUT_MS: "250" })).toBe(250);
    expect(() => resolveSharedHostDrainTimeoutMs({ GOATCITADEL_SHARED_HOST_DRAIN_TIMEOUT_MS: "0" })).toThrow(
      /timeoutMs/,
    );
  });
});
