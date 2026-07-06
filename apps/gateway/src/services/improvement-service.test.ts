import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
  type SurfaceRouteOverrideSignalInput,
  type SurfaceRouteOverrideExemplar,
} from "./improvement-service.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{
    channel: string;
    topic: string;
    payload: Record<string, unknown>;
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
  }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService recordSurfaceRouteOverrideSignal", () => {
  it("persists a surface-route override as a human negative signal with the expected shape", () => {
    const harness = createHarness();

    const input: SurfaceRouteOverrideSignalInput = {
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      fromMode: "code",
      toMode: "chat",
      autoConfidence: 0.85,
      promptFeatureHash: "abc123",
    };

    harness.service.recordSurfaceRouteOverrideSignal(input);

    // Read the signal back by listing all signals in the DB
    const row = harness.storage.gatewaySql
      .prepare("SELECT * FROM improvement_signals WHERE signal_kind = ?")
      .get("surface_route_override") as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!["origin"]).toBe("human");
    expect(row!["signal_kind"]).toBe("surface_route_override");
    expect(row!["outcome"]).toBe("negative");

    const fingerprint = String(row!["fingerprint"]);
    expect(fingerprint).toContain("personal");
    expect(fingerprint).toContain("code");
    expect(fingerprint).toContain("chat");
  });

  it("returns void and does not throw on a valid input", () => {
    const harness = createHarness();

    const result = harness.service.recordSurfaceRouteOverrideSignal({
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s2",
      turnId: "t2",
      fromMode: "code",
      toMode: "chat",
      autoConfidence: 0.9,
      promptFeatureHash: "def456",
    });

    expect(result).toBeUndefined();
  });
});

describe("ImprovementService listSurfaceRouteOverrideExemplars", () => {
  it("returns only exemplars for the requested citadel", () => {
    const harness = createHarness();

    const alphaBase: Omit<
      SurfaceRouteOverrideSignalInput,
      "fromMode" | "toMode" | "promptFeatureHash" | "sessionId" | "turnId"
    > = {
      citadelId: "alpha",
      workspaceId: "default",
      autoConfidence: 0.7,
    };

    // Signals recorded within the same millisecond tie on recorded_at, and the
    // listing's tiebreaker is signal_id (a random UUID) — deterministic but
    // arbitrary. Advance fake time between inserts so "most recent first" is
    // actually observable instead of flaking on fast CI runners.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
      harness.service.recordSurfaceRouteOverrideSignal({
        ...alphaBase,
        sessionId: "s-alpha-1",
        turnId: "t-alpha-1",
        fromMode: "code",
        toMode: "chat",
        promptFeatureHash: "h1",
      });
      vi.setSystemTime(new Date("2026-07-05T00:00:00.050Z"));
      harness.service.recordSurfaceRouteOverrideSignal({
        ...alphaBase,
        sessionId: "s-alpha-2",
        turnId: "t-alpha-2",
        fromMode: "cowork",
        toMode: "code",
        promptFeatureHash: "h2",
      });
      vi.setSystemTime(new Date("2026-07-05T00:00:00.100Z"));
      harness.service.recordSurfaceRouteOverrideSignal({
        citadelId: "beta",
        workspaceId: "default",
        sessionId: "s-beta-1",
        turnId: "t-beta-1",
        fromMode: "chat",
        toMode: "code",
        autoConfidence: 0.6,
        promptFeatureHash: "h3",
      });
    } finally {
      vi.useRealTimers();
    }

    const exemplars: SurfaceRouteOverrideExemplar[] = harness.service.listSurfaceRouteOverrideExemplars("alpha");

    expect(exemplars).toHaveLength(2);
    // Most recent first — cowork→code was recorded last
    expect(exemplars[0]).toMatchObject({ fromMode: "cowork", toMode: "code" });
    expect(exemplars[1]).toMatchObject({ fromMode: "code", toMode: "chat" });
    // All exemplars have a recordedAt timestamp
    for (const ex of exemplars) {
      expect(typeof ex.recordedAt).toBe("string");
      expect(ex.recordedAt.length).toBeGreaterThan(0);
    }
    // Beta override must not appear
    const hasBeta = exemplars.some((ex) => ex.fromMode === "chat" && ex.toMode === "code");
    expect(hasBeta).toBe(false);
  });

  it("respects the limit parameter", () => {
    const harness = createHarness();

    const base: Omit<
      SurfaceRouteOverrideSignalInput,
      "fromMode" | "toMode" | "promptFeatureHash" | "sessionId" | "turnId"
    > = {
      citadelId: "alpha",
      workspaceId: "default",
      autoConfidence: 0.8,
    };

    harness.service.recordSurfaceRouteOverrideSignal({
      ...base,
      sessionId: "s1",
      turnId: "t1",
      fromMode: "code",
      toMode: "chat",
      promptFeatureHash: "h1",
    });
    harness.service.recordSurfaceRouteOverrideSignal({
      ...base,
      sessionId: "s2",
      turnId: "t2",
      fromMode: "cowork",
      toMode: "code",
      promptFeatureHash: "h2",
    });

    const limited = harness.service.listSurfaceRouteOverrideExemplars("alpha", 1);
    expect(limited).toHaveLength(1);
  });

  it("returns an empty array when no signals exist for the citadel", () => {
    const harness = createHarness();
    const exemplars = harness.service.listSurfaceRouteOverrideExemplars("nonexistent");
    expect(exemplars).toEqual([]);
  });
});

describe("ImprovementService surface_route_override synthesizes routing_policy candidate", () => {
  it("synthesizes a routing_policy candidate after threshold-meeting override signals", () => {
    const harness = createHarness();

    const base = {
      citadelId: "alpha",
      workspaceId: "default",
      fromMode: "code" as const,
      toMode: "chat" as const,
      autoConfidence: 0.3,
      promptFeatureHash: "abc",
    };

    // Two signals with the same fingerprint satisfy requiredCount=2 (low-volume workspace)
    harness.service.recordSurfaceRouteOverrideSignal({ ...base, sessionId: "s1", turnId: "t1" });
    harness.service.recordSurfaceRouteOverrideSignal({ ...base, sessionId: "s2", turnId: "t2" });

    const candidates = harness.service.listImprovementCandidates(100, "default");
    const routingCandidate = candidates.find((c) => c.kind === "routing_policy");

    expect(routingCandidate).toBeDefined();
    expect(routingCandidate!.kind).toBe("routing_policy");
  });
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-surface-router-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir,
    auditDir,
  });
  const published: Harness["published"] = [];
  const harness = {
    rootDir,
    storage,
    service: undefined as unknown as ImprovementService,
    published,
  };
  const ctx: ImprovementServiceContext = {
    storage,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (channel, topic, payload, realtimeOptions) => {
      published.push({ channel, topic, payload, options: realtimeOptions });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  harness.service = new ImprovementService(ctx, callbacks);
  harnesses.push(harness);
  return harness;
}
