import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StreamEvent = {
  eventId: string;
  eventType: string;
  source: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

const streamState = vi.hoisted(() => ({
  onEvent: null as null | ((event: StreamEvent) => void),
  onStateChange: null as null | ((state: string) => void),
  close: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchOperators: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchRealtimeEvents: vi.fn(),
  connectEventStream: vi.fn((onEvent: (event: StreamEvent) => void, onStateChange?: (state: string) => void) => {
    streamState.onEvent = onEvent;
    streamState.onStateChange = onStateChange ?? null;
    onStateChange?.("open");
    return streamState.close;
  }),
}));

vi.mock("../api/client", () => ({
  fetchAgents: apiMocks.fetchAgents,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchOperators: apiMocks.fetchOperators,
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  connectEventStream: apiMocks.connectEventStream,
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: ({ lines }: { lines?: number }) => <div>Loading card {lines}</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({
    actions,
    subtitle,
    title,
  }: {
    actions?: React.ReactNode;
    subtitle?: React.ReactNode;
    title?: React.ReactNode;
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
    children,
    subtitle,
    title,
  }: {
    children?: React.ReactNode;
    subtitle?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/PixelOfficeCanvas", () => ({
  PixelOfficeCanvas: ({
    onAgentCommand,
    onSelectAgent,
    onSelectZone,
    selectedAgentId,
    selectedAgentReadoutOverride,
    selectedZoneId,
    zones,
  }: {
    onAgentCommand?: (command: {
      agentId: string;
      agentName: string;
      zoneId: "research";
      zoneLabel: string;
      kind: "move";
      targetLabel: string;
      summary: string;
      issuedAt: string;
    }) => void;
    onSelectAgent: (agentId: string, zoneId: "research") => void;
    onSelectZone: (zoneId: "research") => void;
    selectedAgentId: string | null;
    selectedAgentReadoutOverride?: string | null;
    selectedZoneId: string | null;
    zones: Array<{ zoneId: string; label: string; leadAction: string }>;
  }) => (
    <div>
      <p>Canvas selected agent {selectedAgentId ?? "none"}</p>
      <p>Canvas selected zone {selectedZoneId ?? "none"}</p>
      <p>Canvas readout {selectedAgentReadoutOverride ?? "none"}</p>
      {zones.map((zone) => (
        <p key={zone.zoneId}>
          Canvas zone {zone.label}: {zone.leadAction}
        </p>
      ))}
      <button type="button" onClick={() => onSelectZone("research")}>
        Select Research Zone
      </button>
      <button type="button" onClick={() => onSelectAgent("agent-research", "research")}>
        Select Research Agent
      </button>
      <button
        type="button"
        onClick={() =>
          onAgentCommand?.({
            agentId: "agent-research",
            agentName: "Researcher",
            zoneId: "research",
            zoneLabel: "Research Lab",
            kind: "move",
            targetLabel: "desk 7",
            summary: "Directed Researcher to desk 7 in Research Lab.",
            issuedAt: "2026-05-15T16:00:00.000Z",
          })
        }
      >
        Issue Research Command
      </button>
    </div>
  ),
}));

vi.mock("../content/copy", () => ({
  pageCopy: {
    officeLab: {
      title: "Herd Lab",
    },
  },
}));

import { OfficeLabPage } from "./OfficeLabPage";

function agent(overrides: Record<string, unknown>) {
  return {
    agentId: "agent-research",
    roleId: "researcher",
    status: "idle",
    name: "Researcher",
    title: "Research Analyst",
    summary: "Discovery and synthesis.",
    specialties: ["Discovery"],
    defaultTools: ["browser.search"],
    aliases: ["researcher"],
    isBuiltin: true,
    editable: false,
    lifecycleStatus: "active",
    sessionCount: 0,
    activeSessions: 0,
    lastUpdatedAt: "2026-05-15T15:55:00.000Z",
    createdAt: "2026-05-15T15:55:00.000Z",
    updatedAt: "2026-05-15T15:55:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<StreamEvent>): StreamEvent {
  return {
    eventId: "evt-default",
    eventType: "session_event",
    source: "chat",
    timestamp: "2026-05-15T15:59:00.000Z",
    payload: { message: "Session changed." },
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    kind: "tool.invoke",
    riskLevel: "high",
    status: "pending",
    roleId: "researcher",
    createdAt: "2026-05-15T15:59:30.000Z",
    payload: {
      targets: ["researcher", { nested: "Researcher" }],
    },
    ...overrides,
  };
}

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

function instanceText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => instanceText(child)).join(" ");
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return instanceText((node as { children?: unknown }).children);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

describe("OfficeLabPage loop 39 behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T16:00:00.000Z"));
    vi.clearAllMocks();
    streamState.onEvent = null;
    streamState.onStateChange = null;
    streamState.close.mockClear();

    apiMocks.fetchAgents.mockResolvedValue({
      items: [
        agent({}),
        agent({
          agentId: "agent-ops",
          roleId: "ops",
          name: "Ops",
          title: "Runtime Operator",
          summary: "Reliability work.",
          specialties: ["Reliability"],
          aliases: ["ops"],
          sessionCount: 1,
          activeSessions: 0,
        }),
        agent({
          agentId: "agent-idle",
          roleId: "assistant",
          name: "Assistant",
          title: "Assistant",
          summary: "Standby support.",
          specialties: [],
          aliases: ["assistant"],
        }),
      ],
    });
    apiMocks.fetchOperators.mockResolvedValue({ items: [{ operatorId: "op-1" }] });
    apiMocks.fetchApprovals.mockResolvedValue({ items: [approval()] });
    apiMocks.fetchRealtimeEvents.mockResolvedValue({
      items: [
        event({
          eventId: "evt-activity",
          eventType: "activity_logged",
          timestamp: "2026-05-15T15:59:30.000Z",
          payload: { activity: { agentId: "researcher", message: "Synthesized source notes." } },
        }),
        event({
          eventId: "evt-session",
          eventType: "session_event",
          timestamp: "2026-05-15T14:00:00.000Z",
          payload: { event: "Workspace resumed." },
        }),
        event({
          eventId: "evt-resolved",
          eventType: "approval_resolved",
          timestamp: "2026-05-14T14:00:00.000Z",
          payload: { decision: "approved" },
        }),
        event({
          eventId: "evt-custom",
          eventType: "orchestration_event",
          timestamp: "2026-05-12T16:00:00.000Z",
          payload: { label: "Coordinator checkpoint." },
        }),
      ],
    });
  });

  it("drives immersive, reload error, zone selection, stream scheduling, and canvas command readouts", async () => {
    const onOpenImmersive = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OfficeLabPage onOpenImmersive={onOpenImmersive} />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Live link");
      expect(rendererText(renderer)).toContain("Waiting on operator approval.");
      expect(rendererText(renderer)).toContain("Workspace resumed.");
      expect(rendererText(renderer)).toContain("approved completed.");
      expect(rendererText(renderer)).toContain("Coordinator checkpoint.");

      await click(renderer, "Immersive");
      expect(onOpenImmersive).toHaveBeenCalled();

      await click(renderer, "Select Research Zone");
      expect(rendererText(renderer)).toContain("Canvas selected agent none");
      expect(rendererText(renderer)).toContain("Research Lab Room snapshot and current operator-facing detail.");

      await click(renderer, "Select Research Agent");
      await click(renderer, "Issue Research Command");
      expect(rendererText(renderer)).toContain("Canvas readout Directed Researcher to desk 7 in Research Lab.");
      expect(rendererText(renderer)).toContain("Canvas command Directed Researcher to desk 7 in Research Lab.");

      act(() => {
        streamState.onStateChange?.("error");
        streamState.onEvent?.(
          event({
            eventId: "evt-stream-approval",
            eventType: "approval_created",
            payload: { kind: "file write", nested: ["researcher"] },
          }),
        );
        streamState.onEvent?.(
          event({
            eventId: "evt-stream-agent",
            eventType: "subagent_registered",
            payload: { summary: "Specialist registered.", agentId: "researcher" },
          }),
        );
        streamState.onEvent?.(
          event({
            eventId: "evt-stream-agent-2",
            eventType: "subagent_updated",
            payload: {},
          }),
        );
      });
      await flush();
      expect(rendererText(renderer)).toContain("Stream degraded");
      expect(rendererText(renderer)).toContain("file write is waiting for approval.");
      expect(rendererText(renderer)).toContain("Specialist joined the floor");

      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      await flush();
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchApprovals).toHaveBeenCalledTimes(2);

      apiMocks.fetchAgents.mockRejectedValueOnce(new Error("snapshot failed"));
      await click(renderer, "Reload office");
      expect(rendererText(renderer)).toContain("snapshot failed");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("shows empty and idle states, clears stale selected agents, and cancels scheduled refreshes on unmount", async () => {
    apiMocks.fetchAgents.mockResolvedValueOnce({ items: [agent({})] }).mockResolvedValueOnce({ items: [] });
    apiMocks.fetchApprovals.mockResolvedValue({ items: [] });
    apiMocks.fetchRealtimeEvents.mockResolvedValue({ items: [] });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    let renderer: ReactTestRenderer = create(<div />);
    let didUnmount = false;
    try {
      await act(async () => {
        renderer = create(<OfficeLabPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("No event traffic yet.");
      expect(rendererText(renderer)).toContain("Standing by.");

      await click(renderer, "Select Research Agent");
      expect(rendererText(renderer)).toContain("Researcher Inspector");

      await click(renderer, "Reload office");
      expect(rendererText(renderer)).toContain("Command Deck");
      expect(rendererText(renderer)).not.toContain("Researcher Inspector");
      act(() => {
        streamState.onEvent?.(event({ eventId: "evt-pending-agent", eventType: "activity_logged", payload: {} }));
        streamState.onEvent?.(event({ eventId: "evt-pending-approval", eventType: "approval_created", payload: {} }));
      });
      renderer.unmount();
      didUnmount = true;
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      if (!didUnmount) {
        renderer.unmount();
      }
      vi.useRealTimers();
      clearTimeoutSpy.mockRestore();
    }
  });
});
