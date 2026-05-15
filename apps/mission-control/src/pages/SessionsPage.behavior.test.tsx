import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchRuntimeLifecycle: vi.fn(),
  fetchSessionSummary: vi.fn(),
  fetchSessionTimeline: vi.fn(),
  fetchSessions: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);

vi.mock("react-virtuoso", () => ({
  Virtuoso: <T,>({
    data = [],
    itemContent,
  }: {
    data?: T[];
    itemContent: (index: number, item: T) => React.ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>
      ))}
    </div>
  ),
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: ({ lines }: { lines?: number }) => <div>Loading {lines}</div>,
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
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

vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </section>
  ),
}));

vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: ({
    value,
    onChange,
    customLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    customLabel?: string;
  }) => (
    <label>
      {customLabel}
      <input aria-label={customLabel} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCSelect: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
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
    sessions: {
      title: "Sessions",
      subtitle: "Inspect session health.",
    },
  },
}));

import { SessionsPage, sessionBudgetTone, sessionHealthTone } from "./SessionsPage";

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

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
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

const sessions = [
  {
    sessionId: "sess-alpha",
    sessionKey: "dm:alpha",
    kind: "chat",
    channel: "web",
    account: "operator",
    health: "healthy",
    budgetState: "ok",
    tokenTotal: 1200,
    costUsdTotal: 0.12,
    updatedAt: "2026-04-01T12:00:00.000Z",
    lastActivityAt: "2026-04-01T12:00:00.000Z",
  },
  {
    sessionId: "sess-beta",
    sessionKey: "thread:beta",
    kind: "cowork",
    channel: "slack",
    account: "ops",
    health: "degraded",
    budgetState: "warning",
    tokenTotal: 2400,
    costUsdTotal: 0.24,
    updatedAt: "2026-04-01T12:05:00.000Z",
    lastActivityAt: "2026-04-01T12:05:00.000Z",
  },
  {
    sessionId: "sess-gamma",
    sessionKey: "group:gamma",
    kind: "code",
    channel: "desktop",
    account: "builder",
    health: "blocked",
    budgetState: "hard_cap",
    tokenTotal: 3600,
    costUsdTotal: 0.36,
    updatedAt: "2026-04-01T12:10:00.000Z",
    lastActivityAt: "2026-04-01T12:10:00.000Z",
  },
];

describe("SessionsPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchSessions.mockResolvedValue({ items: sessions });
    apiMocks.fetchSessionSummary.mockImplementation(async (sessionId: string) => ({
      sessionId,
      lastMessagePreview: `Last message for ${sessionId}`,
      transcriptEventCount: sessionId === "sess-gamma" ? 2 : 1,
      latestEventType: sessionId === "sess-gamma" ? "tool.result" : "assistant.message",
    }));
    apiMocks.fetchSessionTimeline.mockImplementation(async (sessionId: string) => ({
      items: [
        {
          eventId: `${sessionId}-event`,
          type: "assistant.message",
          actorType: "assistant",
          preview: `Timeline preview for ${sessionId}`,
          timestamp: "2026-04-01T12:15:00.000Z",
        },
      ],
    }));
    apiMocks.fetchRuntimeLifecycle.mockImplementation(async ({ sessionId }: { sessionId: string }) => ({
      query: { sessionId },
      linked: {
        sessionIds: [sessionId],
        turnIds: ["turn-1", "turn-2"],
        runIds: ["run-1"],
        proactiveRunIds: [],
        approvalIds: ["approval-1"],
        taskIds: ["task-1"],
        workspaceIds: ["default"],
      },
      executionPlans: [
        {
          planId: `plan-${sessionId}`,
          status: "running",
          objective: `Objective for ${sessionId}`,
        },
      ],
      delegationRuns: [{ runId: "delegate-1" }],
      delegationSteps: [
        {
          stepId: "step-1",
          role: "Coder",
          status: "completed",
          durableRunId: "durable-1",
          childSessionId: "child-session-1",
          childTurnId: "turn-child-1",
        },
      ],
      proactiveDurableRun: { runId: "proactive-run-1" },
      approvalWaitDurableRun: { runId: "approval-wait-1" },
      durableRun: { runId: "queried-run-1" },
    }));
  });

  it("renders session health rollups, linked runtime detail, filtering, and table mode", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SessionsPage />);
      });
      await flush();

      let text = rendererText(renderer);
      expect(apiMocks.fetchSessions).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSessionSummary).toHaveBeenCalledWith("sess-alpha");
      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith({ sessionId: "sess-alpha" });
      expect(text).toContain("1 healthy");
      expect(text).toContain("1 degraded");
      expect(text).toContain("1 blocked");
      expect(text).toContain("Last message for sess-alpha");
      expect(text).toContain("Linked runtime context");
      expect(text).toContain("Objective for sess-alpha");
      expect(text).toContain("durable durable-1");
      expect(text).toContain("Timeline preview for sess-alpha");

      const healthSelect = renderer.root.findAllByType("select")[0];
      await act(async () => {
        healthSelect?.props.onChange({ target: { value: "blocked" } });
      });
      await flush();

      text = rendererText(renderer);
      expect(apiMocks.fetchSessionSummary).toHaveBeenCalledWith("sess-gamma");
      expect(text).toContain("group:gamma");
      expect(text).toContain("Last message for sess-gamma");
      expect(text).not.toContain("thread:beta");

      const switchButton = renderer.root.findAll(
        (node) => node.type === "button" && instanceText(node).includes("Switch to table view"),
      )[0];
      await act(async () => {
        switchButton?.props.onClick();
      });
      await flush();

      text = rendererText(renderer);
      expect(text).toContain("Sessions Table");
      expect(text).toContain("group:gamma");

      const searchInput = renderer.root.findByProps({ "aria-label": "Search query" });
      await act(async () => {
        searchInput.props.onChange({ target: { value: "not-present" } });
      });
      await flush();

      expect(rendererText(renderer)).toContain("No sessions match the current filter.");
    } finally {
      renderer.unmount();
    }
  });

  it("maps session health and budget states to operator status tones", () => {
    expect(sessionHealthTone("healthy")).toBe("success");
    expect(sessionHealthTone("degraded")).toBe("warning");
    expect(sessionHealthTone("blocked")).toBe("critical");
    expect(sessionHealthTone("unknown" as any)).toBe("warning");
    expect(sessionBudgetTone("ok")).toBe("muted");
    expect(sessionBudgetTone("warning")).toBe("warning");
    expect(sessionBudgetTone("hard_cap")).toBe("critical");
    expect(sessionBudgetTone("unknown" as any)).toBe("warning");
  });
});
