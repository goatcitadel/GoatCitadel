import { describe, expect, it, vi } from "vitest";
import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import {
  DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS,
  getHeartbeatIntervalRemainingSeconds,
  HEARTBEAT_SYSTEM_PROMPT,
  runHeartbeatTick,
  type HeartbeatSessionRef,
  type HeartbeatTickDeps,
} from "./heartbeat-service.js";

function prefs(overrides: Partial<SessionAutonomyPrefsRecord> = {}): SessionAutonomyPrefsRecord {
  return {
    sessionId: "session-1",
    proactiveMode: "off",
    maxActionsPerHour: 6,
    maxActionsPerTurn: 2,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 3600,
    activeHours: { start: 8, end: 22 },
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  sessions?: HeartbeatSessionRef[];
  autonomyEnabled?: boolean;
  prefsBySession?: Record<string, SessionAutonomyPrefsRecord>;
  eligibleBySession?: Record<string, boolean>;
  idleBySession?: Record<string, number>;
  runningBySession?: Record<string, boolean>;
  enqueue?: (input: { sessionId: string; prompt: string }) => boolean | Promise<boolean>;
  /** Local-noon clock so the default active-hours window (08–22) passes. */
  now?: Date;
  idleFloorSeconds?: number;
}

const IDLE_OK = DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS + 60;

function createHarness(options: HarnessOptions = {}) {
  const enqueueHeartbeatTurn = vi.fn(options.enqueue ?? (() => true));
  const deps: HeartbeatTickDeps = {
    isAutonomyEnabled: () => options.autonomyEnabled ?? true,
    listSessions: () => options.sessions ?? [session("s1")],
    getSessionAutonomyPrefs: (sessionId) => options.prefsBySession?.[sessionId] ?? prefs({ sessionId }),
    isHeartbeatEligibleSession: (sessionId) => options.eligibleBySession?.[sessionId] ?? true,
    getSessionIdleSeconds: (sessionId) => options.idleBySession?.[sessionId] ?? IDLE_OK,
    hasRunningTurn: (sessionId) => options.runningBySession?.[sessionId] ?? false,
    enqueueHeartbeatTurn,
    now: () => options.now ?? makeLocalNoon(),
    ...(options.idleFloorSeconds !== undefined ? { idleFloorSeconds: options.idleFloorSeconds } : {}),
  };
  return { deps, enqueueHeartbeatTurn };
}

function session(sessionId: string, lastActivityAt = "2026-06-22T11:00:00.000Z"): HeartbeatSessionRef {
  return { sessionId, lastActivityAt };
}

function makeLocalNoon(): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

function pinDate(localHour: number): Date {
  const d = new Date("2026-06-22T00:00:00.000Z");
  d.setHours(localHour, 0, 0, 0);
  return d;
}

describe("runHeartbeatTick", () => {
  it("fires a silent heartbeat for an eligible idle session with the heartbeat prompt", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({ sessions: [session("s1")] });
    const result = await runHeartbeatTick(deps);

    expect(result.scanned).toBe(1);
    expect(result.fired).toBe(1);
    expect(enqueueHeartbeatTurn).toHaveBeenCalledTimes(1);
    expect(enqueueHeartbeatTurn).toHaveBeenCalledWith({ sessionId: "s1", prompt: HEARTBEAT_SYSTEM_PROMPT });
  });

  it("no-ops entirely when the master autonomy switch is off", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      autonomyEnabled: false,
      sessions: [session("s1")],
    });
    const result = await runHeartbeatTick(deps);

    expect(result.scanned).toBe(0);
    expect(result.fired).toBe(0);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips a session with heartbeat disabled", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      prefsBySession: { s1: prefs({ sessionId: "s1", heartbeatEnabled: false }) },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedDisabled).toBe(1);
    expect(result.fired).toBe(0);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips an ineligible (non-human / eval / scratch) session", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      eligibleBySession: { s1: false },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedIneligible).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips delivery outside active hours", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      prefsBySession: { s1: prefs({ sessionId: "s1", activeHours: { start: 9, end: 17 } }) },
      now: pinDate(3), // 03:00 local — outside 09–17
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedActiveHours).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips a session that is not yet idle enough", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      idleBySession: { s1: 30 }, // below the idle floor
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedNotIdle).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips a session with a running turn", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      runningBySession: { s1: true },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedRunningTurn).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips a session still within the proactive cooldown", async () => {
    const now = makeLocalNoon();
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      now,
      prefsBySession: {
        s1: prefs({ sessionId: "s1", cooldownSeconds: 600, lastProactiveAt: now.toISOString() }),
      },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedCooldown).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("skips a session still within the heartbeat interval", async () => {
    const now = makeLocalNoon();
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago, interval is 1h
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      now,
      prefsBySession: {
        s1: prefs({ sessionId: "s1", cooldownSeconds: 0, heartbeatIntervalSeconds: 3600, lastProactiveAt: recent }),
      },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.skippedInterval).toBe(1);
    expect(enqueueHeartbeatTurn).not.toHaveBeenCalled();
  });

  it("fires once the heartbeat interval has elapsed since the last self-wake", async () => {
    const now = makeLocalNoon();
    const old = new Date(now.getTime() - 2 * 3600 * 1000).toISOString(); // 2h ago, interval is 1h
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1")],
      now,
      prefsBySession: {
        s1: prefs({ sessionId: "s1", cooldownSeconds: 0, heartbeatIntervalSeconds: 3600, lastProactiveAt: old }),
      },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.fired).toBe(1);
    expect(enqueueHeartbeatTurn).toHaveBeenCalledTimes(1);
  });

  it("honors the rate limit across two ticks (interval blocks the immediate re-fire)", async () => {
    const firstNow = makeLocalNoon();
    // Simulate the live shared timestamp: a fired heartbeat touches lastProactiveAt.
    let lastProactiveAt: string | undefined;
    const enqueue = vi.fn(() => {
      lastProactiveAt = (firstNow).toISOString();
      return true;
    });
    const buildDeps = (now: Date): HeartbeatTickDeps => ({
      isAutonomyEnabled: () => true,
      listSessions: () => [session("s1")],
      getSessionAutonomyPrefs: () =>
        prefs({ sessionId: "s1", cooldownSeconds: 0, heartbeatIntervalSeconds: 3600, lastProactiveAt }),
      isHeartbeatEligibleSession: () => true,
      getSessionIdleSeconds: () => IDLE_OK,
      hasRunningTurn: () => false,
      enqueueHeartbeatTurn: enqueue,
      now: () => now,
    });

    const first = await runHeartbeatTick(buildDeps(firstNow));
    expect(first.fired).toBe(1);

    // 5 minutes later — still inside the 1h interval, so no second fire.
    const secondNow = new Date(firstNow.getTime() + 5 * 60 * 1000);
    const second = await runHeartbeatTick(buildDeps(secondNow));
    expect(second.fired).toBe(0);
    expect(second.skippedInterval).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("counts a thrown enqueue as failed", async () => {
    const { deps } = createHarness({
      sessions: [session("s1")],
      enqueue: () => {
        throw new Error("enqueue boom");
      },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.failed).toBe(1);
    expect(result.fired).toBe(0);
  });

  it("counts a falsy enqueue result as failed (not fired)", async () => {
    const { deps } = createHarness({
      sessions: [session("s1")],
      enqueue: () => false,
    });
    const result = await runHeartbeatTick(deps);

    expect(result.failed).toBe(1);
    expect(result.fired).toBe(0);
  });

  it("processes multiple sessions independently in one tick", async () => {
    const { deps, enqueueHeartbeatTurn } = createHarness({
      sessions: [session("s1"), session("s2"), session("s3")],
      prefsBySession: {
        s1: prefs({ sessionId: "s1" }),
        s2: prefs({ sessionId: "s2", heartbeatEnabled: false }),
        s3: prefs({ sessionId: "s3" }),
      },
      idleBySession: { s1: IDLE_OK, s2: IDLE_OK, s3: 10 },
    });
    const result = await runHeartbeatTick(deps);

    expect(result.fired).toBe(1); // only s1
    expect(result.skippedDisabled).toBe(1); // s2
    expect(result.skippedNotIdle).toBe(1); // s3
    expect(enqueueHeartbeatTurn).toHaveBeenCalledWith({ sessionId: "s1", prompt: HEARTBEAT_SYSTEM_PROMPT });
  });
});

describe("active-hours boundary cases", () => {
  it("fires at the inclusive start hour and skips at the exclusive end hour", async () => {
    const atStart = await runHeartbeatTick(
      createHarness({
        sessions: [session("s1")],
        prefsBySession: { s1: prefs({ sessionId: "s1", activeHours: { start: 8, end: 22 } }) },
        now: pinDate(8),
      }).deps,
    );
    expect(atStart.fired).toBe(1);

    const atEnd = await runHeartbeatTick(
      createHarness({
        sessions: [session("s1")],
        prefsBySession: { s1: prefs({ sessionId: "s1", activeHours: { start: 8, end: 22 } }) },
        now: pinDate(22),
      }).deps,
    );
    expect(atEnd.fired).toBe(0);
    expect(atEnd.skippedActiveHours).toBe(1);
  });

  it("supports overnight windows that wrap past midnight", async () => {
    const overnight = (localHour: number) =>
      createHarness({
        sessions: [session("s1")],
        prefsBySession: { s1: prefs({ sessionId: "s1", activeHours: { start: 22, end: 6 } }) },
        now: pinDate(localHour),
      }).deps;

    expect((await runHeartbeatTick(overnight(23))).fired).toBe(1);
    expect((await runHeartbeatTick(overnight(2))).fired).toBe(1);
    expect((await runHeartbeatTick(overnight(12))).skippedActiveHours).toBe(1);
  });

  it("treats a zero-width window as always active", async () => {
    const result = await runHeartbeatTick(
      createHarness({
        sessions: [session("s1")],
        prefsBySession: { s1: prefs({ sessionId: "s1", activeHours: { start: 9, end: 9 } }) },
        now: pinDate(3),
      }).deps,
    );
    expect(result.fired).toBe(1);
  });
});

describe("getHeartbeatIntervalRemainingSeconds", () => {
  it("returns 0 when no prior self-wake timestamp", () => {
    expect(getHeartbeatIntervalRemainingSeconds({ heartbeatIntervalSeconds: 3600 }, new Date())).toBe(0);
  });

  it("returns the remaining window mid-interval", () => {
    const now = new Date("2026-06-22T12:10:00.000Z");
    const remaining = getHeartbeatIntervalRemainingSeconds(
      { lastProactiveAt: "2026-06-22T12:00:00.000Z", heartbeatIntervalSeconds: 3600 },
      now,
    );
    expect(remaining).toBe(3000); // 3600 - 600
  });

  it("returns 0 once the interval has elapsed", () => {
    const now = new Date("2026-06-22T14:00:00.000Z");
    expect(
      getHeartbeatIntervalRemainingSeconds(
        { lastProactiveAt: "2026-06-22T12:00:00.000Z", heartbeatIntervalSeconds: 3600 },
        now,
      ),
    ).toBe(0);
  });
});
