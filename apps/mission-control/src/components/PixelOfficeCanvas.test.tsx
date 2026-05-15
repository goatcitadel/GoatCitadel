import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeZoneId } from "../data/office-zones";

const runtimeState = vi.hoisted(() => ({
  supported: true,
  loadReject: null as Error | null,
  loopStop: vi.fn(),
  hitCharacterId: null as number | null,
  hoveredSeatId: null as string | null,
  characterSeatId: undefined as string | undefined,
  walkResult: true,
  latestOfficeState: null as null | {
    characters: Map<number, { id: number; x: number; y: number; seatId?: string }>;
    seats: Map<string, { seatCol: number; seatRow: number; assigned?: boolean }>;
    selectedAgentId: number | null;
    hoveredAgentId: number | null;
    hoveredTile: { col: number; row: number } | null;
    walkToTile: ReturnType<typeof vi.fn>;
    reassignSeat: ReturnType<typeof vi.fn>;
    sendToSeat: ReturnType<typeof vi.fn>;
    dismissBubble: ReturnType<typeof vi.fn>;
    addSubagent: ReturnType<typeof vi.fn>;
    removeAgent: ReturnType<typeof vi.fn>;
    clearPermissionBubble: ReturnType<typeof vi.fn>;
    showPermissionBubble: ReturnType<typeof vi.fn>;
    setAgentTool: ReturnType<typeof vi.fn>;
    setAgentActive: ReturnType<typeof vi.fn>;
  },
  existingSubagentId: null as number | null,
}));

vi.mock("../pixel-office/assetLoader", () => ({
  supportsPixelOfficeRuntime: () => runtimeState.supported,
  loadPixelOfficeRuntimeAssets: () => {
    if (runtimeState.loadReject) {
      return Promise.reject(runtimeState.loadReject);
    }
    return Promise.resolve({
      defaultLayout: {
        cols: 12,
        rows: 8,
        tileColors: {},
      },
    });
  },
}));

vi.mock("../pixel-office/engine/gameLoop", () => ({
  startGameLoop: vi.fn(
    (_canvas: unknown, callbacks: { update: (dt: number) => void; render: (ctx: unknown) => void }) => {
      callbacks.update(16);
      callbacks.render({});
      return runtimeState.loopStop;
    },
  ),
}));

vi.mock("../pixel-office/engine/renderer", () => ({
  renderFrame: vi.fn(() => ({ offsetX: 0, offsetY: 0 })),
}));

vi.mock("../pixel-office/engine/officeState", () => ({
  OfficeState: class MockOfficeState {
    characters = new Map<number, { id: number; x: number; y: number; seatId?: string }>();
    cameraFollowId: number | null = null;
    selectedAgentId: number | null = null;
    hoveredAgentId: number | null = null;
    hoveredTile: { col: number; row: number } | null = null;
    seats = new Map([["seat-1", { seatCol: 2, seatRow: 2, assigned: false }]]);
    tileMap = {};
    furniture = [];
    layout = { tileColors: {}, cols: 12, rows: 8 };
    walkToTile = vi.fn(() => runtimeState.walkResult);
    reassignSeat = vi.fn();
    sendToSeat = vi.fn();
    dismissBubble = vi.fn();
    removeAgent = vi.fn((id: number) => {
      this.characters.delete(id);
    });
    setAgentActive = vi.fn();
    setAgentTool = vi.fn();
    showPermissionBubble = vi.fn();
    clearPermissionBubble = vi.fn();
    addSubagent = vi.fn();

    constructor(layout: { cols: number; rows: number; tileColors: Record<string, string> }) {
      this.layout = layout;
      runtimeState.latestOfficeState = this;
    }

    addAgent(id: number) {
      this.characters.set(id, { id, x: 32, y: 32, seatId: runtimeState.characterSeatId });
    }

    getCharacters() {
      return [...this.characters.values()];
    }

    getLayout() {
      return this.layout;
    }

    update() {}
    getSubagentId() {
      return runtimeState.existingSubagentId;
    }
    getCharacterAt() {
      return runtimeState.hitCharacterId;
    }
    getSeatAtTile() {
      return runtimeState.hoveredSeatId;
    }
  },
}));

import { PixelOfficeCanvas, extractStringHint } from "./PixelOfficeCanvas";

const zones: React.ComponentProps<typeof PixelOfficeCanvas>["zones"] = [
  {
    zoneId: "command" as OfficeZoneId,
    label: "Command",
    activeAgents: 1,
    pendingApprovalCount: 1,
    leadAction: "Coordinating work.",
    agents: [
      {
        agentId: "agent-1",
        name: "Architect Goat",
        zoneId: "command" as OfficeZoneId,
        zoneLabel: "Command",
        urgency: "active" as const,
        activeSessions: 1,
        pendingApprovalCount: 1,
        latestAction: "Reviewing plans.",
      },
    ],
  },
  {
    zoneId: "build" as OfficeZoneId,
    label: "Build",
    activeAgents: 0,
    pendingApprovalCount: 0,
    leadAction: "Waiting for work.",
    agents: [],
  },
];

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
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("PixelOfficeCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.supported = true;
    runtimeState.loadReject = null;
    runtimeState.loopStop = vi.fn();
    runtimeState.hitCharacterId = null;
    runtimeState.hoveredSeatId = null;
    runtimeState.characterSeatId = undefined;
    runtimeState.walkResult = true;
    runtimeState.latestOfficeState = null;
    runtimeState.existingSubagentId = null;
    if (typeof window === "undefined") {
      vi.stubGlobal("window", {
        devicePixelRatio: 1,
      });
    }
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
  });

  it("renders the unsupported environment fallback and keeps deck selection available", async () => {
    runtimeState.supported = false;
    const onSelectZone = vi.fn();
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId={null}
            selectedZoneId="command"
            onSelectAgent={vi.fn()}
            onSelectZone={onSelectZone}
          />,
        );
      });

      const buildButton = renderer.root.findAll(
        (node) => node.type === "button" && instanceText(node).includes("Build"),
      )[0];
      await act(async () => {
        buildButton?.props.onClick();
      });

      expect(rendererText(renderer)).toContain("Pixel office preview is disabled in this test environment.");
      expect(onSelectZone).toHaveBeenCalledWith("build");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces runtime load failures without hiding the office readout", async () => {
    runtimeState.loadReject = new Error("asset manifest missing");
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId={null}
            selectedZoneId="command"
            recentEvents={[]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
          />,
        );
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("asset manifest missing");
      expect(text).toContain("Command");
      expect(text).toContain("Coordinating work.");
    } finally {
      renderer.unmount();
    }
  });

  it("renders the selected agent readout after runtime assets are ready", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId="agent-1"
            selectedZoneId="command"
            selectedAgentReadoutOverride="Manual override."
            recentEvents={[
              {
                eventId: "event-1",
                eventType: "subagent_registered",
                payload: { agentId: "agent-1", toolId: "tool-1" },
                createdAt: "2026-05-14T00:00:00.000Z",
              } as any,
            ]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
          />,
        );
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Architect Goat");
      expect(text).toContain("Manual override.");
      expect(renderer.root.findAll((node) => node.type === "canvas")).toHaveLength(1);
    } finally {
      renderer.unmount();
    }
  });

  it("extracts first available string hints from event payloads", () => {
    expect(extractStringHint({ parentAgentId: "agent-parent", toolId: "tool-a" }, ["agentId", "parentAgentId"])).toBe(
      "agent-parent",
    );
    expect(extractStringHint({ agentId: "" }, ["agentId"])).toBeNull();
    expect(extractStringHint(null, ["agentId"])).toBeNull();
  });

  it("selects, clears, drags, and context-moves agents through the canvas handlers", async () => {
    const onSelectAgent = vi.fn();
    const onSelectZone = vi.fn();
    const onAgentCommand = vi.fn();
    const canvasNode = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const containerNode = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId={null}
            selectedZoneId="command"
            recentEvents={[]}
            onSelectAgent={onSelectAgent}
            onSelectZone={onSelectZone}
            onAgentCommand={onAgentCommand}
          />,
          {
            createNodeMock: (element) => {
              if (element.type === "canvas") {
                return canvasNode;
              }
              if (element.type === "div") {
                return containerNode;
              }
              return null;
            },
          },
        );
      });
      await flush();

      const canvas = renderer.root.findByType("canvas");

      runtimeState.hitCharacterId = 1;
      await act(async () => {
        canvas.props.onMouseDown({ button: 0, clientX: 64, clientY: 64 });
        canvas.props.onMouseUp({ clientX: 64, clientY: 64 });
      });
      expect(onSelectAgent).toHaveBeenCalledWith("agent-1", "command");
      expect(runtimeState.latestOfficeState?.dismissBubble).toHaveBeenCalledWith(1);

      await act(async () => {
        canvas.props.onMouseDown({ button: 0, clientX: 64, clientY: 64 });
        canvas.props.onMouseUp({ clientX: 64, clientY: 64 });
      });
      expect(onSelectZone).toHaveBeenCalledWith("command");

      runtimeState.hitCharacterId = 1;
      runtimeState.hoveredSeatId = null;
      await act(async () => {
        canvas.props.onMouseDown({ button: 0, clientX: 64, clientY: 64 });
        canvas.props.onMouseMove({ clientX: 88, clientY: 88 });
        canvas.props.onMouseUp({ clientX: 88, clientY: 88 });
      });
      expect(runtimeState.latestOfficeState?.walkToTile).toHaveBeenCalled();
      expect(onAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          kind: "move",
          targetLabel: expect.stringContaining("tile"),
        }),
      );

      await act(async () => {
        canvas.props.onContextMenu({
          clientX: 96,
          clientY: 96,
          preventDefault: vi.fn(),
        });
      });
      expect(onAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: "Architect Goat",
          kind: "move",
        }),
      );

      await act(async () => {
        canvas.props.onMouseLeave();
      });
      expect(runtimeState.latestOfficeState?.hoveredAgentId).toBeNull();
      expect(runtimeState.latestOfficeState?.hoveredTile).toBeNull();
      expect(canvasNode.style.cursor).toBe("default");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("routes selected agents back to their seat or reassigns an open seat", async () => {
    const onAgentCommand = vi.fn();
    const canvasNode = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const containerNode = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };

    let renderer = create(<div />);
    try {
      runtimeState.hoveredSeatId = "seat-1";
      runtimeState.characterSeatId = "seat-1";
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId="agent-1"
            selectedZoneId="command"
            recentEvents={[]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
            onAgentCommand={onAgentCommand}
          />,
          {
            createNodeMock: (element) => {
              if (element.type === "canvas") {
                return canvasNode;
              }
              if (element.type === "div") {
                return containerNode;
              }
              return null;
            },
          },
        );
      });
      await flush();

      const canvas = renderer.root.findByType("canvas");
      runtimeState.latestOfficeState!.selectedAgentId = 1;
      await act(async () => {
        canvas.props.onMouseUp({ clientX: 80, clientY: 80 });
      });

      expect(runtimeState.latestOfficeState?.sendToSeat).toHaveBeenCalledWith(1);
      expect(onAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "return_to_seat",
          targetLabel: "seat 2,2",
        }),
      );

      runtimeState.latestOfficeState!.characters.set(1, { id: 1, x: 32, y: 32 });
      runtimeState.latestOfficeState!.selectedAgentId = 1;
      onAgentCommand.mockClear();
      await act(async () => {
        canvas.props.onMouseUp({ clientX: 80, clientY: 80 });
      });

      expect(runtimeState.latestOfficeState?.reassignSeat).toHaveBeenCalledWith(1, "seat-1");
      expect(onAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "reassign_seat",
          summary: expect.stringContaining("Reassigned Architect Goat"),
        }),
      );
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("syncs agent lifecycle, clears stale permissions, removes inactive agents, and dedupes subagent events", async () => {
    const canvasNode = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const containerNode = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const initialZones = [
      {
        ...zones[0]!,
        agents: [
          zones[0]!.agents[0]!,
          {
            ...zones[0]!.agents[0]!,
            agentId: "agent-2",
            name: "QA Goat",
            pendingApprovalCount: 0,
            activeSessions: 0,
            urgency: "idle" as const,
          },
        ],
      },
    ];
    let renderer = create(<div />);

    try {
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={initialZones}
            selectedAgentId={null}
            selectedZoneId="command"
            recentEvents={[]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
          />,
          {
            createNodeMock: (element) => {
              if (element.type === "canvas") {
                return canvasNode;
              }
              if (element.type === "div") {
                return containerNode;
              }
              return null;
            },
          },
        );
      });
      await flush();

      expect(runtimeState.latestOfficeState?.showPermissionBubble).toHaveBeenCalledWith(1);
      expect(runtimeState.latestOfficeState?.setAgentTool).toHaveBeenCalledWith(1, "Task");
      expect(runtimeState.latestOfficeState?.setAgentActive).toHaveBeenCalledWith(2, false);

      const updatedZones = [
        {
          ...zones[0]!,
          agents: [
            {
              ...zones[0]!.agents[0]!,
              pendingApprovalCount: 0,
            },
          ],
        },
      ];
      await act(async () => {
        renderer.update(
          <PixelOfficeCanvas
            zones={updatedZones}
            selectedAgentId="agent-1"
            selectedZoneId="command"
            recentEvents={[
              {
                eventId: "event-ignored",
                eventType: "run_started",
                payload: { agentId: "agent-1" },
                createdAt: "2026-05-14T00:00:00.000Z",
              } as any,
              {
                eventId: "event-no-parent",
                eventType: "subagent_registered",
                payload: { toolId: "tool-1" },
                createdAt: "2026-05-14T00:00:01.000Z",
              } as any,
              {
                eventId: "event-subagent-1",
                eventType: "subagent_registered",
                payload: { parentAgentId: "agent-1", toolId: "tool-1" },
                createdAt: "2026-05-14T00:00:02.000Z",
              } as any,
              {
                eventId: "event-subagent-duplicate",
                eventType: "subagent_registered",
                payload: { runtimeAgentId: "agent-1", toolId: "tool-1" },
                createdAt: "2026-05-14T00:00:03.000Z",
              } as any,
            ]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
          />,
        );
      });
      await flush();

      expect(runtimeState.latestOfficeState?.clearPermissionBubble).toHaveBeenCalledWith(1);
      expect(runtimeState.latestOfficeState?.removeAgent).toHaveBeenCalledWith(2);
      expect(runtimeState.latestOfficeState?.addSubagent).toHaveBeenCalledTimes(1);
      expect(runtimeState.latestOfficeState?.addSubagent).toHaveBeenCalledWith(1, "tool-1");

      runtimeState.existingSubagentId = -1;
      runtimeState.latestOfficeState?.addSubagent.mockClear();
      await act(async () => {
        renderer.update(
          <PixelOfficeCanvas
            zones={updatedZones}
            selectedAgentId="agent-1"
            selectedZoneId="command"
            recentEvents={[
              {
                eventId: "event-subagent-existing",
                eventType: "subagent_registered",
                payload: { agentId: "agent-1", taskId: "tool-existing" },
                createdAt: "2026-05-14T00:00:04.000Z",
              } as any,
            ]}
            onSelectAgent={vi.fn()}
            onSelectZone={vi.fn()}
          />,
        );
      });
      await flush();

      expect(runtimeState.latestOfficeState?.addSubagent).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("shows seat hover affordances and ignores failed movement commands", async () => {
    const onSelectZone = vi.fn();
    const onAgentCommand = vi.fn();
    const canvasNode = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };
    const containerNode = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    };

    let renderer = create(<div />);
    try {
      runtimeState.walkResult = false;
      await act(async () => {
        renderer = create(
          <PixelOfficeCanvas
            zones={zones}
            selectedAgentId="agent-1"
            selectedZoneId="command"
            recentEvents={[]}
            onSelectAgent={vi.fn()}
            onSelectZone={onSelectZone}
            onAgentCommand={onAgentCommand}
          />,
          {
            createNodeMock: (element) => {
              if (element.type === "canvas") {
                return canvasNode;
              }
              if (element.type === "div") {
                return containerNode;
              }
              return null;
            },
          },
        );
      });
      await flush();

      const canvas = renderer.root.findByType("canvas");
      runtimeState.hitCharacterId = null;
      runtimeState.hoveredSeatId = "seat-1";
      runtimeState.latestOfficeState!.selectedAgentId = 1;
      await act(async () => {
        canvas.props.onMouseMove({ clientX: 80, clientY: 80 });
      });
      expect(canvasNode.style.cursor).toBe("pointer");

      runtimeState.hoveredSeatId = null;
      await act(async () => {
        canvas.props.onMouseUp({ clientX: 96, clientY: 96 });
      });

      expect(onAgentCommand).not.toHaveBeenCalled();
      expect(onSelectZone).toHaveBeenCalledWith("command");

      await act(async () => {
        canvas.props.onMouseDown({ button: 2, clientX: 96, clientY: 96 });
        canvas.props.onContextMenu({ clientX: 96, clientY: 96, preventDefault: vi.fn() });
      });
      expect(onAgentCommand).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });
});
