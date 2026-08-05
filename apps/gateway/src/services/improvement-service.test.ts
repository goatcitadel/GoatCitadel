import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ImprovementRef, RealtimeEvent } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementLifecycleCrashBoundary,
  type ImprovementLifecyclePendingApproval,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
  type SurfaceRouteOverrideSignalInput,
  type SurfaceRouteOverrideExemplar,
} from "./improvement-service.js";
import { ImprovementLifecycleApplyError } from "./improvement-lifecycle-journey-producer.js";

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
  it("persists a surface-route override as a human negative signal with the expected shape", async () => {
    const harness = await createHarness();

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

    await harness.service.recordSurfaceRouteOverrideSignal(input);

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

  it("returns void and does not throw on a valid input", async () => {
    const harness = await createHarness();

    const result = await harness.service.recordSurfaceRouteOverrideSignal({
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
  it("returns only exemplars for the requested citadel", async () => {
    const harness = await createHarness();

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
      await harness.service.recordSurfaceRouteOverrideSignal({
        ...alphaBase,
        sessionId: "s-alpha-1",
        turnId: "t-alpha-1",
        fromMode: "code",
        toMode: "chat",
        promptFeatureHash: "h1",
      });
      vi.setSystemTime(new Date("2026-07-05T00:00:00.050Z"));
      await harness.service.recordSurfaceRouteOverrideSignal({
        ...alphaBase,
        sessionId: "s-alpha-2",
        turnId: "t-alpha-2",
        fromMode: "cowork",
        toMode: "code",
        promptFeatureHash: "h2",
      });
      vi.setSystemTime(new Date("2026-07-05T00:00:00.100Z"));
      await harness.service.recordSurfaceRouteOverrideSignal({
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

    const exemplars: SurfaceRouteOverrideExemplar[] = await harness.service.listSurfaceRouteOverrideExemplars("alpha");

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

  it("respects the limit parameter", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createHarness();

      const base: Omit<
        SurfaceRouteOverrideSignalInput,
        "fromMode" | "toMode" | "promptFeatureHash" | "sessionId" | "turnId"
      > = {
        citadelId: "alpha",
        workspaceId: "default",
        autoConfidence: 0.8,
      };

      vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
      await harness.service.recordSurfaceRouteOverrideSignal({
        ...base,
        sessionId: "s1",
        turnId: "t1",
        fromMode: "code",
        toMode: "chat",
        promptFeatureHash: "h1",
      });

      vi.setSystemTime(new Date("2025-01-01T00:00:01.000Z"));
      await harness.service.recordSurfaceRouteOverrideSignal({
        ...base,
        sessionId: "s2",
        turnId: "t2",
        fromMode: "cowork",
        toMode: "code",
        promptFeatureHash: "h2",
      });

      const limited = await harness.service.listSurfaceRouteOverrideExemplars("alpha", 1);
      expect(limited).toHaveLength(1);
      expect(limited[0]).toMatchObject({ fromMode: "cowork", toMode: "code" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty array when no signals exist for the citadel", async () => {
    const harness = await createHarness();
    const exemplars = await harness.service.listSurfaceRouteOverrideExemplars("nonexistent");
    expect(exemplars).toEqual([]);
  });
});

describe("ImprovementService surface_route_override synthesizes routing_policy candidate", () => {
  it("synthesizes a routing_policy candidate after threshold-meeting override signals", async () => {
    const harness = await createHarness();

    const base = {
      citadelId: "alpha",
      workspaceId: "default",
      fromMode: "code" as const,
      toMode: "chat" as const,
      autoConfidence: 0.3,
      promptFeatureHash: "abc",
    };

    // Two signals with the same fingerprint satisfy requiredCount=2 (low-volume workspace)
    await harness.service.recordSurfaceRouteOverrideSignal({ ...base, sessionId: "s1", turnId: "t1" });
    await harness.service.recordSurfaceRouteOverrideSignal({ ...base, sessionId: "s2", turnId: "t2" });

    const candidates = await harness.service.listImprovementCandidates(100, "default");
    const routingCandidate = candidates.find((c) => c.kind === "routing_policy");

    expect(routingCandidate).toBeDefined();
    expect(routingCandidate!.kind).toBe("routing_policy");
  });
});

// ── HX-402 P3: the recoverable governed improvement lifecycle ────────────
//
// Proof matrix (audit-verbatim): crash injection before/after callback and at
// the inspection, settlement-adjacent signal, and Journey boundaries; stale /
// original approval reuse rejected; exact replay; competing workers with one
// winner; failed compensation recorded truthfully; zero false applied /
// rolled_back claims against injected external-state fakes.

interface GovernedHarness extends Harness {
  policies: Record<string, unknown>;
  applyCalls: number;
  restoreCalls: number;
  callbacks: ImprovementServiceCallbacks & {
    improvementLifecycleCrashSeam?: (boundary: ImprovementLifecycleCrashBoundary) => void;
  };
  /** Overridable external-callback behavior for the zero-false-claims matrix. */
  behavior: {
    applyMode: "target" | "wrong" | "throw" | "throw_after_write";
    restoreMode: "snapshot" | "wrong" | "throw";
    crashAt?: ImprovementLifecycleCrashBoundary;
  };
}

async function createGovernedHarness(): Promise<GovernedHarness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-governed-"));
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
  const policies: Record<string, unknown> = {};
  const harness = {
    rootDir,
    storage,
    service: undefined as unknown as ImprovementService,
    published,
    policies,
    applyCalls: 0,
    restoreCalls: 0,
    callbacks: undefined as unknown as GovernedHarness["callbacks"],
    behavior: { applyMode: "target", restoreMode: "snapshot" } as GovernedHarness["behavior"],
  };
  const ctx: ImprovementServiceContext = {
    storage: createLocalAsyncStorage(storage),
    gatewaySql: storage.gatewaySql,
    publishRealtime: async (channel, topic, payload, realtimeOptions) => {
      published.push({ channel, topic, payload, options: realtimeOptions });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const captureSnapshot = (refType: ImprovementRef["refType"], targetKey: string): ImprovementRef => {
    const hadValue = Object.prototype.hasOwnProperty.call(policies, targetKey);
    return {
      refType,
      refId: targetKey,
      metadata: { targetKey, hadValue, previousValue: hadValue ? policies[targetKey] : null },
    };
  };
  const applyCandidate = (targetKey: string, revisionRef: ImprovementRef): ImprovementRef => {
    harness.applyCalls += 1;
    const metadata = revisionRef.metadata as Record<string, unknown> | undefined;
    const proposedChange = metadata && "proposedChange" in metadata ? metadata.proposedChange : metadata;
    const targetValue = proposedChange ?? metadata ?? {};
    if (harness.behavior.applyMode === "throw") {
      throw new Error("external apply endpoint unavailable");
    }
    if (harness.behavior.applyMode === "wrong") {
      policies[targetKey] = { corrupted: true };
    } else {
      policies[targetKey] = targetValue;
    }
    if (harness.behavior.applyMode === "throw_after_write") {
      throw new Error("external apply acknowledged late");
    }
    return { refType: "routing_policy_config", refId: targetKey, metadata: { targetKey } };
  };
  const restoreSnapshot = (snapshotRef: ImprovementRef): void => {
    harness.restoreCalls += 1;
    if (harness.behavior.restoreMode === "throw") {
      throw new Error("external restore endpoint unavailable");
    }
    const metadata = snapshotRef.metadata as
      | { targetKey?: string; hadValue?: boolean; previousValue?: unknown }
      | undefined;
    const targetKey = metadata?.targetKey ?? snapshotRef.refId;
    if (harness.behavior.restoreMode === "wrong") {
      policies[targetKey] = { corruptedRestore: true };
      return;
    }
    if (metadata?.hadValue) {
      policies[targetKey] = metadata.previousValue;
      return;
    }
    delete policies[targetKey];
  };
  const callbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn((targetKey: string) => captureSnapshot("repair_policy_snapshot", targetKey)),
    applyRepairPolicyCandidate: vi.fn(applyCandidate),
    restoreRepairPolicySnapshot: vi.fn(restoreSnapshot),
    captureRoutingPolicySnapshot: vi.fn((targetKey: string) => captureSnapshot("routing_policy_snapshot", targetKey)),
    applyRoutingPolicyCandidate: vi.fn(applyCandidate),
    restoreRoutingPolicySnapshot: vi.fn(restoreSnapshot),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
    improvementLifecycleClaimLeaseMs: 250,
    improvementLifecycleCrashSeam: (boundary: ImprovementLifecycleCrashBoundary) => {
      if (harness.behavior.crashAt === boundary) {
        harness.behavior.crashAt = undefined;
        throw new Error(`injected crash at ${boundary}`);
      }
    },
  } as unknown as GovernedHarness["callbacks"];

  harness.callbacks = callbacks;
  harness.service = new ImprovementService(ctx, callbacks);
  await harness.service.initialize();
  harnesses.push(harness);
  return harness;
}

async function createReadyRoutingCandidate(harness: GovernedHarness, suffix = "1") {
  await harness.service.recordPromptLabRegressionCompletionSignal({
    regressionRunId: `regression-governed-${suffix}`,
    packId: "pack-routing",
    capability: suffix === "1" ? "provider-balance" : `provider-balance-${suffix}`,
    scoreDelta: -0.6,
    passDelta: -0.2,
    latencyDeltaMs: 35,
  });
  const candidate = (await harness.service.listImprovementCandidates(50, "prompt-lab")).find(
    (item) => item.kind === "routing_policy" && item.status === "ready_for_approval",
  );
  expect(candidate).toBeDefined();
  return candidate!;
}

function approve(harness: GovernedHarness, approvalId: string, resolvedBy = "resolver-1") {
  return harness.storage.approvals.resolve(approvalId, {
    decision: "approve",
    resolvedBy,
    resolutionNote: "governed lifecycle proof",
  });
}

async function requestActivation(
  harness: GovernedHarness,
  candidateId: string,
): Promise<ImprovementLifecyclePendingApproval> {
  const outcome = await harness.service.requestImprovementActivationApproval(candidateId, {
    requesterId: "operator-7",
  });
  return outcome.pendingApproval;
}

async function executeApproved(harness: GovernedHarness, approvalId: string) {
  return await harness.service.executeApprovedImprovementLifecycleMutation({ workspaceId: "prompt-lab", approvalId });
}

async function waitForLeaseExpiry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 450));
}

async function activateApplied(harness: GovernedHarness, candidateId: string) {
  const pending = await requestActivation(harness, candidateId);
  approve(harness, pending.approvalId);
  const applied = await executeApproved(harness, pending.approvalId);
  expect(applied.disposition).toBe("applied");
  expect(applied.activationId).toBeDefined();
  return { pending, applied };
}

function countRows(harness: GovernedHarness, table: string, where = "1=1", params: unknown[] = []): number {
  const row = harness.storage.gatewaySql
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as { n: number };
  return Number(row.n);
}

describe("HX-402 P3 governed improvement activation", () => {
  it("activation request is approval-first: it never mutates and byte-exact replays converge on one approval", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);

    const first = await requestActivation(harness, candidate.candidateId);
    expect(first.kind).toBe("improvement.lifecycle");
    expect(first.operationKind).toBe("activate");
    expect(first.replayed).toBe(false);
    // Nothing mutated: no external policy write, no activation row, no candidate transition.
    expect(harness.policies).toEqual({});
    expect(countRows(harness, "improvement_activations")).toBe(0);
    expect((await harness.service.listImprovementCandidates(50, "prompt-lab"))[0]?.status).toBe("ready_for_approval");
    // Requester Journey evidence committed with the approval.
    const evidence = harness.storage.governanceJourneyEvents.findByIdempotencyKey(
      `improvement:lifecycle:request:${first.approvalId}`,
    );
    expect(evidence).toMatchObject({ actorId: "operator-7", approvalId: first.approvalId });

    const replay = await requestActivation(harness, candidate.candidateId);
    expect(replay.approvalId).toBe(first.approvalId);
    expect(replay.replayed).toBe(true);
    expect(
      countRows(harness, "governance_journey_events", "idempotency_key = ?", [
        `improvement:lifecycle:request:${first.approvalId}`,
      ]),
    ).toBe(1);
  });

  it("the recovered effect creates the durable intent and settles activation state, settlement, signal, and Journey together", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);

    const applied = await executeApproved(harness, pending.approvalId);

    expect(applied).toMatchObject({ disposition: "applied", operationKind: "activate", replayed: false });
    expect(harness.applyCalls).toBe(1);
    expect(harness.policies[candidate.targetKey]).toMatchObject({ strategy: "route_rebalance" });
    // Durable intent row exists and is settled.
    expect(countRows(harness, "improvement_lifecycle_operations", "approval_id = ?", [pending.approvalId])).toBe(1);
    expect(
      countRows(harness, "improvement_lifecycle_operation_settlements", "operation_id = ?", [applied.operationId]),
    ).toBe(1);
    // Canonical activation row + candidate transition committed.
    const activation = await harness.service.getImprovementActivation(applied.activationId!);
    expect(activation).toMatchObject({ status: "active", watchStatus: "watching", approvalId: pending.approvalId });
    expect((await harness.service.listImprovementCandidates(50, "prompt-lab"))[0]?.status).toBe("approved");
    // Canonical signal + Journey settlement evidence.
    expect(countRows(harness, "improvement_signals", "signal_kind = 'activation_applied'")).toBe(1);
    expect(
      harness.storage.governanceJourneyEvents.findByIdempotencyKey(
        `improvement:lifecycle:settled:${applied.operationId}`,
      ),
    ).toMatchObject({ action: "activate_applied", actorType: "approval_effect" });

    // Exact replay converges with zero re-mutation and zero duplicate callbacks.
    const replay = await executeApproved(harness, pending.approvalId);
    expect(replay).toMatchObject({ disposition: "applied", replayed: true, settlementId: applied.settlementId });
    expect(harness.applyCalls).toBe(1);
  });

  it("refuses stale/original approval reuse: pause and rollback demand their own fresh approvals", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const { pending, applied } = await activateApplied(harness, candidate.candidateId);

    // A pause request NEVER rides the activation approval: it commits a fresh
    // deterministic approval with its own identity.
    const pauseOutcome = await harness.service.requestImprovementPauseApproval(applied.activationId!, {
      requesterId: "operator-7",
    });
    expect(pauseOutcome.pendingApproval).not.toBeNull();
    const pausePending = pauseOutcome.pendingApproval!;
    expect(pausePending.approvalId).not.toBe(pending.approvalId);
    expect(pausePending.operationKind).toBe("pause");
    // The activation is untouched until the fresh approval's effect runs.
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");

    // Re-executing the ORIGINAL activation approval converges on the original
    // settlement — it can never morph into the later mutation.
    const replay = await executeApproved(harness, pending.approvalId);
    expect(replay).toMatchObject({ operationKind: "activate", replayed: true });
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");

    // A LEGACY improvement_activation approval (the stale pre-P3 kind) is not
    // executable by the governed effect at all.
    const legacy = harness.storage.approvals.create({
      kind: "improvement_activation",
      riskLevel: "safe",
      payload: { candidateId: candidate.candidateId },
      preview: {},
    });
    approve(harness, legacy.approvalId);
    await expect(executeApproved(harness, legacy.approvalId)).rejects.toThrowError(ImprovementLifecycleApplyError);
    try {
      await executeApproved(harness, legacy.approvalId);
    } catch (error) {
      expect((error as ImprovementLifecycleApplyError).code).toBe("improvement_lifecycle_approval_not_executable");
    }

    // The fresh pause approval executes through the full ladder.
    approve(harness, pausePending.approvalId);
    const paused = await executeApproved(harness, pausePending.approvalId);
    expect(paused).toMatchObject({ disposition: "applied", operationKind: "pause" });
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("paused");
    expect(harness.policies[candidate.targetKey]).toBeUndefined();
    expect(harness.restoreCalls).toBe(1);
  });

  it("rejects an unresolved, expired, or evidence-less approval fail-closed", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);

    // Pending (unresolved) approval is not executable.
    await expect(executeApproved(harness, pending.approvalId)).rejects.toThrowError(
      new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable"),
    );

    // Expired approval is refused terminally.
    approve(harness, pending.approvalId);
    harness.storage.gatewaySql
      .prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE approval_id = ?")
      .run(pending.approvalId);
    try {
      await executeApproved(harness, pending.approvalId);
      expect.unreachable("expired approval must be refused");
    } catch (error) {
      expect((error as ImprovementLifecycleApplyError).code).toBe("improvement_lifecycle_approval_expired");
    }
    expect(harness.applyCalls).toBe(0);
    expect(harness.policies).toEqual({});
  });

  it("aborts truthfully on reviewed-state drift without executing the external callback", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);
    // The reviewed candidate drifts AFTER approval.
    harness.storage.gatewaySql
      .prepare("UPDATE improvement_candidates SET status = 'rejected' WHERE candidate_id = ?")
      .run(candidate.candidateId);

    const aborted = await executeApproved(harness, pending.approvalId);

    expect(aborted.disposition).toBe("aborted");
    expect(harness.applyCalls).toBe(0);
    expect(harness.policies).toEqual({});
    expect(countRows(harness, "improvement_activations")).toBe(0);
    const settlement = harness.storage.gatewaySql
      .prepare(
        "SELECT disposition, result_json FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?",
      )
      .get(aborted.operationId) as { disposition: string; result_json: string };
    expect(settlement.disposition).toBe("aborted");
    expect(JSON.parse(settlement.result_json)).toMatchObject({ reasonCode: "state_drift" });
    // The abort is immutable truth: re-execution replays it byte-identically.
    expect(await executeApproved(harness, pending.approvalId)).toMatchObject({
      disposition: "aborted",
      replayed: true,
    });
  });

  it("aborts truthfully on external pre-state drift without executing the callback", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);
    // A foreign writer changed the external policy after review.
    harness.policies[candidate.targetKey] = { foreign: true };

    const aborted = await executeApproved(harness, pending.approvalId);

    expect(aborted.disposition).toBe("aborted");
    expect(harness.applyCalls).toBe(0);
    const settlement = harness.storage.gatewaySql
      .prepare("SELECT result_json FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?")
      .get(aborted.operationId) as { result_json: string };
    expect(JSON.parse(settlement.result_json)).toMatchObject({ reasonCode: "external_state_drift" });
  });
});

describe("HX-402 P3 crash recovery resumes from the durable intent", () => {
  const boundaries: Array<{
    boundary: ImprovementLifecycleCrashBoundary;
    callbackRunsBeforeCrash: number;
  }> = [
    { boundary: "improvement_lifecycle_before_callback", callbackRunsBeforeCrash: 0 },
    { boundary: "improvement_lifecycle_after_callback", callbackRunsBeforeCrash: 1 },
    { boundary: "improvement_lifecycle_after_inspection", callbackRunsBeforeCrash: 1 },
    { boundary: "improvement_lifecycle_before_signal", callbackRunsBeforeCrash: 1 },
    { boundary: "improvement_lifecycle_before_journey", callbackRunsBeforeCrash: 1 },
  ];

  for (const { boundary, callbackRunsBeforeCrash } of boundaries) {
    it(`crash at ${boundary}: no partial state persists and recovery converges without duplicate callbacks`, async () => {
      const harness = await createGovernedHarness();
      const candidate = await createReadyRoutingCandidate(harness);
      const pending = await requestActivation(harness, candidate.candidateId);
      approve(harness, pending.approvalId);

      harness.behavior.crashAt = boundary;
      await expect(executeApproved(harness, pending.approvalId)).rejects.toThrow(/injected crash/u);
      expect(harness.applyCalls).toBe(callbackRunsBeforeCrash);

      // The durable intent survives; NOTHING else settled or partially applied:
      // settlement/state/signal/Journey commit as one transaction or not at all.
      expect(countRows(harness, "improvement_lifecycle_operations")).toBe(1);
      expect(countRows(harness, "improvement_lifecycle_operation_settlements")).toBe(0);
      expect(countRows(harness, "improvement_activations")).toBe(0);
      expect(countRows(harness, "improvement_signals", "signal_kind = 'activation_applied'")).toBe(0);
      expect(
        harness.storage.governanceJourneyEvents.findByIdempotencyKey(
          `improvement:lifecycle:settled:${deriveOperationIdForApproval(harness, pending.approvalId)}`,
        ),
      ).toBeUndefined();

      await waitForLeaseExpiry();
      const recovered = await executeApproved(harness, pending.approvalId);
      expect(recovered.disposition).toBe("applied");
      // The non-idempotent callback ran EXACTLY once across crash + recovery.
      expect(harness.applyCalls).toBe(1);
      expect(harness.policies[candidate.targetKey]).toMatchObject({ strategy: "route_rebalance" });
      expect((await harness.service.getImprovementActivation(recovered.activationId!)).status).toBe("active");
      expect(countRows(harness, "improvement_lifecycle_operation_settlements")).toBe(1);
      expect(countRows(harness, "improvement_signals", "signal_kind = 'activation_applied'")).toBe(1);
    });
  }

  it("recovers a pause crash after its restore callback without re-restoring", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const { applied } = await activateApplied(harness, candidate.candidateId);
    const pausePending = (
      await harness.service.requestImprovementPauseApproval(applied.activationId!, {
        requesterId: "operator-7",
      })
    ).pendingApproval!;
    approve(harness, pausePending.approvalId);

    harness.behavior.crashAt = "improvement_lifecycle_before_journey";
    await expect(executeApproved(harness, pausePending.approvalId)).rejects.toThrow(/injected crash/u);
    expect(harness.restoreCalls).toBe(1);
    // Rollback of the settlement transaction left the row active (no partial flip).
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");

    await waitForLeaseExpiry();
    const recovered = await executeApproved(harness, pausePending.approvalId);
    expect(recovered).toMatchObject({ disposition: "applied", operationKind: "pause" });
    // Recovery re-INSPECTED instead of re-executing the restore callback.
    expect(harness.restoreCalls).toBe(1);
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("paused");
  });

  it("two competing workers resolve to exactly one claim winner", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);

    // Worker A crashes mid-flight holding a live lease.
    harness.behavior.crashAt = "improvement_lifecycle_after_callback";
    await expect(executeApproved(harness, pending.approvalId)).rejects.toThrow(/injected crash/u);
    // Worker B races in while the lease is live and loses the claim.
    await expect(executeApproved(harness, pending.approvalId)).rejects.toThrow(/fenced|one-winner/u);
    expect(harness.applyCalls).toBe(1);
    // After the database-clock lease expires, the next claimant wins generation 2 and converges.
    await waitForLeaseExpiry();
    const recovered = await executeApproved(harness, pending.approvalId);
    expect(recovered.disposition).toBe("applied");
    expect(harness.applyCalls).toBe(1);
    const claims = harness.storage.gatewaySql
      .prepare(
        "SELECT claim_generation FROM improvement_lifecycle_operation_claims WHERE operation_id = ? ORDER BY claim_generation",
      )
      .all(recovered.operationId) as Array<{ claim_generation: number }>;
    expect(claims.map((row) => Number(row.claim_generation))).toEqual([1, 2]);
  });
});

describe("HX-402 P3 zero false applied/rolled_back claims", () => {
  it("callback wrote the wrong external state: settlement records the truthful mismatch, never applied", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);
    harness.behavior.applyMode = "wrong";

    const failed = await executeApproved(harness, pending.approvalId);

    expect(failed.disposition).toBe("failed");
    expect(harness.applyCalls).toBe(1);
    // The canonical activation row records the failure; the candidate is NOT approved.
    expect(await harness.service.getImprovementActivation(failed.activationId!)).toMatchObject({
      status: "failed",
      failureReason: "external_state_diverged",
    });
    expect((await harness.service.listImprovementCandidates(50, "prompt-lab"))[0]?.status).toBe("ready_for_approval");
    const settlement = harness.storage.gatewaySql
      .prepare("SELECT disposition FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?")
      .get(failed.operationId) as { disposition: string };
    expect(settlement.disposition).toBe("failed");
  });

  it("callback threw without mutating: settlement is failed with the observed pre-state, never applied", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);
    harness.behavior.applyMode = "throw";

    const failed = await executeApproved(harness, pending.approvalId);

    expect(failed.disposition).toBe("failed");
    expect(harness.policies).toEqual({});
    const settlement = harness.storage.gatewaySql
      .prepare("SELECT result_json FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?")
      .get(failed.operationId) as { result_json: string };
    expect(JSON.parse(settlement.result_json)).toMatchObject({ reasonCode: "activation_callback_failed" });
  });

  it("callback threw AFTER mutating to the exact target: re-inspection honestly settles applied", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const pending = await requestActivation(harness, candidate.candidateId);
    approve(harness, pending.approvalId);
    harness.behavior.applyMode = "throw_after_write";

    const applied = await executeApproved(harness, pending.approvalId);

    expect(applied.disposition).toBe("applied");
    expect(harness.policies[candidate.targetKey]).toMatchObject({ strategy: "route_rebalance" });
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");
  });

  it("failed compensation: rollback whose restore diverges records failed and never claims rolled_back", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const { applied } = await activateApplied(harness, candidate.candidateId);
    const rollbackPending = (
      await harness.service.requestImprovementRollbackApproval(applied.activationId!, {
        requesterId: "operator-7",
      })
    ).pendingApproval!;
    approve(harness, rollbackPending.approvalId);
    harness.behavior.restoreMode = "wrong";

    const failed = await executeApproved(harness, rollbackPending.approvalId);

    expect(failed).toMatchObject({ disposition: "failed", operationKind: "rollback" });
    expect(harness.restoreCalls).toBe(1);
    // No rolled_back claim anywhere: not on the row, not in the settlement.
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");
    const settlement = harness.storage.gatewaySql
      .prepare(
        "SELECT disposition, result_json FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?",
      )
      .get(failed.operationId) as { disposition: string; result_json: string };
    expect(settlement.disposition).toBe("failed");
    expect(JSON.parse(settlement.result_json)).toMatchObject({ reasonCode: "external_state_diverged" });
    expect(countRows(harness, "improvement_signals", "signal_kind = 'activation_rolled_back'")).toBe(0);
  });

  it("rollback restore that threw without restoring settles failed; a truthful retry cannot exist for the settled operation", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const { applied } = await activateApplied(harness, candidate.candidateId);
    const rollbackPending = (
      await harness.service.requestImprovementRollbackApproval(applied.activationId!, {
        requesterId: "operator-7",
      })
    ).pendingApproval!;
    approve(harness, rollbackPending.approvalId);
    harness.behavior.restoreMode = "throw";

    const failed = await executeApproved(harness, rollbackPending.approvalId);
    expect(failed).toMatchObject({ disposition: "failed", operationKind: "rollback" });
    expect((await harness.service.getImprovementActivation(applied.activationId!)).status).toBe("active");
    // The immutable settlement is the recovery truth: replays converge on failed.
    expect(await executeApproved(harness, rollbackPending.approvalId)).toMatchObject({
      disposition: "failed",
      replayed: true,
    });
    expect(harness.restoreCalls).toBe(1);
  });

  it("pause of an already-paused activation is a pure no-op envelope", async () => {
    const harness = await createGovernedHarness();
    const candidate = await createReadyRoutingCandidate(harness);
    const { applied } = await activateApplied(harness, candidate.candidateId);
    const pausePending = (
      await harness.service.requestImprovementPauseApproval(applied.activationId!, {
        requesterId: "operator-7",
      })
    ).pendingApproval!;
    approve(harness, pausePending.approvalId);
    await executeApproved(harness, pausePending.approvalId);

    const outcome = await harness.service.requestImprovementPauseApproval(applied.activationId!, {
      requesterId: "operator-7",
    });
    expect(outcome.pendingApproval).toBeNull();
    if (outcome.pendingApproval === null) {
      expect(outcome.noMutationRequired).toBe(true);
      expect(outcome.activation.status).toBe("paused");
    }
  });
});

function deriveOperationIdForApproval(harness: GovernedHarness, approvalId: string): string {
  const row = harness.storage.gatewaySql
    .prepare("SELECT operation_id FROM improvement_lifecycle_operations WHERE approval_id = ?")
    .get(approvalId) as { operation_id: string } | undefined;
  return row?.operation_id ?? "missing-operation";
}

async function createHarness(): Promise<Harness> {
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
    storage: createLocalAsyncStorage(storage),
    gatewaySql: storage.gatewaySql,
    publishRealtime: async (channel, topic, payload, realtimeOptions) => {
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
  await harness.service.initialize();
  harnesses.push(harness);
  return harness;
}
