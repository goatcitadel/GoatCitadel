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

async function mountHook(onValue: (value: HookValue) => void) {
  let mounted!: ReactTestRenderer;
  await act(async () => {
    mounted = create(<Harness onValue={onValue} />);
  });
  await flush();
  await flush();
  return mounted;
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
    renderer = await mountHook((value) => {
      latest = value;
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.selectedItem?.itemId).toBe("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("active");
    expect(latest?.selectedRun?.runId).toBe("run-1");
    expect(latest?.data?.selectedDurableRun?.status).toBe("completed");
    expect(latest?.data?.memoryAdminState).toBe("enabled");
    expect(latest?.policyDraft?.timeZone).toBe("America/Los_Angeles");
    expect(apiMocks.fetchMemoryItemHistory).toHaveBeenCalledWith("mem-1", 100);
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

    await act(async () => {
      await latest?.saveItemPatch("mem-1", { title: "Should not save" });
    });

    expect(apiMocks.patchMemoryItem).not.toHaveBeenCalled();
    expect(latest?.notice).toEqual({
      tone: "warning",
      message: "Memory admin settings are not confirmed, so item changes are locked.",
    });
  });

  it("updates and forgets the selected item without losing lifecycle truth", async () => {
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
    expect(latest?.selectedItem?.title).toBe("Updated note");
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory item updated." });

    await act(async () => {
      await latest?.forgetSelectedItem();
    });
    await flush();

    expect(apiMocks.forgetMemoryItem).toHaveBeenCalledWith("mem-1");
    expect(latest?.selectedItem?.lifecycleState).toBe("forgotten");
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory item forgotten." });

    await act(async () => {
      await latest?.runMaintenance();
    });
    await flush();
    expect(apiMocks.runMemoryMaintenanceNow).toHaveBeenCalledWith({ workspaceId: "default", triggerSource: "manual" });
    expect(latest?.notice).toEqual({ tone: "success", message: "Memory maintenance queued." });

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

  it("records optional section errors without disabling the whole snapshot", async () => {
    apiMocks.fetchMemoryFiles.mockRejectedValue(new Error("files unavailable"));
    apiMocks.fetchMemoryQmdStats.mockRejectedValue("qmd unavailable");
    apiMocks.fetchMemoryItemHistory.mockRejectedValue(new Error("history unavailable"));
    apiMocks.fetchMemoryMaintenanceStatus.mockRejectedValue(new Error("status unavailable"));
    apiMocks.fetchMemoryMaintenanceRecommendations.mockRejectedValue(new Error("recommendations unavailable"));
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
    expect(latest?.data?.sectionErrors.memoryHistory).toBe("history unavailable");
    expect(latest?.data?.sectionErrors.maintenanceStatus).toBe("status unavailable");
    expect(latest?.data?.sectionErrors.maintenanceRecommendations).toBe("recommendations unavailable");
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
});
