import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { PromptPackReportRecord } from "@goatcitadel/contracts";
import { ConfirmModal } from "./components/ConfirmModal";
import { RemoteApprovalActionModal } from "./components/RemoteApprovalActionModal";
import { McpPage } from "./pages/McpPage";
import { PromptLabPage } from "./pages/PromptLabPage";

const testState = vi.hoisted(() => {
  const refreshRegistrations = new Map<
    string,
    {
      callback: (signal: unknown) => Promise<void> | void;
      options: Record<string, unknown>;
    }
  >();

  return {
    refreshRegistrations,
    api: {
      fetchConnectorRecords: vi.fn(),
      fetchSettings: vi.fn(),
      connectMcpServer: vi.fn(),
      createMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      disconnectMcpServer: vi.fn(),
      fetchMcpTemplateDiscovery: vi.fn(),
      fetchMcpTemplates: vi.fn(),
      fetchMcpServers: vi.fn(),
      fetchMcpTools: vi.fn(),
      invokeMcpTool: vi.fn(),
      runMcpServerHealthCheck: vi.fn(),
      startMcpOAuth: vi.fn(),
      updateMcpServerPolicy: vi.fn(),
      autoScorePromptPackBatch: vi.fn(),
      autoScorePromptPackTest: vi.fn(),
      exportPromptPackReport: vi.fn(),
      fetchPromptPackBenchmark: vi.fn(),
      fetchPromptPackReplayRegressionStatus: vi.fn(),
      fetchPromptPackTrends: vi.fn(),
      fetchPromptPackExport: vi.fn(),
      fetchPromptPackReport: vi.fn(),
      fetchPromptPacks: vi.fn(),
      fetchPromptPackTests: vi.fn(),
      importPromptPack: vi.fn(),
      resetPromptPack: vi.fn(),
      runPromptPackTest: vi.fn(),
      runPromptPackBenchmark: vi.fn(),
      runPromptPackReplayRegression: vi.fn(),
      scorePromptPackTest: vi.fn(),
    },
    loadModelsForProvider: vi.fn(),
  };
});

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: { data?: unknown[]; itemContent?: (index: number, item: unknown) => React.ReactNode }) => (
    <div>
      {(props.data ?? []).map((item, index) => (
        <div key={index}>{props.itemContent?.(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock("./api/client", () => testState.api);

vi.mock("./hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    topic: string,
    callback: (signal: unknown) => Promise<void> | void,
    options: Record<string, unknown> = {},
  ) => {
    testState.refreshRegistrations.set(topic, { callback, options });
  },
}));

vi.mock("./hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: null,
    providers: [],
    loadModelsForProvider: testState.loadModelsForProvider,
  }),
}));

vi.mock("./components/ActionButton", () => ({
  ActionButton: (props: {
    label: string;
    pending?: boolean;
    disabled?: boolean;
    danger?: boolean;
    onClick?: () => void;
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      data-danger={props.danger ? "true" : "false"}
      onClick={props.onClick}
    >
      {props.pending ? "Working..." : props.label}
    </button>
  ),
}));

vi.mock("./components/ChatModelPicker", () => ({
  ChatModelPicker: () => <div>chat-model-picker</div>,
}));

vi.mock("./components/ui", () => ({
  GCModal: (props: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    title: string;
    description?: string;
    confirmDisabled?: boolean;
    dismissDisabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <button
      type="button"
      data-mock-modal="true"
      data-open={props.open ? "true" : "false"}
      data-title={props.title}
      data-description={props.description ?? ""}
      data-confirm-disabled={props.confirmDisabled ? "true" : "false"}
      data-dismiss-disabled={props.dismissDisabled ? "true" : "false"}
      onClick={() => {
        if (!props.dismissDisabled) {
          props.onOpenChange?.(false);
        }
      }}
    >
      {props.children}
    </button>
  ),
  GCSelect: (props: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: (props: { checked: boolean; onCheckedChange: (checked: boolean) => void; label?: string }) => (
    <label>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onCheckedChange(event.target.checked)}
      />
      {props.label}
    </label>
  ),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function resetApiMocks(): void {
  for (const mockFn of Object.values(testState.api)) {
    mockFn.mockReset();
  }
  testState.loadModelsForProvider.mockReset();
  testState.refreshRegistrations.clear();
}

function textContent(node: ReactTestInstance): string {
  const flatten = (value: unknown): string[] => {
    if (typeof value === "string" || typeof value === "number") {
      return [String(value)];
    }
    if (Array.isArray(value)) {
      return value.flatMap(flatten);
    }
    return [];
  };
  return flatten(node.props.children).join("");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAllByType("button").find((button) => textContent(button) === label);
  if (!match) {
    throw new Error(`Unable to find button ${label}`);
  }
  return match;
}

function createPromptPackReport(overrides?: Partial<PromptPackReportRecord>) {
  return {
    ...createPromptPackReportBase(),
    ...overrides,
  };
}

function createPromptPackReportBase(): PromptPackReportRecord {
  return {
    pack: {
      packId: "pack-a",
      name: "Pack A",
      testCount: 1,
      createdAt: "2026-03-21T12:00:00.000Z",
      updatedAt: "2026-03-21T12:00:00.000Z",
    },
    tests: [
      {
        testId: "pack-a-test-1",
        packId: "pack-a",
        code: "A-01",
        title: "Alpha test",
        prompt: "Prompt for pack-a",
        orderIndex: 0,
        createdAt: "2026-03-21T12:00:00.000Z",
      },
    ],
    runs: [],
    scores: [],
    summary: {
      totalTests: 1,
      completedRuns: 0,
      failedRuns: 0,
      runFailureCount: 0,
      scoreFailureCount: 0,
      needsScoreCount: 0,
      durableRuns: 0,
      approvalPausedRuns: 0,
      backgroundedRuns: 0,
      passThreshold: 7,
      averageTotalScore: 0,
      passRate: 0,
      failingCodes: [],
    },
  };
}

beforeEach(() => {
  resetApiMocks();

  testState.api.fetchMcpServers.mockResolvedValue({
    items: [
      {
        serverId: "srv-1",
        label: "Primary MCP",
        transport: "http",
        status: "connected",
        enabled: true,
        category: "development",
        trustTier: "trusted",
        costTier: "free",
        policy: {
          requireFirstToolApproval: false,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
          notes: "original note",
        },
        url: "https://mcp.example.test",
        authType: "none",
      },
    ],
  });
  testState.api.fetchMcpTemplates.mockResolvedValue({ items: [] });
  testState.api.fetchMcpTemplateDiscovery.mockResolvedValue({ items: [] });
  testState.api.fetchConnectorRecords.mockResolvedValue({ items: [] });
  testState.api.fetchSettings.mockResolvedValue({
    features: {
      connectorDiagnosticsV1Enabled: false,
    },
  });
  testState.api.fetchMcpTools.mockResolvedValue({ items: [] });
  testState.api.invokeMcpTool.mockResolvedValue({ ok: true, output: { items: [] } });
  testState.api.runMcpServerHealthCheck.mockResolvedValue({
    connectorType: "mcp_server",
    connectorId: "srv-1",
    status: "ok",
    checks: [],
    checkedAt: "2026-03-21T12:00:00.000Z",
  });
  testState.api.fetchPromptPacks.mockResolvedValue({
    items: [
      { packId: "pack-a", name: "Pack A", testCount: 1 },
      { packId: "pack-b", name: "Pack B", testCount: 1 },
    ],
  });
  testState.api.fetchPromptPackTests.mockImplementation(async (packId: string) => ({
    items: [
      {
        testId: `${packId}-test-1`,
        packId,
        code: packId === "pack-a" ? "A-01" : "B-01",
        title: packId === "pack-a" ? "Alpha test" : "Bravo test",
        prompt: `Prompt for ${packId}`,
        createdAt: "2026-03-21T12:00:00.000Z",
        updatedAt: "2026-03-21T12:00:00.000Z",
      },
    ],
  }));
  testState.api.fetchPromptPackReport.mockResolvedValue(createPromptPackReport());
  testState.api.fetchPromptPackExport.mockImplementation(async (packId: string) => ({
    packId,
    path: "",
    exists: false,
    sizeBytes: 0,
  }));
  testState.api.fetchPromptPackTrends.mockResolvedValue({ items: [] });
});

describe("mission-control hardening", () => {
  it("prevents backdrop dismissal when confirm modal dismiss is disabled", () => {
    const onCancel = vi.fn();

    const renderer = create(
      <ConfirmModal
        open
        title="Confirm dangerous action"
        message="Do the thing?"
        disableDismiss
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );

    const modal = renderer.root.findByProps({ "data-mock-modal": "true" });
    expect(modal.props["data-dismiss-disabled"]).toBe("true");
    act(() => {
      modal.props.onClick();
    });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("disables remote approval actions when the single-use token has expired", () => {
    const renderer = create(
      <RemoteApprovalActionModal
        open
        prompt={{
          approvalId: "apr-1",
          actionType: "approval.resolve",
          tokenId: "tok-1",
          token: "grat_tok_1",
          kind: "tool.invoke",
          riskLevel: "danger",
          status: "pending",
          preview: { summary: "Approve deploy" },
          expiresAt: "2000-01-01T00:00:00.000Z",
        }}
        onApprove={() => undefined}
        onReject={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    const modal = renderer.root.findByProps({ "data-mock-modal": "true" });
    expect(modal.props["data-confirm-disabled"]).toBe("true");
    const rejectButton = renderer.root.findAllByType("button").find((node) => node.props.className === "danger");
    expect(rejectButton?.props.disabled).toBe(true);
    expect(
      renderer.root.findAllByType("p").some((node) => textContent(node).includes("This approval token expired")),
    ).toBe(true);
  });

  it("preserves dirty MCP policy edits across a refresh reload", async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<McpPage />);
    });
    await flush();

    const policyNotesInput = renderer!.root.findByProps({ id: "mcpPolicyNotes" });
    act(() => {
      policyNotesInput.props.onChange({ target: { value: "edited note" } });
    });

    expect(renderer!.root.findByProps({ id: "mcpPolicyNotes" }).props.value).toBe("edited note");
    expect(findButton(renderer!.root, "Save Policy").props.disabled).toBe(false);

    const refresh = testState.refreshRegistrations.get("mcp");
    expect(refresh?.options.enabled).toBe(true);

    await act(async () => {
      await refresh?.callback({
        topic: "mcp",
        timestamp: Date.now(),
        reason: "test-refresh",
        source: "test",
      });
    });
    await flush();

    expect(renderer!.root.findByProps({ id: "mcpPolicyNotes" }).props.value).toBe("edited note");
    expect(findButton(renderer!.root, "Save Policy").props.disabled).toBe(false);
  });

  it("keeps prompt lab refresh enabled while idle and preserves the selected pack on refresh", async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PromptLabPage workspaceId="default" />);
    });
    await flush();

    let refresh = testState.refreshRegistrations.get("quality");
    expect(refresh?.options.enabled).toBe(true);
    expect(refresh?.options.pollIntervalMs).toBe(15000);

    act(() => {
      findButton(renderer!.root, "Pack B").props.onClick();
    });
    await flush();

    expect(findButton(renderer!.root, "Pack B").props.className).toContain("active");
    expect(findButton(renderer!.root, "Pack A").props.className ?? "").not.toContain("active");

    refresh = testState.refreshRegistrations.get("quality");
    await act(async () => {
      await refresh?.callback({
        topic: "quality",
        timestamp: Date.now(),
        reason: "test-refresh",
        source: "test",
      });
    });
    await flush();

    expect(findButton(renderer!.root, "Pack B").props.className).toContain("active");
    expect(findButton(renderer!.root, "Pack A").props.className ?? "").not.toContain("active");
  });

  it("shows requested and actual models for prompt-pack runs when fallback routing occurs", async () => {
    testState.api.fetchPromptPackReport.mockResolvedValue(
      createPromptPackReport({
        runs: [
          {
            runId: "run-1",
            packId: "pack-a",
            testId: "pack-a-test-1",
            status: "completed",
            providerId: "openai",
            model: "gpt-5.4",
            responseText: "Done",
            trace: {
              turnId: "turn-1",
              sessionId: "sess-1",
              userMessageId: "user-1",
              branchKind: "append",
              status: "completed",
              mode: "chat",
              model: "gpt-4.1-mini",
              webMode: "off",
              memoryMode: "off",
              thinkingLevel: "standard",
              startedAt: "2026-03-21T12:00:00.000Z",
              finishedAt: "2026-03-21T12:00:05.000Z",
              toolRuns: [],
              citations: [],
              routing: {
                primaryProviderId: "openai",
                primaryModel: "gpt-5.4",
                effectiveProviderId: "openai",
                effectiveModel: "gpt-4.1-mini",
                fallbackProviderId: "openai",
                fallbackModel: "gpt-4.1-mini",
                fallbackUsed: true,
                fallbackReason: "primary failed (timeout)",
              },
            },
            startedAt: "2026-03-21T12:00:00.000Z",
            finishedAt: "2026-03-21T12:00:05.000Z",
          },
        ],
        summary: {
          ...createPromptPackReportBase().summary,
          completedRuns: 1,
        },
      }),
    );

    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PromptLabPage workspaceId="default" />);
    });
    await flush();

    const paragraphs = renderer!.root.findAllByType("p").map((node) => textContent(node));
    expect(
      paragraphs.some((text) => text.includes("New runs will reuse the last successful request: openai/gpt-5.4")),
    ).toBe(true);
    expect(paragraphs.some((text) => text.includes("Requested model: openai/gpt-5.4"))).toBe(true);
    expect(paragraphs.some((text) => text.includes("Actual model used: openai/gpt-4.1-mini"))).toBe(true);
    expect(paragraphs.some((text) => text.includes("fallback: openai/gpt-4.1-mini"))).toBe(true);
    expect(paragraphs.some((text) => text.includes("Fallback reason: primary failed (timeout)"))).toBe(true);
  });
});
