import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoryOperatorSnapshot } from "./useMemoryOperatorSnapshot";

const apiMocks = vi.hoisted(() => ({
  acceptMemoryMaintenanceRecommendation: vi.fn(),
  addMemoryDecisionRetrospective: vi.fn(),
  batchMutateMemoryItems: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchMemoryDecisions: vi.fn(),
  fetchMemoryEntities: vi.fn(),
  fetchMemoryFeedback: vi.fn(),
  fetchMemoryFiles: vi.fn(),
  fetchMemoryItemHistory: vi.fn(),
  fetchMemoryItems: vi.fn(),
  fetchMemoryMaintenanceRecommendations: vi.fn(),
  fetchMemoryMaintenanceRunProvenance: vi.fn(),
  fetchMemoryMaintenanceRuns: vi.fn(),
  fetchMemoryMaintenanceStatus: vi.fn(),
  fetchMemoryQualityIssues: vi.fn(),
  fetchMemoryQmdStats: vi.fn(),
  fetchMemoryRetrievalStatus: vi.fn(),
  fetchMemoryRelations: vi.fn(),
  fetchTraceMemoryCandidates: vi.fn(),
  fetchSettings: vi.fn(),
  forgetMemoryItem: vi.fn(),
  patchMemoryItem: vi.fn(),
  patchMemoryMaintenancePolicy: vi.fn(),
  patchMemoryQualityIssue: vi.fn(),
  promoteTraceMemoryCandidate: vi.fn(),
  rejectMemoryMaintenanceRecommendation: vi.fn(),
  rejectTraceMemoryCandidate: vi.fn(),
  runMemoryMaintenanceNow: vi.fn(),
  runMemoryQualityScan: vi.fn(),
}));

vi.mock("../api/client", () => ({
  acceptMemoryMaintenanceRecommendation: apiMocks.acceptMemoryMaintenanceRecommendation,
  addMemoryDecisionRetrospective: apiMocks.addMemoryDecisionRetrospective,
  batchMutateMemoryItems: apiMocks.batchMutateMemoryItems,
  fetchDurableRun: apiMocks.fetchDurableRun,
  fetchDurableRunTimeline: apiMocks.fetchDurableRunTimeline,
  fetchMemoryDecisions: apiMocks.fetchMemoryDecisions,
  fetchMemoryEntities: apiMocks.fetchMemoryEntities,
  fetchMemoryFeedback: apiMocks.fetchMemoryFeedback,
  fetchMemoryFiles: apiMocks.fetchMemoryFiles,
  fetchMemoryItemHistory: apiMocks.fetchMemoryItemHistory,
  fetchMemoryItems: apiMocks.fetchMemoryItems,
  fetchMemoryMaintenanceRecommendations: apiMocks.fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance: apiMocks.fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns: apiMocks.fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus: apiMocks.fetchMemoryMaintenanceStatus,
  fetchMemoryQualityIssues: apiMocks.fetchMemoryQualityIssues,
  fetchMemoryQmdStats: apiMocks.fetchMemoryQmdStats,
  fetchMemoryRetrievalStatus: apiMocks.fetchMemoryRetrievalStatus,
  fetchMemoryRelations: apiMocks.fetchMemoryRelations,
  fetchTraceMemoryCandidates: apiMocks.fetchTraceMemoryCandidates,
  fetchSettings: apiMocks.fetchSettings,
  forgetMemoryItem: apiMocks.forgetMemoryItem,
  patchMemoryItem: apiMocks.patchMemoryItem,
  patchMemoryMaintenancePolicy: apiMocks.patchMemoryMaintenancePolicy,
  patchMemoryQualityIssue: apiMocks.patchMemoryQualityIssue,
  promoteTraceMemoryCandidate: apiMocks.promoteTraceMemoryCandidate,
  rejectMemoryMaintenanceRecommendation: apiMocks.rejectMemoryMaintenanceRecommendation,
  rejectTraceMemoryCandidate: apiMocks.rejectTraceMemoryCandidate,
  runMemoryMaintenanceNow: apiMocks.runMemoryMaintenanceNow,
  runMemoryQualityScan: apiMocks.runMemoryQualityScan,
}));

type HookValue = ReturnType<typeof useMemoryOperatorSnapshot>;

function Harness({ onValue }: { onValue: (value: HookValue) => void }) {
  const value = useMemoryOperatorSnapshot("default");
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mountHook(onValue: (value: HookValue) => void) {
  let mounted!: ReactTestRenderer;
  await act(async () => {
    mounted = create(<Harness onValue={onValue} />);
  });
  await flush();
  await flush();
  return mounted;
}

/** HX-402 P1: canonical pending memory.lifecycle approval envelope fixture. */
function buildPendingApprovalEnvelope(
  approvalId: string,
  action: "item_updated" | "items_forgotten" | "batch_mutated",
  itemIds: string[],
) {
  return {
    pendingApproval: {
      approvalId,
      status: "pending",
      kind: "memory.lifecycle" as const,
      action,
      subjectKind: itemIds.length === 1 ? ("memory_item" as const) : ("memory_item_batch" as const),
      subjectId: itemIds.length === 1 ? itemIds[0] : undefined,
      workspaceId: "default",
      requestSha256: "a".repeat(64),
      expectedStateSha256: "b".repeat(64),
      createdAt: "2026-04-22T00:05:00.000Z",
      replayed: false,
      itemIds,
    },
  };
}

describe("useMemoryOperatorSnapshot", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HookValue | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        memoryLifecycleAdminV1Enabled: true,
        memoryLifecycleAutoForgetEnabled: true,
        memoryMaintenanceV1Enabled: true,
        durableKernelV1Enabled: true,
      },
    });
    apiMocks.fetchMemoryFiles.mockResolvedValue({
      items: [{ relativePath: "memory/workspace/note.md", size: 1024, modifiedAt: "2026-04-22T00:00:00.000Z" }],
    });
    apiMocks.fetchMemoryQmdStats.mockResolvedValue({
      totalRuns: 4,
      generatedRuns: 4,
      cacheHitRuns: 0,
      fallbackRuns: 0,
      failedRuns: 0,
      originalTokenEstimate: 1000,
      distilledTokenEstimate: 700,
      savingsPercent: 30,
      netTokenDelta: -300,
      compressionPercent: 30,
      expansionPercent: 0,
      efficiencyLabel: "reduced",
      recent: [
        {
          contextId: "ctx-1",
          scope: "chat",
          createdAt: "2026-04-22T00:00:00.000Z",
          quality: { status: "ok" },
          citations: [],
        },
      ],
    });
    apiMocks.fetchMemoryRetrievalStatus.mockResolvedValue({
      checkedAt: "2026-04-22T00:00:00.000Z",
      enabled: true,
      retrievalMode: "hybrid_rank",
      rerankAvailable: true,
      rerankMode: "hybrid_rank",
      fallbackMode: "available",
      lastRefresh: "2026-04-22T00:00:00.000Z",
      qmd: {
        enabled: true,
        applyToChat: true,
        applyToOrchestration: true,
        minPromptChars: 8,
        cacheTtlSeconds: 300,
        distillerTimeoutMs: 12_000,
      },
      recent: {
        totalRuns: 4,
        generatedRuns: 4,
        cacheHitRuns: 0,
        fallbackRuns: 0,
        failedRuns: 0,
        retrievalStrategies: ["hybrid_rank"],
      },
    });
    apiMocks.fetchMemoryItems.mockResolvedValue({
      items: [
        {
          itemId: "mem-1",
          namespace: "workspace.alpha",
          title: "Deployment note",
          content: "Ship after verification.",
          pinned: true,
          status: "active",
          lifecycleState: "active",
          updatedAt: "2026-04-22T00:00:00.000Z",
          ttlOverrideSeconds: 3600,
          expiresAt: "2026-04-23T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryEntities.mockResolvedValue({
      items: [
        {
          id: "entity-1",
          workspaceId: "default",
          scope: "workspace",
          title: "Project Alpha",
          entityType: "project",
          aliases: [],
          status: "active",
          confidence: 0.9,
          sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
          metadata: {},
          authority: "operator",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryRelations.mockResolvedValue({
      items: [
        {
          id: "relation-1",
          workspaceId: "default",
          scope: "workspace",
          title: "Project Alpha uses Automation Designer",
          fromEntityId: "entity-1",
          toEntityId: "entity-2",
          relationType: "uses",
          status: "active",
          confidence: 0.8,
          sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
          metadata: {},
          authority: "operator",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryDecisions.mockResolvedValue({
      items: [
        {
          id: "decision-1",
          workspaceId: "default",
          scope: "workspace",
          title: "Keep automation advisory",
          decision: "Draft automation recipes before cron creation.",
          alternatives: [],
          rationale: "Proof first.",
          linkedEntityIds: ["entity-1"],
          linkedRelationIds: ["relation-1"],
          status: "active",
          confidence: 0.75,
          sourceRefs: [{ sourceType: "manual", sourceRef: "operator" }],
          metadata: {},
          authority: "operator",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryFeedback.mockResolvedValue({
      items: [
        {
          id: "feedback-1",
          workspaceId: "default",
          kind: "useful",
          targetKind: "item",
          targetId: "mem-1",
          status: "open",
          note: "Kept deployment context precise.",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryQualityIssues.mockResolvedValue({
      items: [
        {
          issueId: "quality-1",
          workspaceId: "default",
          kind: "source_drift",
          status: "open",
          severity: "high",
          targetKind: "learning",
          targetRef: "learning-1",
          relatedRefs: [],
          evidenceRefs: [{ sourceType: "artifact", sourceRef: "docs/plan.md", title: "Learning staleness check" }],
          summary: "Referenced file docs/plan.md changed since the learning was recorded.",
          rationale: "Learning staleness checks compare recorded source refs.",
          metadata: {},
          dedupKey: "default|source_drift|learning|learning-1|changed_hash",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchTraceMemoryCandidates.mockResolvedValue({
      items: [
        {
          id: "candidate-1",
          workspaceId: "default",
          status: "proposed",
          sourceKind: "session",
          sourceRef: "session-1",
          summary: "Deployment requires verification before release.",
          confidence: 0.82,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryItemHistory.mockResolvedValue({
      items: [
        { changeId: "chg-1", changeType: "updated", createdAt: "2026-04-22T00:00:00.000Z", actorId: "operator:test" },
      ],
    });
    apiMocks.fetchMemoryMaintenanceStatus.mockResolvedValue({
      workspaceId: "default",
      policy: {
        workspaceId: "default",
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        timeZone: "America/Los_Angeles",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 1,
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
      state: {
        workspaceId: "default",
        changedSessionCount: 2,
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
      nextDueAt: "2026-04-23T00:00:00.000Z",
      lastRun: { runId: "run-1", status: "completed", updatedAt: "2026-04-22T00:10:00.000Z" },
    });
    apiMocks.fetchMemoryMaintenanceRuns.mockResolvedValue({
      items: [
        {
          runId: "run-1",
          durableRunId: "durable-1",
          workspaceId: "default",
          triggerSource: "manual",
          status: "completed",
          policySnapshot: {},
          sourceSessionCount: 1,
          changedArtifactCount: 1,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:10:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceRecommendations.mockResolvedValue({
      items: [
        {
          recommendationId: "rec-1",
          workspaceId: "default",
          kind: "policy_tuning",
          status: "queued",
          summary: "Tighten cadence for fresh context.",
          proposedPatch: {},
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceRunProvenance.mockResolvedValue({
      run: { runId: "run-1" },
      sources: [],
      changes: [],
    });
    apiMocks.fetchDurableRun.mockResolvedValue({ runId: "durable-1", status: "completed" });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({ items: [] });
    // HX-402 P1: mutation verbs answer with pending memory.lifecycle
    // approval envelopes — never with an executed mutation.
    apiMocks.patchMemoryItem.mockResolvedValue(
      buildPendingApprovalEnvelope("approval-patch-1", "item_updated", ["mem-1"]),
    );
    apiMocks.forgetMemoryItem.mockResolvedValue(
      buildPendingApprovalEnvelope("approval-forget-1", "items_forgotten", ["mem-1"]),
    );
    apiMocks.batchMutateMemoryItems.mockResolvedValue(
      buildPendingApprovalEnvelope("approval-batch-1", "batch_mutated", ["mem-1", "mem-2"]),
    );
    apiMocks.runMemoryMaintenanceNow.mockResolvedValue({ queued: true, runId: "run-queued" });
    apiMocks.runMemoryQualityScan.mockResolvedValue({
      generatedAt: "2026-04-22T00:00:00.000Z",
      workspaceId: "default",
      scannedCount: 3,
      issueCount: 1,
      createdCount: 1,
      updatedCount: 0,
      dryRun: false,
      issues: [],
      warnings: [],
    });
    apiMocks.patchMemoryQualityIssue.mockResolvedValue({
      issueId: "quality-1",
      workspaceId: "default",
      kind: "source_drift",
      status: "resolved",
      severity: "high",
      targetKind: "learning",
      targetRef: "learning-1",
      relatedRefs: [],
      evidenceRefs: [],
      summary: "Referenced file docs/plan.md changed since the learning was recorded.",
      metadata: {},
      dedupKey: "default|source_drift|learning|learning-1|changed_hash",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:05:00.000Z",
      resolvedAt: "2026-04-22T00:05:00.000Z",
      resolutionNote: "Resolved from test.",
    });
    apiMocks.patchMemoryMaintenancePolicy.mockResolvedValue({
      workspaceId: "default",
      enabled: true,
      runMode: "manual",
      timingStrategy: "fixed",
      timeZone: "America/Los_Angeles",
      minHoursSinceLastSuccess: 24,
      minChangedSessions: 1,
      executionTarget: "auto",
      unavailableModelPolicy: "skip",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:07:00.000Z",
    });
    apiMocks.acceptMemoryMaintenanceRecommendation.mockResolvedValue(undefined);
    apiMocks.rejectMemoryMaintenanceRecommendation.mockResolvedValue(undefined);
    apiMocks.promoteTraceMemoryCandidate.mockResolvedValue({ candidateId: "candidate-1", status: "promoted" });
    apiMocks.rejectTraceMemoryCandidate.mockResolvedValue({ candidateId: "candidate-1", status: "rejected" });
    apiMocks.addMemoryDecisionRetrospective.mockResolvedValue({
      id: "decision-1",
      title: "Keep automation advisory",
      retrospective: { outcome: "unknown", notes: "Review recorded.", reviewedAt: "2026-04-22T00:00:00.000Z" },
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads lifecycle-aware memory truth and selects the first item and run", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.selectedItem?.itemId).toBe("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("active");
    expect(latest?.selectedRun?.runId).toBe("run-1");
    expect(latest?.data?.selectedDurableRun?.status).toBe("completed");
    expect(latest?.data?.memoryEntities.map((item) => item.title)).toEqual(["Project Alpha"]);
    expect(latest?.data?.memoryRelations.map((item) => item.relationType)).toEqual(["uses"]);
    expect(latest?.data?.memoryDecisions.map((item) => item.title)).toEqual(["Keep automation advisory"]);
    expect(latest?.data?.memoryFeedback.map((item) => item.kind)).toEqual(["useful"]);
    expect(latest?.data?.memoryQualityIssues.map((item) => item.kind)).toEqual(["source_drift"]);
    expect(latest?.data?.traceMemoryCandidates.map((item) => item.status)).toEqual(["proposed"]);
    expect(latest?.data?.memoryRetrievalStatus?.retrievalMode).toBe("hybrid_rank");
    expect(latest?.data?.memoryRetrievalStatus?.fallbackMode).toBe("available");
    expect(latest?.data?.memoryAdminState).toBe("enabled");
    expect(latest?.policyDraft?.timeZone).toBe("America/Los_Angeles");
    expect(apiMocks.fetchMemoryItems).toHaveBeenCalledWith({ workspaceId: "default", limit: 200, status: "all" });
    expect(apiMocks.fetchMemoryEntities).toHaveBeenCalledWith({ workspaceId: "default", status: "all", limit: 80 });
    expect(apiMocks.fetchMemoryRelations).toHaveBeenCalledWith({ workspaceId: "default", status: "all", limit: 80 });
    expect(apiMocks.fetchMemoryDecisions).toHaveBeenCalledWith({
      workspaceId: "default",
      status: "all",
      limit: 80,
    });
    expect(apiMocks.fetchMemoryQualityIssues).toHaveBeenCalledWith({
      workspaceId: "default",
      status: "all",
      limit: 40,
    });
    expect(apiMocks.fetchMemoryItemHistory).toHaveBeenCalledWith("mem-1", 100);
  });

  it("promotes and rejects trace candidates only through the operator review APIs", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    await act(async () => {
      await latest?.resolveTraceMemoryCandidate("candidate-1", "promote");
    });
    expect(apiMocks.promoteTraceMemoryCandidate).toHaveBeenCalledWith("candidate-1");
    expect(apiMocks.rejectTraceMemoryCandidate).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({ tone: "success", message: "Trace candidate promoted by operator." });

    await act(async () => {
      await latest?.resolveTraceMemoryCandidate("candidate-1", "reject");
    });
    expect(apiMocks.rejectTraceMemoryCandidate).toHaveBeenCalledWith("candidate-1");
    expect(latest?.notice).toEqual({ tone: "success", message: "Trace candidate rejected." });
  });

  it("fails closed when settings truth cannot be loaded", async () => {
    apiMocks.fetchSettings.mockRejectedValue(new Error("settings unavailable"));

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.data?.memoryAdminState).toBe("unknown");
    expect(latest?.data?.memoryAdminEnabled).toBe(false);
    expect(latest?.data?.memoryItems).toEqual([]);
    expect(latest?.data?.maintenanceEnabled).toBe(false);
    expect(latest?.data?.sectionErrors.settings).toBe("settings unavailable");
    expect(apiMocks.fetchMemoryItems).not.toHaveBeenCalled();
    expect(apiMocks.fetchMemoryQualityIssues).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.saveItemPatch("mem-1", { title: "Should not save" });
    });

    expect(apiMocks.patchMemoryItem).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({
      tone: "warning",
      message: "Memory admin settings are not confirmed, so item changes are locked.",
    });
  });

  it("requests item mutation approvals honestly without pretending anything changed", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    await act(async () => {
      await latest?.saveItemPatch("mem-1", {
        title: "Updated note",
        ttlOverrideSeconds: 120,
      });
    });
    await flush();

    expect(apiMocks.patchMemoryItem).toHaveBeenCalledWith("mem-1", {
      title: "Updated note",
      ttlOverrideSeconds: 120,
    });
    // HX-402 P1: the verb only REQUESTS an approval. The snapshot keeps the
    // original truth and the pending approval is tracked explicitly.
    expect(latest?.selectedItem?.title).toBe("Deployment note");
    expect(latest?.notice?.tone).toBe("info");
    expect(latest?.notice?.message).toContain("requires approval approval-patch-1");
    expect(latest?.pendingMutationApprovals.map((pending) => pending.approvalId)).toContain("approval-patch-1");

    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    await flush();

    expect(apiMocks.forgetMemoryItem).toHaveBeenCalledWith("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("active");
    expect(latest?.notice?.tone).toBe("info");
    expect(latest?.notice?.message).toContain("requires approval approval-forget-1");
    expect(latest?.pendingMutationApprovals.map((pending) => pending.approvalId)).toContain("approval-forget-1");

    // Pending approvals are dismissible.
    await act(async () => {
      latest?.dismissPendingMutationApproval("approval-forget-1");
    });
    expect(latest?.pendingMutationApprovals.map((pending) => pending.approvalId)).not.toContain("approval-forget-1");

    await act(async () => {
      await latest?.runMaintenance();
    });
    await flush();
    expect(apiMocks.runMemoryMaintenanceNow).toHaveBeenCalledWith({ workspaceId: "default", triggerSource: "manual" });
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory maintenance queued." });

    await act(async () => {
      await latest?.scanMemoryQuality();
    });
    await flush();
    expect(apiMocks.runMemoryQualityScan).toHaveBeenCalledWith({ workspaceId: "default" });
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory quality scan recorded 1 issue." });

    await act(async () => {
      await latest?.patchQualityIssue("quality-1", "resolved", "Resolved from test.");
    });
    await flush();
    expect(apiMocks.patchMemoryQualityIssue).toHaveBeenCalledWith("quality-1", {
      status: "resolved",
      resolutionNote: "Resolved from test.",
    });
    expect(latest?.data?.memoryQualityIssues[0]?.status).toBe("resolved");
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory quality issue resolved." });

    await act(async () => {
      latest?.setPolicyDraft({
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        timeZone: "America/Los_Angeles",
        minHoursSinceLastSuccess: 48,
        minChangedSessions: 2,
        providerId: "",
        model: "",
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        scheduleEnabled: false,
        scheduleFrequency: "daily",
        scheduleHour: 9,
        scheduleMinute: 0,
        scheduleWeekday: 1,
      });
    });
    await act(async () => {
      await latest?.savePolicy();
    });
    await flush();
    expect(apiMocks.patchMemoryMaintenancePolicy).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ minHoursSinceLastSuccess: 48, minChangedSessions: 2 }),
    );
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory maintenance policy saved." });
  });

  it("routes an atomic batch forget through one pending batch approval", async () => {
    apiMocks.fetchMemoryItems.mockResolvedValueOnce({
      items: [
        {
          itemId: "mem-1",
          namespace: "workspace.alpha",
          title: "Deployment note",
          content: "Ship after verification.",
          pinned: false,
          status: "active",
          lifecycleState: "active",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
        {
          itemId: "mem-2",
          namespace: "workspace.alpha",
          title: "Rollback plan",
          content: "Roll back if errors spike.",
          pinned: false,
          status: "active",
          lifecycleState: "active",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      ],
    });
    apiMocks.batchMutateMemoryItems.mockResolvedValueOnce(
      buildPendingApprovalEnvelope("approval-batch-forget", "batch_mutated", ["mem-1", "mem-2"]),
    );

    renderer = await mountHook((value) => {
      latest = value;
    });

    let response: Awaited<ReturnType<HookValue["batchForgetItems"]>> | undefined;
    await act(async () => {
      response = await latest?.batchForgetItems(["mem-1", "mem-2"]);
    });
    await flush();

    expect(apiMocks.batchMutateMemoryItems).toHaveBeenCalledTimes(1);
    expect(apiMocks.batchMutateMemoryItems).toHaveBeenCalledWith({
      source: "mission-control:library",
      operations: [
        { kind: "forget_item", itemId: "mem-1" },
        { kind: "forget_item", itemId: "mem-2" },
      ],
    });
    // The envelope resolves truthy so the page clears its selection, while the
    // items themselves stay untouched until the approval executes.
    expect(response?.pendingApproval.approvalId).toBe("approval-batch-forget");
    expect(latest?.data?.memoryItems.find((item) => item.itemId === "mem-1")?.lifecycleState).toBe("active");
    expect(latest?.data?.memoryItems.find((item) => item.itemId === "mem-2")?.lifecycleState).toBe("active");
    expect(latest?.notice?.tone).toBe("info");
    expect(latest?.notice?.message).toContain("requires approval approval-batch-forget");
    expect(latest?.pendingMutationApprovals.map((pending) => pending.approvalId)).toContain("approval-batch-forget");
  });

  it("reports the request failure truthfully when the batch approval request fails", async () => {
    apiMocks.batchMutateMemoryItems.mockRejectedValueOnce(new Error("network blip"));

    renderer = await mountHook((value) => {
      latest = value;
    });

    const beforeItems = latest?.data?.memoryItems;

    let response: Awaited<ReturnType<HookValue["batchForgetItems"]>> | undefined;
    await act(async () => {
      response = await latest?.batchForgetItems(["mem-1"]);
    });
    await flush();

    expect(response).toBeUndefined();
    expect(latest?.notice).toEqual({
      tone: "error",
      message: "Batch request failed — no changes were applied. network blip",
    });
    expect(latest?.data?.memoryItems).toEqual(beforeItems);
    expect(latest?.pendingMutationApprovals).toEqual([]);
  });

  it("surfaces the transactional-storage conflict message", async () => {
    const conflictMessage = "Batch mutation conflicts with a concurrent write on mem-1; no changes were committed.";
    apiMocks.batchMutateMemoryItems.mockRejectedValueOnce(new Error(conflictMessage));

    renderer = await mountHook((value) => {
      latest = value;
    });

    await act(async () => {
      await latest?.batchForgetItems(["mem-1"]);
    });
    await flush();

    expect(latest?.notice).toEqual({
      tone: "error",
      message: `Batch request failed — no changes were applied. ${conflictMessage}`,
    });
  });

  it("locks batch mutations when memory admin is not enabled", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        memoryLifecycleAdminV1Enabled: false,
        memoryLifecycleAutoForgetEnabled: false,
        memoryMaintenanceV1Enabled: false,
        durableKernelV1Enabled: false,
      },
    });

    renderer = await mountHook((value) => {
      latest = value;
    });

    await act(async () => {
      await latest?.batchForgetItems(["mem-1"]);
    });
    expect(apiMocks.batchMutateMemoryItems).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({
      tone: "warning",
      message: "Memory admin settings are not confirmed, so item changes are locked.",
    });

    await act(async () => {
      await latest?.batchSetItemsPinned(["mem-1"], true);
    });
    expect(apiMocks.batchMutateMemoryItems).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({
      tone: "warning",
      message: "Memory admin settings are not confirmed, so item changes are locked.",
    });
  });

  it("refuses batches over 100 operations client-side", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    const itemIds = Array.from({ length: 101 }, (_, index) => `mem-${index}`);

    let response: Awaited<ReturnType<HookValue["batchForgetItems"]>> | undefined;
    await act(async () => {
      response = await latest?.batchForgetItems(itemIds);
    });

    expect(response).toBeUndefined();
    expect(apiMocks.batchMutateMemoryItems).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({
      tone: "error",
      message: "Batch actions are limited to 100 items at a time.",
    });
  });

  it("routes patch_item pin operations through one pending batch approval", async () => {
    apiMocks.batchMutateMemoryItems.mockResolvedValueOnce(
      buildPendingApprovalEnvelope("approval-batch-pin", "batch_mutated", ["mem-1", "mem-2"]),
    );

    renderer = await mountHook((value) => {
      latest = value;
    });
    const beforeItems = latest?.data?.memoryItems;

    let response: Awaited<ReturnType<HookValue["batchSetItemsPinned"]>> | undefined;
    await act(async () => {
      response = await latest?.batchSetItemsPinned(["mem-1", "mem-2"], true);
    });
    await flush();

    expect(apiMocks.batchMutateMemoryItems).toHaveBeenCalledWith({
      source: "mission-control:library",
      operations: [
        { kind: "patch_item", itemId: "mem-1", patch: { pinned: true } },
        { kind: "patch_item", itemId: "mem-2", patch: { pinned: true } },
      ],
    });
    expect(response?.pendingApproval.approvalId).toBe("approval-batch-pin");
    // Nothing changes until the approval executes.
    expect(latest?.data?.memoryItems).toEqual(beforeItems);
    expect(latest?.notice?.tone).toBe("info");
    expect(latest?.notice?.message).toContain("requires approval approval-batch-pin");
  });

  it("records decision retrospectives through the memory lifecycle API", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    await act(async () => {
      await latest?.reviewDecision("decision-1");
    });
    await flush();

    expect(apiMocks.addMemoryDecisionRetrospective).toHaveBeenCalledWith("decision-1", {
      outcome: "unknown",
      notes: "Reviewed from Mission Control Next Library memory panel.",
    });
    expect(latest?.notice).toEqual({ tone: "success", message: "Decision retrospective recorded." });
  });

  it("records optional section errors without disabling the whole snapshot", async () => {
    apiMocks.fetchMemoryFiles.mockRejectedValue(new Error("files unavailable"));
    apiMocks.fetchMemoryQmdStats.mockRejectedValue("qmd unavailable");
    apiMocks.fetchMemoryRetrievalStatus.mockRejectedValue(new Error("retrieval status unavailable"));
    apiMocks.fetchMemoryItemHistory.mockRejectedValue(new Error("history unavailable"));
    apiMocks.fetchMemoryMaintenanceStatus.mockRejectedValue(new Error("status unavailable"));
    apiMocks.fetchMemoryMaintenanceRecommendations.mockRejectedValue(new Error("recommendations unavailable"));
    apiMocks.fetchMemoryFeedback.mockRejectedValue(new Error("feedback unavailable"));
    apiMocks.fetchMemoryQualityIssues.mockRejectedValue(new Error("quality unavailable"));
    apiMocks.fetchTraceMemoryCandidates.mockRejectedValue(new Error("trace unavailable"));
    apiMocks.fetchMemoryMaintenanceRunProvenance.mockRejectedValue(new Error("provenance unavailable"));
    apiMocks.fetchDurableRun.mockRejectedValue(new Error("durable unavailable"));
    apiMocks.fetchDurableRunTimeline.mockRejectedValue(new Error("timeline unavailable"));

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.data?.sectionErrors.files).toBe("files unavailable");
    expect(latest?.data?.sectionErrors.qmdStats).toBe("Something went wrong.");
    expect(latest?.data?.sectionErrors.memoryRetrievalStatus).toBe("retrieval status unavailable");
    expect(latest?.data?.memoryRetrievalStatus).toBeNull();
    expect(latest?.data?.sectionErrors.memoryHistory).toBe("history unavailable");
    expect(latest?.data?.sectionErrors.maintenanceStatus).toBe("status unavailable");
    expect(latest?.data?.sectionErrors.maintenanceRecommendations).toBe("recommendations unavailable");
    expect(latest?.data?.sectionErrors.memoryFeedback).toBe("feedback unavailable");
    expect(latest?.data?.sectionErrors.memoryQualityIssues).toBe("quality unavailable");
    expect(latest?.data?.sectionErrors.traceMemoryCandidates).toBe("trace unavailable");
    expect(latest?.data?.sectionErrors.selectedRunProvenance).toBe("provenance unavailable");
    expect(latest?.data?.sectionErrors.selectedDurableRun).toBe("durable unavailable");
    expect(latest?.data?.sectionErrors.selectedDurableTimeline).toBe("timeline unavailable");

    await act(async () => {
      latest?.setSelectedRunId("missing-run");
    });
    await flush();
    expect(latest?.data?.selectedRunProvenance).toBeNull();
    expect(latest?.data?.selectedDurableRun).toBeNull();
    expect(latest?.data?.selectedDurableTimeline).toEqual([]);

    await act(async () => {
      latest?.setSelectedItemId(null);
    });
    await flush();
    expect(latest?.data?.memoryHistory).toEqual([]);
  });

  it("records memory item and maintenance run load failures independently", async () => {
    apiMocks.fetchMemoryItems.mockRejectedValue(new Error("items unavailable"));
    apiMocks.fetchMemoryMaintenanceRuns.mockRejectedValue(new Error("runs unavailable"));

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.data?.sectionErrors.memoryItems).toBe("items unavailable");
    expect(latest?.data?.sectionErrors.maintenanceRuns).toBe("runs unavailable");
    expect(latest?.data?.memoryItems).toEqual([]);
    expect(latest?.data?.maintenanceRuns).toEqual([]);
    expect(latest?.selectedItem).toBeNull();
    expect(latest?.selectedRun).toBeNull();
  });

  it("surfaces invalid settings truth from the initial load effect", async () => {
    apiMocks.fetchSettings.mockResolvedValueOnce({});

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toContain("memoryLifecycleAdminV1Enabled");
  });

  it("handles maintenance runs without durable linkage and no-op item or policy actions", async () => {
    apiMocks.fetchMemoryItems.mockResolvedValue({ items: [] });
    apiMocks.fetchMemoryMaintenanceRuns.mockResolvedValue({
      items: [
        {
          runId: "run-no-durable",
          workspaceId: "default",
          triggerSource: "manual",
          status: "completed",
          policySnapshot: {},
          sourceSessionCount: 1,
          changedArtifactCount: 1,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:10:00.000Z",
        },
      ],
    });

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.selectedItem).toBeNull();
    expect(latest?.selectedRun?.runId).toBe("run-no-durable");
    expect(latest?.data?.selectedDurableRun).toBeNull();
    expect(latest?.data?.selectedDurableTimeline).toEqual([]);
    expect(apiMocks.fetchDurableRun).not.toHaveBeenCalled();
    expect(apiMocks.fetchDurableRunTimeline).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    expect(apiMocks.forgetMemoryItem).not.toHaveBeenCalled();

    await act(async () => {
      latest?.setPolicyDraft(null);
    });
    await act(async () => {
      await latest?.savePolicy();
    });
    expect(apiMocks.patchMemoryMaintenancePolicy).not.toHaveBeenCalled();
  });

  it("locks admin and maintenance actions when feature truth is disabled", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        memoryLifecycleAdminV1Enabled: false,
        memoryLifecycleAutoForgetEnabled: false,
        memoryMaintenanceV1Enabled: false,
        durableKernelV1Enabled: false,
      },
    });

    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.data?.memoryAdminState).toBe("disabled");
    expect(apiMocks.fetchMemoryItems).not.toHaveBeenCalled();
    expect(apiMocks.fetchMemoryMaintenanceStatus).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.saveItemPatch("mem-1", { title: "Locked" });
    });
    expect(apiMocks.patchMemoryItem).not.toHaveBeenCalled();
    expect(latest?.notice?.message).toContain("item changes are locked");

    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    expect(apiMocks.forgetMemoryItem).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.runMaintenance();
    });
    expect(apiMocks.runMemoryMaintenanceNow).not.toHaveBeenCalled();
    expect(latest?.notice?.message).toContain("maintenance actions are locked");

    await act(async () => {
      latest?.setPolicyDraft({
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        timeZone: "America/Los_Angeles",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 1,
        providerId: "",
        model: "",
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        scheduleEnabled: false,
        scheduleFrequency: "daily",
        scheduleHour: 9,
        scheduleMinute: 0,
        scheduleWeekday: 1,
      });
    });
    await act(async () => {
      await latest?.savePolicy();
    });
    expect(apiMocks.patchMemoryMaintenancePolicy).not.toHaveBeenCalled();
    expect(latest?.notice?.message).toContain("policy changes are locked");

    await act(async () => {
      await latest?.resolveRecommendation("rec-1", "accept");
    });
    expect(apiMocks.acceptMemoryMaintenanceRecommendation).not.toHaveBeenCalled();
    expect(latest?.notice?.message).toContain("recommendations are locked");
  });

  it("surfaces action failures and resolves maintenance recommendations", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    apiMocks.fetchSettings.mockResolvedValueOnce({});
    await act(async () => {
      await latest?.reload();
    });
    expect(latest?.error).toContain("memoryLifecycleAdminV1Enabled");

    apiMocks.patchMemoryItem.mockRejectedValueOnce(new Error("patch failed"));
    await act(async () => {
      await latest?.saveItemPatch("mem-1", { title: "Broken patch" });
    });
    expect(latest?.notice).toEqual({ tone: "error", message: "patch failed" });

    apiMocks.forgetMemoryItem.mockRejectedValueOnce("forget failed");
    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    expect(latest?.notice).toEqual({ tone: "error", message: "Something went wrong." });

    apiMocks.runMemoryMaintenanceNow.mockRejectedValueOnce(new Error("run failed"));
    await act(async () => {
      await latest?.runMaintenance();
    });
    expect(latest?.notice).toEqual({ tone: "error", message: "run failed" });

    apiMocks.patchMemoryMaintenancePolicy.mockRejectedValueOnce(new Error("policy failed"));
    await act(async () => {
      await latest?.savePolicy();
    });
    expect(latest?.notice).toEqual({ tone: "error", message: "policy failed" });

    apiMocks.acceptMemoryMaintenanceRecommendation.mockRejectedValueOnce(new Error("accept failed"));
    await act(async () => {
      await latest?.resolveRecommendation("rec-1", "accept");
    });
    expect(latest?.notice).toEqual({ tone: "error", message: "accept failed" });

    await act(async () => {
      await latest?.resolveRecommendation("rec-1", "accept");
    });
    expect(apiMocks.acceptMemoryMaintenanceRecommendation).toHaveBeenCalledWith("rec-1");
    expect(latest?.notice).toEqual({ tone: "success", message: "Recommendation accepted." });

    await act(async () => {
      await latest?.resolveRecommendation("rec-1", "reject");
    });
    expect(apiMocks.rejectMemoryMaintenanceRecommendation).toHaveBeenCalledWith("rec-1");
    expect(latest?.notice).toEqual({ tone: "success", message: "Recommendation rejected." });
  });

  it("ignores late initial load and selected-detail completions after unmount", async () => {
    const settings = deferred<Awaited<ReturnType<typeof apiMocks.fetchSettings>>>();
    apiMocks.fetchSettings.mockReturnValueOnce(settings.promise);

    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });
    await act(async () => {
      renderer?.unmount();
    });
    settings.resolve({
      features: {
        memoryLifecycleAdminV1Enabled: true,
        memoryLifecycleAutoForgetEnabled: true,
        memoryMaintenanceV1Enabled: true,
        durableKernelV1Enabled: true,
      },
    });
    await flush();

    const provenance = deferred<{ run: { runId: string }; sources: never[]; changes: never[] }>();
    apiMocks.fetchMemoryMaintenanceRunProvenance.mockReturnValueOnce(provenance.promise);
    renderer = await mountHook((value) => {
      latest = value;
    });
    await act(async () => {
      renderer?.unmount();
    });
    provenance.resolve({ run: { runId: "run-1" }, sources: [], changes: [] });
    await flush();
  });

  it("ignores late memory-history success and failure completions after selection changes", async () => {
    renderer = await mountHook((value) => {
      latest = value;
    });

    const historySuccess = deferred<{ items: never[] }>();
    apiMocks.fetchMemoryItemHistory.mockReturnValueOnce(historySuccess.promise);
    await act(async () => {
      latest?.setSelectedItemId("mem-late-success");
    });
    await act(async () => {
      latest?.setSelectedItemId(null);
    });
    historySuccess.resolve({ items: [] });
    await flush();

    const historyFailure = deferred<{ items: never[] }>();
    apiMocks.fetchMemoryItemHistory.mockReturnValueOnce(historyFailure.promise);
    await act(async () => {
      latest?.setSelectedItemId("mem-late-failure");
    });
    await act(async () => {
      latest?.setSelectedItemId(null);
    });
    historyFailure.reject(new Error("late history failed"));
    await flush();
  });

  it("does not refetch selected-run detail when a poll returns a contents-equal runs array", async () => {
    // reload() (refresh-bus signal / 15s poll) rebuilds `maintenanceRuns` as a brand-new
    // array even when its contents are unchanged. The detail effect must key on the
    // selected run's stable ids, not the array reference, so an unchanged run on a poll
    // does NOT re-issue the provenance/durable-run/timeline fetches -- while a genuinely
    // different selected run still does.
    const buildRuns = () => ({
      items: [
        {
          runId: "run-1",
          durableRunId: "durable-1",
          workspaceId: "default",
          triggerSource: "manual" as const,
          status: "completed" as const,
          policySnapshot: {},
          sourceSessionCount: 1,
          changedArtifactCount: 1,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:10:00.000Z",
        },
        {
          runId: "run-2",
          durableRunId: "durable-2",
          workspaceId: "default",
          triggerSource: "manual" as const,
          status: "completed" as const,
          policySnapshot: {},
          sourceSessionCount: 2,
          changedArtifactCount: 2,
          createdAt: "2026-04-22T00:01:00.000Z",
          updatedAt: "2026-04-22T00:11:00.000Z",
        },
      ],
    });
    // A fresh array (new references) with identical contents on every call -- exactly
    // what the real reload path produces.
    apiMocks.fetchMemoryMaintenanceRuns.mockImplementation(async () => buildRuns());

    renderer = await mountHook((value) => {
      latest = value;
    });

    // Initial selection is the first run; the detail effect fired exactly once.
    expect(latest?.selectedRun?.runId).toBe("run-1");
    expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenLastCalledWith("run-1");
    expect(apiMocks.fetchDurableRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchDurableRun).toHaveBeenLastCalledWith("durable-1");
    expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledTimes(1);

    // Poll: reload() rebuilds maintenanceRuns as a NEW array with equal contents and the
    // same selected run. The detail effect must NOT re-fire (RED before the id-keying fix:
    // the array-reference dependency re-issued all three fetches here).
    await act(async () => {
      await latest?.reload();
    });
    await flush();

    expect(latest?.selectedRun?.runId).toBe("run-1");
    expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchDurableRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledTimes(1);

    // A genuinely different selected run must still trigger a fresh detail fetch.
    await act(async () => {
      latest?.setSelectedRunId("run-2");
    });
    await flush();

    expect(latest?.selectedRun?.runId).toBe("run-2");
    expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenLastCalledWith("run-2");
    expect(apiMocks.fetchDurableRun).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchDurableRun).toHaveBeenLastCalledWith("durable-2");
    expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledTimes(2);
  });
});
