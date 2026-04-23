import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRoutePage } from "./MemoryRoutePage";

const memorySnapshot = vi.hoisted(() => ({
  loading: false,
  error: null,
  notice: null,
  busyKey: null,
  reload: vi.fn(),
  selectedItemId: "mem-1",
  setSelectedItemId: vi.fn(),
  selectedRunId: "run-1",
  setSelectedRunId: vi.fn(),
  selectedItem: {
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
  selectedRun: {
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
  policyDraft: {
    enabled: true,
    runMode: "manual",
    timingStrategy: "fixed",
    timeZone: "America/Los_Angeles",
    minHoursSinceLastSuccess: 24,
    minChangedSessions: 1,
    providerId: "openai",
    model: "gpt-5",
    executionTarget: "auto",
    unavailableModelPolicy: "skip",
    scheduleEnabled: false,
    scheduleFrequency: "daily",
    scheduleHour: 3,
    scheduleMinute: 0,
    scheduleWeekday: 1,
  },
  setPolicyDraft: vi.fn(),
  policyDirty: false,
  setPolicyDirty: vi.fn(),
  saveItemPatch: vi.fn(),
  forgetSelectedItem: vi.fn(),
  runMaintenance: vi.fn(),
  savePolicy: vi.fn(),
  resolveRecommendation: vi.fn(),
  data: {
    files: [{ relativePath: "memory/workspace/note.md", size: 1024, modifiedAt: "2026-04-22T00:00:00.000Z" }],
    qmdStats: {
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
    },
    memoryItems: [
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
    memoryHistory: [
      { changeId: "chg-1", changeType: "updated", createdAt: "2026-04-22T00:00:00.000Z", actorId: "operator:test" },
    ],
    maintenanceStatus: {
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
    },
    maintenanceRuns: [
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
    maintenanceRecommendations: [
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
    selectedRunProvenance: { run: { runId: "run-1" }, sources: [], changes: [] },
    selectedDurableRun: { runId: "durable-1", status: "completed" },
    selectedDurableTimeline: [],
    memoryAdminEnabled: true,
    maintenanceEnabled: true,
    maintenanceDurableReady: true,
  },
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot", () => ({
  useMemoryOperatorSnapshot: () => memorySnapshot,
}));

describe("MemoryRoutePage", () => {
  it("renders lifecycle-aware memory operator truth in the next shell", () => {
    const markup = renderToStaticMarkup(
      <MemoryRoutePage
        route={{ area: "library", section: "memory", theme: "library" } as any}
        activeWorkspaceId="default"
        activeWorkspaceName="Default"
        pendingApprovals={0}
        navigate={vi.fn()}
        setActiveWorkspaceId={vi.fn()}
      />,
    );

    expect(markup).toContain("Memory items");
    expect(markup).toContain("Lifecycle");
    expect(markup).toContain("Run maintenance now");
    expect(markup).toContain("Tighten cadence for fresh context.");
    expect(markup).toContain("Memory files");
  });

  it("keeps quick-jump navigation on canonical next routes", async () => {
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <MemoryRoutePage
          route={{ area: "library", section: "memory", theme: "library" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          pendingApprovals={0}
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    const runtimeButton = buttons.find(
      (button: ReactTestInstance) =>
        button.findAll((node) => typeof node.props?.children === "string" && node.props.children === "Runtime").length >
        0,
    );

    expect(runtimeButton).toBeDefined();

    act(() => {
      runtimeButton!.props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({
      area: "ops",
      section: "runtime",
      theme: "library",
    });
    expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty("page");
  });
});
