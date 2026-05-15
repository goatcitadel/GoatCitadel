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
  ConfirmModal: ({
    open,
    title,
    message,
    onCancel,
    onConfirm,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
  }) =>
    open ? (
      <div>
        {title}
        {message}
        <button type="button" data-testid="confirm-cancel" onClick={onCancel}>
          Cancel forget
        </button>
        <button type="button" data-testid="confirm-accept" onClick={onConfirm}>
          Confirm forget
        </button>
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

function nodeText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => nodeText(child)).join(" ");
  }
  if (typeof value === "object" && "props" in value) {
    return nodeText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAllByType("button").find((node) => nodeText(node.props.children).includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
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

  it("shows derived lifecycle truth for expired memory items", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: true,
      }),
    );
    apiMocks.fetchMemoryItems.mockResolvedValue({
      items: [
        {
          itemId: "memory-item-1",
          namespace: "workspace.default",
          title: "Old preference",
          content: "Use the archived workflow.",
          metadata: {},
          pinned: false,
          status: "active",
          lifecycleState: "expired",
          ttlOverrideSeconds: 60,
          expiresAt: "2026-04-01T09:00:00.000Z",
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:30:00.000Z",
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
      expect(text).toContain("expired");
      expect(text).toContain("Old preference");
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

  it("filters workspace files and drives memory lifecycle inspect, pin, cancel, and forget paths", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: true,
      }),
    );
    apiMocks.fetchFilesList.mockResolvedValue({
      items: [
        {
          relativePath: "workspaces/tenant/memory/maintenance/latest.md",
          size: 128,
          modifiedAt: "2026-04-01T17:00:00.000Z",
        },
        {
          relativePath: "workspaces/tenant/docs/readme.md",
          size: 64,
          modifiedAt: "2026-04-01T16:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryItems.mockResolvedValue({
      items: [
        {
          itemId: "memory-item-1",
          namespace: "workspace.default",
          title: "Pinned workflow",
          content: "Use the durable workflow.",
          metadata: {},
          pinned: false,
          status: "active",
          lifecycleState: "active",
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:30:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryItemHistory.mockResolvedValue({
      items: [
        {
          changeId: "change-1",
          itemId: "memory-item-1",
          changeType: "pinned",
          actorId: "operator",
          createdAt: "2026-04-01T08:40:00.000Z",
        },
      ],
    });
    apiMocks.patchMemoryItem.mockResolvedValue({
      itemId: "memory-item-1",
      pinned: true,
      status: "active",
      lifecycleState: "active",
      ttlOverrideSeconds: 3600,
      expiresAt: "2026-04-01T09:30:00.000Z",
      updatedAt: "2026-04-01T08:45:00.000Z",
    });
    apiMocks.forgetMemoryItem.mockResolvedValue({
      itemId: "memory-item-1",
      pinned: true,
      status: "forgotten",
      lifecycleState: "forgotten",
      updatedAt: "2026-04-01T08:50:00.000Z",
      expiresAt: "2026-04-01T08:50:00.000Z",
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="tenant" />);
      });
      await flush();

      let text = rendererText(renderer);
      expect(text).toContain("memory/maintenance/latest.md");
      expect(text).not.toContain("workspaces/tenant");
      expect(text).toContain("Pinned workflow");

      await clickButton(renderer, "Inspect");
      await flush();
      expect(apiMocks.fetchMemoryItemHistory).toHaveBeenCalledWith("memory-item-1", 100);
      expect(rendererText(renderer)).toContain("pinned");
      expect(rendererText(renderer)).toContain("operator");

      await clickButton(renderer, "Pin");
      await flush();
      expect(apiMocks.patchMemoryItem).toHaveBeenCalledWith("memory-item-1", { pinned: true });
      expect(rendererText(renderer)).toContain("active • pinned");

      await clickButton(renderer, "Forget");
      expect(rendererText(renderer)).toContain('Forget "Pinned workflow"?');

      await clickButton(renderer, "Cancel forget");
      expect(rendererText(renderer)).not.toContain('Forget "Pinned workflow"?');

      await clickButton(renderer, "Forget");
      await clickButton(renderer, "Confirm forget");
      await flush();
      expect(apiMocks.forgetMemoryItem).toHaveBeenCalledWith("memory-item-1");
      text = rendererText(renderer);
      expect(text).toContain("forgotten");
    } finally {
      renderer.unmount();
    }
  });

  it("edits and executes memory maintenance policy, recommendations, and durable run actions", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: true,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );
    apiMocks.runMemoryMaintenanceNow.mockResolvedValue({
      runId: "maintenance-run-2",
      durableRunId: "durable-run-2",
      workspaceId: "default",
      triggerSource: "manual",
      status: "queued",
      providerId: "ollama",
      model: "qwen3",
      policySnapshot: {},
      sourceSessionCount: 0,
      changedArtifactCount: 0,
      createdAt: "2026-04-01T11:00:00.000Z",
      updatedAt: "2026-04-01T11:00:00.000Z",
    });
    apiMocks.patchMemoryMaintenancePolicy.mockResolvedValue({});
    apiMocks.acceptMemoryMaintenanceRecommendation.mockResolvedValue({});
    apiMocks.rejectMemoryMaintenanceRecommendation.mockResolvedValue({});
    apiMocks.cancelDurableRun.mockResolvedValue({});
    apiMocks.retryDurableRun.mockResolvedValue({});

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const saveButtonBeforeEdit = renderer.root
        .findAllByType("button")
        .find((node) => nodeText(node.props.children).includes("Save policy"));
      expect(saveButtonBeforeEdit?.props.disabled).toBe(true);

      await clickButton(renderer, "Apply overnight local preset");
      await flush();
      const saveButtonAfterEdit = renderer.root
        .findAllByType("button")
        .find((node) => nodeText(node.props.children).includes("Save policy"));
      expect(saveButtonAfterEdit?.props.disabled).toBe(false);

      await clickButton(renderer, "Save policy");
      await flush();
      expect(apiMocks.patchMemoryMaintenancePolicy).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({
          enabled: true,
          executionTarget: "local",
          unavailableModelPolicy: "skip",
        }),
      );

      await clickButton(renderer, "Run now");
      await flush();
      expect(apiMocks.runMemoryMaintenanceNow).toHaveBeenCalledWith({
        workspaceId: "default",
        triggerSource: "manual",
      });

      await clickButton(renderer, "Accept");
      await flush();
      expect(apiMocks.acceptMemoryMaintenanceRecommendation).toHaveBeenCalledWith("recommendation-1");

      await clickButton(renderer, "Reject");
      await flush();
      expect(apiMocks.rejectMemoryMaintenanceRecommendation).toHaveBeenCalledWith("recommendation-1");

      await clickButton(renderer, "Cancel");
      await flush();
      expect(apiMocks.cancelDurableRun).toHaveBeenCalledWith("durable-run-1", "memory-page");

      await clickButton(renderer, "Retry");
      await flush();
      expect(apiMocks.retryDurableRun).toHaveBeenCalledWith("durable-run-1", {
        actorId: "memory-page",
        reason: "MemoryPage requested retry",
      });
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces workspace inventory and memory lifecycle operation failures", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: true,
      }),
    );
    apiMocks.fetchFilesList.mockRejectedValueOnce(new Error("memory inventory failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("memory inventory failed");
    } finally {
      renderer.unmount();
    }

    apiMocks.fetchFilesList.mockResolvedValue({
      items: [
        {
          relativePath: "memory/preferences.md",
          size: 128,
          modifiedAt: "2026-04-01T17:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryItems.mockResolvedValue({
      items: [
        {
          itemId: "memory-item-error",
          namespace: "workspace.default",
          title: "Fragile memory",
          content: "Keep this visible.",
          metadata: {},
          pinned: false,
          status: "active",
          lifecycleState: "active",
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:30:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryItemHistory.mockRejectedValueOnce(new Error("history failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "Inspect");
      await flush();
      expect(rendererText(renderer)).toContain("history failed");
    } finally {
      renderer.unmount();
    }

    apiMocks.fetchMemoryItemHistory.mockResolvedValue({ items: [] });
    apiMocks.patchMemoryItem.mockRejectedValueOnce(new Error("pin failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "Pin");
      await flush();
      expect(rendererText(renderer)).toContain("pin failed");
    } finally {
      renderer.unmount();
    }

    apiMocks.patchMemoryItem.mockResolvedValue({
      itemId: "memory-item-error",
      pinned: false,
      status: "active",
      lifecycleState: "active",
      updatedAt: "2026-04-01T08:45:00.000Z",
    });
    apiMocks.forgetMemoryItem.mockRejectedValueOnce(new Error("forget failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "Forget");
      await clickButton(renderer, "Confirm forget");
      await flush();
      expect(rendererText(renderer)).toContain("forget failed");
    } finally {
      renderer.unmount();
    }
  });

  it("treats disabled memory lifecycle admin errors as a feature-state fallback", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: false,
        memoryLifecycleAdminV1Enabled: true,
      }),
    );
    apiMocks.fetchMemoryItems.mockRejectedValueOnce(
      new Error("Feature flag memoryLifecycleAdminV1Enabled is disabled"),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Memory lifecycle admin");
      expect(text).not.toContain("Feature flag memoryLifecycleAdminV1Enabled is disabled");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces memory-maintenance load and action failures without hiding policy context", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: true,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );
    apiMocks.fetchMemoryMaintenanceStatus.mockRejectedValueOnce(new Error("maintenance status failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("maintenance status failed");
      expect(rendererText(renderer)).toContain("Loading memory-maintenance policy");
    } finally {
      renderer.unmount();
    }

    apiMocks.fetchMemoryMaintenanceStatus.mockResolvedValue({
      workspaceId: "default",
      policy: {
        workspaceId: "default",
        enabled: true,
        runMode: "hybrid",
        timingStrategy: "recommendation_first",
        schedule: { frequency: "daily", hour: 3, minute: 0 },
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
        changedSessionCount: 4,
        activeRunId: "maintenance-run-1",
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
        updatedAt: "2026-04-01T09:02:00.000Z",
      },
    });
    apiMocks.patchMemoryMaintenancePolicy.mockRejectedValueOnce(new Error("save policy failed"));
    apiMocks.runMemoryMaintenanceNow.mockRejectedValueOnce(new Error("run failed"));
    apiMocks.acceptMemoryMaintenanceRecommendation.mockRejectedValueOnce(new Error("accept failed"));
    apiMocks.rejectMemoryMaintenanceRecommendation.mockRejectedValueOnce(new Error("reject failed"));
    apiMocks.cancelDurableRun.mockRejectedValueOnce(new Error("cancel failed"));
    apiMocks.retryDurableRun.mockRejectedValueOnce(new Error("retry failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      await clickButton(renderer, "Apply overnight local preset");
      await flush();
      await clickButton(renderer, "Save policy");
      await flush();
      expect(rendererText(renderer)).toContain("save policy failed");

      await clickButton(renderer, "Run now");
      await flush();
      expect(rendererText(renderer)).toContain("run failed");

      await clickButton(renderer, "Accept");
      await flush();
      expect(rendererText(renderer)).toContain("accept failed");

      await clickButton(renderer, "Reject");
      await flush();
      expect(rendererText(renderer)).toContain("reject failed");

      await clickButton(renderer, "Cancel");
      await flush();
      expect(rendererText(renderer)).toContain("cancel failed");

      await clickButton(renderer, "Retry");
      await flush();
      expect(rendererText(renderer)).toContain("retry failed");
    } finally {
      renderer.unmount();
    }
  });

  it("shows no-durable-run maintenance history and the over-300 inventory cap", async () => {
    apiMocks.fetchSettings.mockResolvedValue(
      buildSettings({
        durableKernelV1Enabled: true,
        memoryMaintenanceV1Enabled: true,
        memoryLifecycleAdminV1Enabled: false,
      }),
    );
    apiMocks.fetchFilesList.mockResolvedValue({
      items: Array.from({ length: 305 }, (_, index) => ({
        relativePath: `memory/generated-${index}.md`,
        size: index + 1,
        modifiedAt: "2026-04-01T17:00:00.000Z",
      })),
    });
    apiMocks.fetchMemoryQmdStats.mockResolvedValue({
      ...buildQmdStats(),
      totalRuns: 1,
      recent: [
        {
          contextId: "ctx-no-citations",
          scope: "chat",
          createdAt: "2026-04-01T09:00:00.000Z",
          quality: { status: "generated" },
          citations: [],
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceStatus.mockResolvedValue({
      workspaceId: "default",
      policy: {
        workspaceId: "default",
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        schedule: { frequency: "weekly", weekday: 5, hour: 4, minute: 30 },
        timeZone: "UTC",
        minHoursSinceLastSuccess: 48,
        minChangedSessions: 10,
        providerId: "",
        model: "",
        executionTarget: "auto",
        unavailableModelPolicy: "error",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
      state: {
        workspaceId: "default",
        changedSessionCount: 0,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });
    apiMocks.fetchMemoryMaintenanceRuns.mockResolvedValue({
      items: [
        {
          runId: "maintenance-run-no-durable",
          workspaceId: "default",
          triggerSource: "manual",
          status: "failed",
          policySnapshot: {},
          sourceSessionCount: 0,
          changedArtifactCount: 0,
          error: "No durable id was emitted.",
          createdAt: "2026-04-01T09:00:00.000Z",
          updatedAt: "2026-04-01T09:02:00.000Z",
        },
      ],
    });
    apiMocks.fetchMemoryMaintenanceRecommendations.mockResolvedValue({ items: [] });
    apiMocks.fetchMemoryMaintenanceRunProvenance.mockResolvedValue({
      run: {
        runId: "maintenance-run-no-durable",
        workspaceId: "default",
        triggerSource: "manual",
        status: "failed",
        policySnapshot: {},
        sourceSessionCount: 0,
        changedArtifactCount: 0,
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T09:02:00.000Z",
      },
      sources: [],
      changes: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MemoryPage workspaceId="default" />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Showing first 300 rows of 305 matching files.");
      expect(text).toContain("ctx-no-citations");
      expect(text).toContain("No timing recommendations queued.");
      expect(text).toContain("This run has no durable run id attached.");
      expect(text).toContain("No persisted changes recorded for this run yet.");
      expect(text).toContain("No source provenance captured yet.");
      expect(apiMocks.fetchDurableRun).not.toHaveBeenCalledWith(undefined);
    } finally {
      renderer.unmount();
    }
  });
});
