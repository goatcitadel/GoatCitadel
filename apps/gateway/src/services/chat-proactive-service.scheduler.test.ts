import { describe, expect, it, vi } from "vitest";

vi.mock("@goatcitadel/storage", () => ({
  DEFAULT_SESSION_AUTONOMY_PREFS: {
    proactiveMode: "auto_safe",
    maxActionsPerHour: 0,
    maxActionsPerTurn: 0,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
  },
}));

import {
  ChatProactiveService,
  type ChatProactiveServiceCallbacks,
  type ChatProactiveServiceContext,
} from "./chat-proactive-service.js";

describe("chat-proactive-service scheduler fanout", () => {
  it("dispatches independent sessions in parallel via worker pool — one slow session does not starve later sessions", async () => {
    const trigger = vi.fn();
    const triggerOrder: string[] = [];
    let activeWorkers = 0;
    let peakConcurrency = 0;

    const sessions = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `s${i}`,
      lastActivityAt: new Date(Date.now() - 600_000).toISOString(),
    }));

    const callbacks: Partial<ChatProactiveServiceCallbacks> = {
      listChatSessions: () => sessions,
      hasRunningTurn: () => false,
      getSessionIdleSeconds: () => 600,
      detectDelegationRoles: () => [],
      requestDurableRunProcessing: () => undefined,
      backgroundTasks: new Set(),
      closing: false,
    };

    // Make session s0 slow so we can detect that s1..s3 do NOT wait for it.
    trigger.mockImplementation(async (sessionId: string) => {
      triggerOrder.push(`start:${sessionId}`);
      activeWorkers += 1;
      peakConcurrency = Math.max(peakConcurrency, activeWorkers);
      const delay = sessionId === "s0" ? 500 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
      activeWorkers -= 1;
      triggerOrder.push(`end:${sessionId}`);
    });

    const ctx = {
      storage: {
        sessionAutonomyPrefs: { listBySessionIds: () => new Map() },
      },
      publishRealtime: () => undefined,
      isFeatureEnabled: (flag: string) => flag === "durableKernelV1Enabled",
    } as unknown as ChatProactiveServiceContext;

    const service = new ChatProactiveService(ctx, callbacks as ChatProactiveServiceCallbacks);

    // Inject a test trigger; replace internal method via cast.
    (service as unknown as { triggerChatSessionProactive: typeof trigger }).triggerChatSessionProactive = trigger;

    await (service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(peakConcurrency).toBeGreaterThan(1);
    // s1 should start before s0 ends — proves parallelism.
    const s0End = triggerOrder.indexOf("end:s0");
    const s1Start = triggerOrder.indexOf("start:s1");
    expect(s1Start).toBeLessThan(s0End);
  });

  it("scoped busy check — agent A's running turn does NOT block agent B's tick", async () => {
    const runningSessions = new Set<string>(["sA"]);
    const triggered: string[] = [];

    const sessions = [
      { sessionId: "sA", lastActivityAt: new Date(Date.now() - 600_000).toISOString() },
      { sessionId: "sB", lastActivityAt: new Date(Date.now() - 600_000).toISOString() },
    ];

    const callbacks: Partial<ChatProactiveServiceCallbacks> = {
      listChatSessions: () => sessions,
      hasRunningTurn: (sessionId: string) => runningSessions.has(sessionId),
      getSessionIdleSeconds: () => 600,
      detectDelegationRoles: () => [],
      requestDurableRunProcessing: () => undefined,
      backgroundTasks: new Set(),
      closing: false,
    };

    const trigger = vi.fn();
    trigger.mockImplementation(async (sessionId: string) => {
      triggered.push(sessionId);
    });

    const ctx = {
      storage: {
        sessionAutonomyPrefs: { listBySessionIds: () => new Map() },
      },
      publishRealtime: () => undefined,
      isFeatureEnabled: (flag: string) => flag === "durableKernelV1Enabled",
    } as unknown as ChatProactiveServiceContext;

    const service = new ChatProactiveService(ctx, callbacks as ChatProactiveServiceCallbacks);

    (service as unknown as { triggerChatSessionProactive: typeof trigger }).triggerChatSessionProactive = trigger;
    await (service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    // Both sessions are dispatched at the scheduler level; the per-session busy
    // check happens inside triggerChatSessionProactive (at line 1423), and the
    // scheduler tick should never gate B on A's busy state.
    expect(triggered).toContain("sB");
    // Equally important: the scheduler also dispatches sA — the busy check
    // happens inside the trigger (which we've stubbed), not in the scheduler.
    expect(triggered).toContain("sA");
  });
});
