import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => ({
    items: [
      {
        agentId: "agent-1",
        roleId: "architect",
        status: "active",
        name: "Architect",
        title: "Systems Architect",
        summary: "Design and planning agent",
        specialties: ["Architecture", "Planning"],
        defaultTools: ["browser.search"],
        aliases: ["architect"],
        isBuiltin: true,
        editable: false,
        lifecycleStatus: "active",
        sessionCount: 2,
        activeSessions: 1,
        lastUpdatedAt: new Date("2026-03-10T18:00:00.000Z").toISOString(),
        createdAt: new Date("2026-03-10T18:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-10T18:00:00.000Z").toISOString(),
      },
    ],
  })),
  fetchOperators: vi.fn(async () => ({
    items: [
      {
        operatorId: "operator-1",
        sessionCount: 1,
        activeSessions: 1,
        lastActivityAt: new Date("2026-03-10T18:00:00.000Z").toISOString(),
      },
    ],
  })),
  fetchApprovals: vi.fn(async () => ({ items: [] })),
  fetchRealtimeEvents: vi.fn(async () => ({
    items: [
      {
        eventId: "evt-1",
        eventType: "activity_logged",
        source: "chat",
        timestamp: new Date("2026-03-10T18:00:00.000Z").toISOString(),
        payload: {
          activity: {
            agentId: "architect",
            message: "Drafted fallback plan.",
          },
        },
      },
    ],
  })),
  connectEventStream: vi.fn((_onEvent: (event: unknown) => void, onStateChange?: (state: string) => void) => {
    onStateChange?.("open");
    return () => undefined;
  }),
}));

vi.mock("../api/client", () => ({
  fetchAgents: apiMocks.fetchAgents,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchOperators: apiMocks.fetchOperators,
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  connectEventStream: apiMocks.connectEventStream,
}));

vi.mock("../components/PixelOfficeCanvas", () => ({
  PixelOfficeCanvas: (props: {
    selectedAgentId: string | null;
    selectedAgentReadoutOverride?: string | null;
    onSelectAgent: (agentId: string, zoneId: "command") => void;
    onAgentCommand?: (command: {
      agentId: string;
      agentName: string;
      zoneId: "command";
      zoneLabel: string;
      kind: "move";
      targetLabel: string;
      summary: string;
      issuedAt: string;
    }) => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onSelectAgent("agent-1", "command")}>Select Architect</button>
      <button
        type="button"
        onClick={() => props.onAgentCommand?.({
          agentId: "agent-1",
          agentName: "Architect",
          zoneId: "command",
          zoneLabel: "Command Deck",
          kind: "move",
          targetLabel: "tile 4,8",
          summary: "Directed Architect to tile 4,8 in Command Deck.",
          issuedAt: "2026-03-10T18:03:00.000Z",
        })}
      >
        Issue Move
      </button>
      <p>Mock selected agent: {props.selectedAgentId ?? "none"}</p>
      <p>Mock readout: {props.selectedAgentReadoutOverride ?? "none"}</p>
    </div>
  ),
}));

import { OfficeLabPage } from "./OfficeLabPage";

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

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const instanceText = (node: unknown): string => {
    if (typeof node === "string") {
      return node;
    }
    if (!node || typeof node !== "object" || !("children" in node)) {
      return "";
    }
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map((child) => instanceText(child)).join(" ");
  };
  const button = renderer.root.findAll((node) => {
    if (node.type !== "button") {
      return false;
    }
    const text = instanceText(node).replace(/\s+/g, " ");
    return text.includes(label);
  })[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("OfficeLabPage A2UI mutation signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T18:02:00.000Z"));
    vi.clearAllMocks();
  });

  it("surfaces the last directed canvas command in the readout and inspector", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OfficeLabPage />);
      });
      await flush();

      await clickButton(renderer, "Select Architect");
      await clickButton(renderer, "Issue Move");
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Mock selected agent: agent-1");
      expect(text).toContain("Mock readout: Directed Architect to tile 4,8 in Command Deck.");
      expect(text).toContain("Canvas command Directed Architect to tile 4,8 in Command Deck.");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });
});
