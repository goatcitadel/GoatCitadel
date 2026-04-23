import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoryOperatorSnapshot } from "./useMemoryOperatorSnapshot";

const apiMocks = vi.hoisted(() => ({
  acceptMemoryMaintenanceRecommendation: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchMemoryFiles: vi.fn(),
  fetchMemoryItemHistory: vi.fn(),
  fetchMemoryItems: vi.fn(),
  fetchMemoryMaintenanceRecommendations: vi.fn(),
  fetchMemoryMaintenanceRunProvenance: vi.fn(),
  fetchMemoryMaintenanceRuns: vi.fn(),
  fetchMemoryMaintenanceStatus: vi.fn(),
  fetchMemoryQmdStats: vi.fn(),
  fetchSettings: vi.fn(),
  forgetMemoryItem: vi.fn(),
  patchMemoryItem: vi.fn(),
  patchMemoryMaintenancePolicy: vi.fn(),
  rejectMemoryMaintenanceRecommendation: vi.fn(),
  runMemoryMaintenanceNow: vi.fn(),
}));

vi.mock("../api/client", () => ({
  acceptMemoryMaintenanceRecommendation: apiMocks.acceptMemoryMaintenanceRecommendation,
  fetchDurableRun: apiMocks.fetchDurableRun,
  fetchDurableRunTimeline: apiMocks.fetchDurableRunTimeline,
  fetchMemoryFiles: apiMocks.fetchMemoryFiles,
  fetchMemoryItemHistory: apiMocks.fetchMemoryItemHistory,
  fetchMemoryItems: apiMocks.fetchMemoryItems,
  fetchMemoryMaintenanceRecommendations: apiMocks.fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance: apiMocks.fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns: apiMocks.fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus: apiMocks.fetchMemoryMaintenanceStatus,
  fetchMemoryQmdStats: apiMocks.fetchMemoryQmdStats,
  fetchSettings: apiMocks.fetchSettings,
  forgetMemoryItem: apiMocks.forgetMemoryItem,
  patchMemoryItem: apiMocks.patchMemoryItem,
  patchMemoryMaintenancePolicy: apiMocks.patchMemoryMaintenancePolicy,
  rejectMemoryMaintenanceRecommendation: apiMocks.rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow: apiMocks.runMemoryMaintenanceNow,
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

describe("useMemoryOperatorSnapshot", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HookValue | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        memoryLifecycleAdminV1Enabled: true,
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
    apiMocks.patchMemoryItem.mockImplementation(async (_itemId, patch) => ({
      itemId: "mem-1",
      namespace: "workspace.alpha",
      title: patch.title ?? "Deployment note",
      content: patch.content ?? "Ship after verification.",
      pinned: patch.pinned ?? true,
      status: "active",
      lifecycleState: "active",
      updatedAt: "2026-04-22T00:05:00.000Z",
      ttlOverrideSeconds: patch.ttlOverrideSeconds ?? 3600,
      expiresAt: "2026-04-23T00:05:00.000Z",
    }));
    apiMocks.forgetMemoryItem.mockResolvedValue({
      itemId: "mem-1",
      namespace: "workspace.alpha",
      title: "Deployment note",
      content: "Ship after verification.",
      pinned: false,
      status: "forgotten",
      lifecycleState: "forgotten",
      updatedAt: "2026-04-22T00:06:00.000Z",
      ttlOverrideSeconds: null,
      expiresAt: null,
    });
    apiMocks.runMemoryMaintenanceNow.mockResolvedValue({ queued: true, runId: "run-queued" });
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
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads lifecycle-aware memory truth and selects the first item and run", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();
    await flush();

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.selectedItem?.itemId).toBe("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("active");
    expect(latest?.selectedRun?.runId).toBe("run-1");
    expect(latest?.data?.selectedDurableRun?.status).toBe("completed");
    expect(latest?.policyDraft?.timeZone).toBe("America/Los_Angeles");
    expect(apiMocks.fetchMemoryItemHistory).toHaveBeenCalledWith("mem-1", 100);
  });

  it("updates and forgets the selected item without losing lifecycle truth", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();
    await flush();

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
    expect(latest?.selectedItem?.title).toBe("Updated note");
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory item updated." });

    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    await flush();

    expect(apiMocks.forgetMemoryItem).toHaveBeenCalledWith("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("forgotten");
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory item forgotten." });
  });
});
