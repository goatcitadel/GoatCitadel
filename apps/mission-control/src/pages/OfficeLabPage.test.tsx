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
      {
        agentId: "agent-2",
        roleId: "qa",
        status: "idle",
        name: "QA",
        title: "Verification Lead",
        summary: "Quality verification agent",
        specialties: ["Testing", "Regression"],
        defaultTools: ["shell.exec"],
        aliases: ["qa"],
        isBuiltin: true,
        editable: false,
        lifecycleStatus: "active",
        sessionCount: 1,
        activeSessions: 0,
        lastUpdatedAt: new Date("2026-03-10T17:57:00.000Z").toISOString(),
        createdAt: new Date("2026-03-10T17:57:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-10T17:57:00.000Z").toISOString(),
      },
    ],
  })),
  fetchOperators: vi.fn(async () => ({
    items: [
      {
        operatorId: "operator-1",
        sessionCount: 3,
        activeSessions: 1,
        lastActivityAt: new Date("2026-03-10T18:00:00.000Z").toISOString(),
      },
    ],
  })),
  fetchApprovals: vi.fn(async () => ({
    items: [
      {
        approvalId: "approval-1",
        kind: "tool.invoke",
        riskLevel: "high",
        status: "pending",
        roleId: "architect",
        createdAt: new Date("2026-03-10T17:59:30.000Z").toISOString(),
      },
    ],
  })),
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
          taskId: "task-1",
          sessionId: "sess-1",
        },
      },
    ],
  })),
  connectEventStream: vi.fn((onEvent: (event: unknown) => void, onStateChange?: (state: string) => void) => {
    onStateChange?.("open");
    onEvent({
      eventId: "evt-live-1",
      eventType: "activity_logged",
      source: "chat",
      timestamp: new Date("2026-03-10T18:01:00.000Z").toISOString(),
      payload: {
        activity: {
          agentId: "qa",
          message: "Ran regression pass.",
        },
        taskId: "task-2",
        sessionId: "sess-2",
      },
    });
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

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("OfficeLabPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T18:02:00.000Z"));
    vi.clearAllMocks();
  });

  it("renders a separate 2D office surface with an agent-office style room map and overlay panels", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OfficeLabPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Herd Lab");
      expect(text).toContain("Command Deck");
      expect(text).toContain("Build Bay");
      expect(text).toContain("Research Lab");
      expect(text).toContain("Security Watch");
      expect(text).toContain("Ops Lane");
      expect(text).toContain("Architect");
      expect(text).toContain("QA");
      expect(text).toContain("Drafted fallback plan.");
      expect(text).toContain("Ran regression pass.");
      expect(text).toContain("Task Board");
      expect(text).toContain("System Log");
      expect(text).toContain("Reload office");
      expect(text).toContain("A2UI proof target: move from a zone view to an agent selection, then issue a seat or tile command and confirm the readout plus Inspector panel both reflect the directed mutation.");
      expect(apiMocks.fetchAgents).toHaveBeenCalledWith("all", 300);
      expect(apiMocks.fetchApprovals).toHaveBeenCalledWith("pending");
      expect(apiMocks.connectEventStream).toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });
});
