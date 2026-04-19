import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  acceptMemoryMaintenanceRecommendation: vi.fn(),
  cancelDurableRun: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchFilesList: vi.fn(),
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
  retryDurableRun: vi.fn(),
  runMemoryMaintenanceNow: vi.fn(),
}));

const refreshMocks = vi.hoisted(() => ({
  callback: undefined as undefined | (() => Promise<void> | void),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_channel: string, callback: () => Promise<void> | void) => {
    refreshMocks.callback = callback;
  },
}));
vi.mock("../hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: {
      activeProviderId: "ollama",
      activeModel: "qwen3",
    },
    providers: [
      {
        providerId: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        defaultModel: "qwen3",
        models: ["qwen3", "llama3.2"],
      },
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        models: ["gpt-5.4-mini"],
      },
    ],
    loadModelsForProvider: vi.fn(async () => ["qwen3", "llama3.2"]),
  }),
}));
vi.mock("../components/ActionButton", () => ({
  ActionButton: ({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}));
vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary }: { primary?: React.ReactNode }) => <div>{primary}</div>,
}));
vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: ({ what, when }: { what?: string; when?: string }) => (
    <section>
      <div>{what}</div>
      <div>{when}</div>
    </section>
  ),
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({
    primary,
    inspector,
    emptyInspector,
  }: {
    primary?: React.ReactNode;
    inspector?: React.ReactNode;
    emptyInspector?: React.ReactNode;
  }) => (
    <div>
      {primary}
      {inspector ?? emptyInspector}
    </div>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
    className,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <section className={className}>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </section>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({ open, title, message }: { open?: boolean; title?: string; message?: string }) =>
    open ? (
      <div>
        {title}
        {message}
      </div>
    ) : null,
}));
vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ label, text }: { label?: string; text?: string }) => (
    <span>
      {label}
      {text}
    </span>
  ),
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/StatCard", () => ({
  StatCard: ({ label, value, note }: { label?: React.ReactNode; value?: React.ReactNode; note?: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {note}
    </div>
  ),
}));
vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: ({ value, customLabel }: { value?: string; customLabel?: string }) => (
    <div>
      {customLabel}
      {value}
    </div>
  ),
}));
vi.mock("../components/ui", () => ({
  GCSelect: ({
    value,
    options,
    onChange,
    disabled,
  }: {
    value?: string;
    options: Array<{ value: string; label: string }>;
    onChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select disabled={disabled} value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../content/copy", () => ({
  pageCopy: {
    memory: {
      title: "Memory",
      subtitle: "Workspace memory controls.",
      guide: {
        what: "Understand memory storage.",
        when: "Use when reviewing memory.",
        mostCommonAction: "Inspect memory",
        actions: [],
        terms: [],
      },
    },
  },
}));

import { MemoryPage } from "./MemoryPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

function buildQmdStats() {
  return {
    totalRuns: 0,
    generatedRuns: 0,
    cacheHitRuns: 0,
    fallbackRuns: 0,
    failedRuns: 0,
    originalTokenEstimate: 0,
    distilledTokenEstimate: 0,
    savingsPercent: 0,
    netTokenDelta: 0,
    compressionPercent: 0,
    expansionPercent: 0,
    efficiencyLabel: "neutral" as const,
    recent: [],
  };
}

function buildSettings(features: {
  durableKernelV1Enabled: boolean;
  memoryMaintenanceV1Enabled: boolean;
  memoryLifecycleAdminV1Enabled: boolean;
}) {
  return {
    features: {
      durableKernelV1Enabled: features.durableKernelV1Enabled,
      memoryMaintenanceV1Enabled: features.memoryMaintenanceV1Enabled,
      memoryLifecycleAdminV1Enabled: features.memoryLifecycleAdminV1Enabled,
      replayOverridesV1Enabled: false,
      connectorDiagnosticsV1Enabled: false,
      computerUseGuardrailsV1Enabled: false,
      bankrBuiltinEnabled: false,
      cronReviewQueueV1Enabled: false,
      replayRegressionV1Enabled: false,
    },
  };
}

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMocks.callback = undefined;
    apiMocks.fetchFilesList.mockResolvedValue({
      items: [
        {
          relativePath: "memory/maintenance/latest.md",
          size: 128,
          modifiedAt: "2026-04-01T17:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryQmdStats.mockResolvedValue(buildQmdStats());
    apiMocks.fetchMemoryItems.mockResolvedValue({ items: [] });
    apiMocks.fetchMemoryItemHistory.mockResolvedValue({ items: [] });
    apiMocks.fetchMemoryMaintenanceStatus.mockResolvedValue({
      workspaceId: "default",
      policy: {
        workspaceId: "default",
        enabled: true,
        runMode: "hybrid",
        timingStrategy: "recommendation_first",
        schedule: {
          frequency: "daily",
          hour: 3,
          minute: 0,
        },
        timeZone: "America/Los_Angeles",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 3,
        providerId: "ollama",
        model: "qwen3",
        executionTarget: "local",
        unavailableModelPolicy: "skip",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
      state: {
        workspaceId: "default",
        lastEligibilityAt: "2026-04-01T10:00:00.000Z",
        lastSuccessfulRunAt: "2026-04-01T09:00:00.000Z",
        changedSessionCount: 4,
        activeRunId: "maintenance-run-1",
        lastRecommendationAt: "2026-04-01T08:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
      lastRun: {
        runId: "maintenance-run-1",
        durableRunId: "durable-run-1",
        workspaceId: "default",
        triggerSource: "manual",
        status: "completed",
        providerId: "ollama",
        model: "qwen3",
        policySnapshot: {},
        sourceSessionCount: 4,
        changedArtifactCount: 2,
        summary: "Consolidated workspace memory.",
        createdAt: "2026-04-01T09:00:00.000Z",
        startedAt: "2026-04-01T09:00:05.000Z",
        finishedAt: "2026-04-01T09:02:00.000Z",
        updatedAt: "2026-04-01T09:02:00.000Z",
      },
      nextDueAt: "2026-04-02T10:00:00.000Z",
    });
    apiMocks.fetchMemoryMaintenanceRuns.mockResolvedValue({
      items: [
        {
          runId: "maintenance-run-1",
          durableRunId: "durable-run-1",
          workspaceId: "default",
          triggerSource: "manual",
          status: "completed",
          providerId: "ollama",
          model: "qwen3",
          policySnapshot: {},
          sourceSessionCount: 4,
          changedArtifactCount: 2,
          summary: "Consolidated workspace memory.",
          createdAt: "2026-04-01T09:00:00.000Z",
          startedAt: "2026-04-01T09:00:05.000Z",
          finishedAt: "2026-04-01T09:02:00.000Z",
          updatedAt: "2026-04-01T09:02:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceRecommendations.mockResolvedValue({
      items: [
        {
          recommendationId: "recommendation-1",
          workspaceId: "default",
          kind: "threshold_adjustment",
          status: "queued",
          summary: "Raise the changed-session threshold.",
          proposedPatch: { minChangedSessions: 5 },
          rationale: "Backlog density remained low.",
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceRunProvenance.mockResolvedValue({
      run: {
        runId: "maintenance-run-1",
        durableRunId: "durable-run-1",
        workspaceId: "default",
        triggerSource: "manual",
        status: "completed",
        providerId: "ollama",
        model: "qwen3",
        policySnapshot: {},
        sourceSessionCount: 4,
        changedArtifactCount: 2,
        summary: "Consolidated workspace memory.",
        createdAt: "2026-04-01T09:00:00.000Z",
        startedAt: "2026-04-01T09:00:05.000Z",
        finishedAt: "2026-04-01T09:02:00.000Z",
        updatedAt: "2026-04-01T09:02:00.000Z",
      },
      sources: [
        {
          sourceId: "source-1",
          runId: "maintenance-run-1",
          sourceKind: "transcript",
          sourceRef: "session-1",
          modifiedAt: "2026-04-01T08:50:00.000Z",
          excerpt: "Recent transcript excerpt",
          tokenEstimate: 42,
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      ],
      changes: [
        {
          changeId: "change-1",
          runId: "maintenance-run-1",
          changeKind: "updated",
          targetKind: "file",
          targetRef: "memory/maintenance/latest.md",
          summary: "Updated consolidated snapshot.",
          createdAt: "2026-04-01T09:02:00.000Z",
        },
      ],
    });
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-run-1",
      workflowType: "memory.maintenance",
      status: "completed",
      payload: {},
      updatedAt: "2026-04-01T09:02:00.000Z",
      createdAt: "2026-04-01T09:00:00.000Z",
      startedAt: "2026-04-01T09:00:05.000Z",
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventId: "timeline-1",
          runId: "durable-run-1",
          eventType: "run_completed",
          createdAt: "2026-04-01T09:02:00.000Z",
          payload: {},
        },
      ],
    });
  });

  it("hides memory maintenance when the feature flag is off", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).not.toContain("Memory Maintenance");
      expect(apiMocks.fetchMemoryMaintenanceStatus).not.toHaveBeenCalled();
      expect(apiMocks.fetchMemoryMaintenanceRuns).not.toHaveBeenCalled();
      expect(apiMocks.fetchMemoryMaintenanceRecommendations).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("shows an infrastructure block when Dream is enabled but durable execution is unavailable", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: false,
        memoryMaintenanceV1Enabled: true,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Memory Maintenance");
      expect(text).toContain("Durable execution is part of the shipped runtime baseline");
      expect(apiMocks.fetchMemoryMaintenanceStatus).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("renders memory maintenance policy, history, recommendations, and durable details when enabled", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: true,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Memory Maintenance");
      expect(text).toContain("Run now");
      expect(text).toContain("Apply overnight local preset");
      expect(text).toContain("skip if unavailable");
      expect(text).toContain("Consolidated workspace memory.");
      expect(text).toContain("threshold_adjustment");
      expect(text).toContain("Updated consolidated snapshot.");
      expect(text).toContain("durable-run-1");
      expect(text).toContain("local endpoint");
      expect(apiMocks.fetchMemoryMaintenanceStatus).toHaveBeenCalledWith("default");
      expect(apiMocks.fetchMemoryMaintenanceRunProvenance).toHaveBeenCalledWith("maintenance-run-1");
      expect(apiMocks.fetchDurableRun).toHaveBeenCalledWith("durable-run-1");
      expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledWith("durable-run-1", 120);
    } finally {
      renderer.unmount();
    }
  });

  it("renders relation scope and citation provenance for recent context packs", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );
    apiMocks.fetchMemoryQmdStats.mockResolvedValue({
      ...buildQmdStats(),
      recent: [
        {
          contextId: "ctx-1",
          scope: "chat",
          relationScope: "project",
          queryHash: "query-1",
          sourcesHash: "sources-1",
          contextText: "Distilled context",
          createdAt: "2026-04-01T09:00:00.000Z",
          expiresAt: "2026-04-01T10:00:00.000Z",
          originalTokenEstimate: 400,
          distilledTokenEstimate: 120,
          quality: { status: "generated" },
          citations: [
            {
              candidateId: "cand-1",
              sourceType: "transcript",
              sourceRef: "turn-1",
              score: 0.91,
              provenance: {
                relationScope: "project",
                freshness: "recent",
                selectionReason: "Matched current objective",
                sourceTimestamp: "2026-04-01T08:55:00.000Z",
              },
            },
          ],
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("ctx-1");
      expect(text).toContain("project");
      expect(text).toContain("1 citations");
      expect(text).toContain("turn-1");
      expect(text).toContain("freshness recent");
      expect(text).toContain("Matched current objective");
    } finally {
      renderer.unmount();
    }
  });

  it("re-checks capability settings during background refresh instead of reusing stale flags", async () => {
    apiMocks.fetchSettings
      .mockResolvedValueOnce(
        buildSettings({
          durableKernelV1Enabled: true,
          memoryMaintenanceV1Enabled: false,
          memoryLifecycleAdminV1Enabled: false,
        }),
      )
      .mockResolvedValueOnce(
        buildSettings({
          durableKernelV1Enabled: true,
          memoryMaintenanceV1Enabled: true,
          memoryLifecycleAdminV1Enabled: false,
        }),
      );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      expect(rendererText(renderer)).not.toContain("Memory Maintenance");

      await act(async () => {
        await refreshMocks.callback?.();
      });
      await flush();

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(2);
      expect(rendererText(renderer)).toContain("Memory Maintenance");
    } finally {
      renderer.unmount();
    }
  });
});
