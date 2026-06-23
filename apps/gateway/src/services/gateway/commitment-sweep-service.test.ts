import { describe, expect, it, vi } from "vitest";
import type { AgentCommitmentRecord } from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import {
  buildCommitmentCheckInPrompt,
  getCooldownRemainingSeconds,
  isWithinActiveHours,
  runCommitmentSweep,
  type CommitmentSweepDeps,
} from "./commitment-sweep-service.js";

function commitment(overrides: Partial<AgentCommitmentRecord> = {}): AgentCommitmentRecord {
  return {
    commitmentId: "c1",
    sessionId: "session-1",
    workspaceId: "default",
    kind: "follow_up",
    dueAt: "2026-06-22T08:00:00.000Z",
    confidence: 0.9,
    dedupeKey: "k1",
    suggestedText: "How did it go?",
    status: "pending",
    createdBy: "classifier",
    createdAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function prefs(overrides: Partial<SessionAutonomyPrefsRecord> = {}): SessionAutonomyPrefsRecord {
  return {
    sessionId: "session-1",
    proactiveMode: "off",
    maxActionsPerHour: 6,
    maxActionsPerTurn: 2,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  due?: AgentCommitmentRecord[];
  autonomyEnabled?: boolean;
  prefsBySession?: Record<string, SessionAutonomyPrefsRecord>;
  deliver?: (commitment: AgentCommitmentRecord) => boolean | Promise<boolean>;
  /** Local-noon clock so the default active-hours window (08–22) passes. */
  now?: string;
  activeHours?: CommitmentSweepDeps["resolveActiveHours"];
}

function createHarness(options: HarnessOptions = {}) {
  const deliverCommitment = vi.fn(options.deliver ?? (() => true));
  const markDeliveryPending = vi.fn(() => true);
  const markDeliveryFailed = vi.fn(() => true);
  const deps: CommitmentSweepDeps = {
    isAutonomyEnabled: () => options.autonomyEnabled ?? true,
    listDueCommitments: () => options.due ?? [],
    getSessionAutonomyPrefs: (sessionId) => options.prefsBySession?.[sessionId] ?? prefs({ sessionId }),
    deliverCommitment,
    markDeliveryPending,
    markDeliveryFailed,
    // Use a fixed local-noon Date so active-hours defaults pass deterministically.
    now: () => makeLocalNoon(options.now),
    resolveActiveHours: options.activeHours,
  };
  return { deps, deliverCommitment, markDeliveryPending, markDeliveryFailed };
}

function makeLocalNoon(iso?: string): Date {
  if (iso) {
    return new Date(iso);
  }
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

describe("runCommitmentSweep", () => {
  it("delivers due+pending commitments and marks them delivery-pending", async () => {
    const { deps, deliverCommitment, markDeliveryPending } = createHarness({
      due: [commitment({ commitmentId: "a", sessionId: "s1", dedupeKey: "k1" })],
    });
    const result = await runCommitmentSweep(deps);

    expect(result.scanned).toBe(1);
    expect(result.delivered).toBe(1);
    expect(deliverCommitment).toHaveBeenCalledTimes(1);
    expect(markDeliveryPending).toHaveBeenCalledWith("a");
  });

  it("no-ops entirely when the master autonomy switch is off", async () => {
    const { deps, deliverCommitment, markDeliveryPending } = createHarness({
      autonomyEnabled: false,
      due: [commitment()],
    });
    const result = await runCommitmentSweep(deps);

    expect(result).toEqual({ scanned: 0, delivered: 0, skippedCooldown: 0, skippedActiveHours: 0, failed: 0 });
    expect(deliverCommitment).not.toHaveBeenCalled();
    expect(markDeliveryPending).not.toHaveBeenCalled();
  });

  it("skips a session still within cooldown", async () => {
    const nowIso = makeLocalNoon().toISOString();
    const { deps, deliverCommitment } = createHarness({
      now: nowIso,
      due: [commitment({ sessionId: "s1" })],
      prefsBySession: {
        s1: prefs({ sessionId: "s1", cooldownSeconds: 600, lastProactiveAt: nowIso }),
      },
    });
    const result = await runCommitmentSweep(deps);

    expect(result.skippedCooldown).toBe(1);
    expect(result.delivered).toBe(0);
    expect(deliverCommitment).not.toHaveBeenCalled();
  });

  it("skips delivery outside active hours", async () => {
    const { deps, deliverCommitment } = createHarness({
      due: [commitment()],
      activeHours: () => ({ startHour: 9, endHour: 17 }),
      now: pinLocalHour(3), // 03:00 local — outside 09–17
    });
    const result = await runCommitmentSweep(deps);

    expect(result.skippedActiveHours).toBe(1);
    expect(deliverCommitment).not.toHaveBeenCalled();
  });

  it("delivers at most one check-in per session per sweep (backlog respects cooldown)", async () => {
    const { deps, deliverCommitment, markDeliveryPending } = createHarness({
      due: [
        commitment({ commitmentId: "a", sessionId: "s1", dedupeKey: "k1", dueAt: "2026-06-22T06:00:00.000Z" }),
        commitment({ commitmentId: "b", sessionId: "s1", dedupeKey: "k2", dueAt: "2026-06-22T07:00:00.000Z" }),
        commitment({ commitmentId: "c", sessionId: "s2", dedupeKey: "k3", dueAt: "2026-06-22T06:30:00.000Z" }),
      ],
    });
    const result = await runCommitmentSweep(deps);

    // s1 delivers once (a), b is held by the per-tick cooldown; s2 delivers once (c).
    expect(result.delivered).toBe(2);
    expect(result.skippedCooldown).toBe(1);
    expect(deliverCommitment).toHaveBeenCalledTimes(2);
    expect(markDeliveryPending).toHaveBeenCalledWith("a");
    expect(markDeliveryPending).toHaveBeenCalledWith("c");
    expect(markDeliveryPending).not.toHaveBeenCalledWith("b");
  });

  it("marks failed when delivery enqueue reports failure", async () => {
    const { deps, markDeliveryPending, markDeliveryFailed } = createHarness({
      due: [commitment({ commitmentId: "a" })],
      deliver: () => false,
    });
    const result = await runCommitmentSweep(deps);

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(markDeliveryPending).not.toHaveBeenCalled();
    expect(markDeliveryFailed).toHaveBeenCalledWith("a");
  });

  it("marks failed when delivery enqueue throws", async () => {
    const { deps, markDeliveryPending, markDeliveryFailed } = createHarness({
      due: [commitment({ commitmentId: "a" })],
      deliver: () => {
        throw new Error("delivery boom");
      },
    });
    const result = await runCommitmentSweep(deps);

    expect(result.failed).toBe(1);
    expect(markDeliveryPending).not.toHaveBeenCalled();
    expect(markDeliveryFailed).toHaveBeenCalledWith("a");
  });
});

describe("isWithinActiveHours", () => {
  it("matches a daytime window", () => {
    expect(isWithinActiveHours(pinDate(10), { startHour: 8, endHour: 22 })).toBe(true);
    expect(isWithinActiveHours(pinDate(23), { startHour: 8, endHour: 22 })).toBe(false);
    expect(isWithinActiveHours(pinDate(8), { startHour: 8, endHour: 22 })).toBe(true);
    expect(isWithinActiveHours(pinDate(22), { startHour: 8, endHour: 22 })).toBe(false);
  });

  it("supports overnight windows that wrap past midnight", () => {
    const window = { startHour: 22, endHour: 6 };
    expect(isWithinActiveHours(pinDate(23), window)).toBe(true);
    expect(isWithinActiveHours(pinDate(2), window)).toBe(true);
    expect(isWithinActiveHours(pinDate(12), window)).toBe(false);
  });

  it("treats a zero-width window as always active", () => {
    expect(isWithinActiveHours(pinDate(3), { startHour: 9, endHour: 9 })).toBe(true);
  });
});

describe("getCooldownRemainingSeconds", () => {
  it("returns 0 when no prior proactive timestamp", () => {
    expect(getCooldownRemainingSeconds({ cooldownSeconds: 600 }, new Date())).toBe(0);
  });

  it("returns the remaining window mid-cooldown", () => {
    const now = new Date("2026-06-22T12:10:00.000Z");
    const remaining = getCooldownRemainingSeconds(
      { lastProactiveAt: "2026-06-22T12:05:00.000Z", cooldownSeconds: 600 },
      now,
    );
    expect(remaining).toBe(300);
  });

  it("returns 0 once the cooldown has elapsed", () => {
    const now = new Date("2026-06-22T13:00:00.000Z");
    expect(
      getCooldownRemainingSeconds({ lastProactiveAt: "2026-06-22T12:00:00.000Z", cooldownSeconds: 600 }, now),
    ).toBe(0);
  });
});

describe("buildCommitmentCheckInPrompt", () => {
  it("frames the suggested text as a self-initiated check-in", () => {
    const prompt = buildCommitmentCheckInPrompt("How did the Acme interview go?");
    expect(prompt).toContain("self-initiated follow-up check-in");
    expect(prompt).toContain("How did the Acme interview go?");
  });
});

function pinDate(localHour: number): Date {
  const d = new Date("2026-06-22T00:00:00.000Z");
  d.setHours(localHour, 0, 0, 0);
  return d;
}

function pinLocalHour(localHour: number): string {
  return pinDate(localHour).toISOString();
}
