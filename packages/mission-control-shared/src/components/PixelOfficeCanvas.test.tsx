import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeZoneId } from "../data/office-zones";
import { PixelOfficeCanvas, type PixelOfficeCanvasCommand } from "./PixelOfficeCanvas";

const assetMocks = vi.hoisted(() => ({
  supported: false,
  loadPixelOfficeRuntimeAssets: vi.fn(),
}));

const loopMocks = vi.hoisted(() => ({
  startGameLoop: vi.fn(),
}));

const renderMocks = vi.hoisted(() => ({
  renderFrame: vi.fn(),
}));

const officeMocks = vi.hoisted(() => {
  const instances: any[] = [];
  class FakeOfficeState {
    layout = {
      cols: 5,
      rows: 4,
      tileColors: [],
    };
    tileMap = [[1]];
    furniture: unknown[] = [];
    seats = new Map([
      ["seat-1", { seatCol: 1, seatRow: 1, assigned: false }],
      ["seat-owned", { seatCol: 2, seatRow: 1, assigned: true }],
    ]);
    characters = new Map([
      [
        1,
        {
          id: 1,
          x: 16,
          y: 16,
          tileCol: 1,
          tileRow: 1,
          seatId: "seat-owned",
        },
      ],
    ]);
    selectedAgentId: number | null = null;
    cameraFollowId: number | null = null;
    hoveredAgentId: number | null = null;
    hoveredTile: { col: number; row: number } | null = null;
    subagentKeys = new Set<string>();
    removed: number[] = [];
    commands: string[] = [];

    constructor() {
      instances.push(this);
    }

    getLayout() {
      return this.layout;
    }

    addAgent(id: number) {
      this.characters.set(id, {
        id,
        x: 16,
        y: 16,
        tileCol: 1,
        tileRow: 1,
        seatId: "seat-owned",
      });
      this.commands.push(`add:${id}`);
    }

    removeAgent(id: number) {
      this.removed.push(id);
      this.characters.delete(id);
    }

    setAgentActive(id: number, active: boolean) {
      this.commands.push(`active:${id}:${active}`);
    }

    setAgentTool(id: number, tool: string | null) {
      this.commands.push(`tool:${id}:${tool}`);
    }

    showPermissionBubble(id: number) {
      this.commands.push(`permission:${id}`);
    }

    clearPermissionBubble(id: number) {
      this.commands.push(`clear:${id}`);
    }

    getSubagentId(parent: number, tool: string) {
      return this.subagentKeys.has(`${parent}:${tool}`) ? -1 : null;
    }

    addSubagent(parent: number, tool: string) {
      this.subagentKeys.add(`${parent}:${tool}`);
      this.commands.push(`subagent:${parent}:${tool}`);
      return -1;
    }

    update(dt: number) {
      this.commands.push(`update:${dt}`);
    }

    getCharacters() {
      return Array.from(this.characters.values());
    }

    getCharacterAt() {
      return this.hoveredAgentId;
    }

    getSeatAtTile(col: number, row: number) {
      if (col === 1 && row === 1) {
        return "seat-1";
      }
      if (col === 2 && row === 1) {
        return "seat-owned";
      }
      return null;
    }

    sendToSeat(id: number) {
      this.commands.push(`send:${id}`);
    }

    reassignSeat(id: number, seatId: string) {
      this.commands.push(`reassign:${id}:${seatId}`);
    }

    walkToTile(id: number, col: number, row: number) {
      this.commands.push(`walk:${id}:${col}:${row}`);
      return true;
    }

    dismissBubble(id: number) {
      this.commands.push(`dismiss:${id}`);
    }
  }
  return { instances, FakeOfficeState };
});

vi.mock("../pixel-office/assetLoader", () => ({
  loadPixelOfficeRuntimeAssets: assetMocks.loadPixelOfficeRuntimeAssets,
  supportsPixelOfficeRuntime: () => assetMocks.supported,
}));

vi.mock("../pixel-office/engine/gameLoop", () => ({
  startGameLoop: loopMocks.startGameLoop,
}));

vi.mock("../pixel-office/engine/renderer", () => ({
  renderFrame: renderMocks.renderFrame,
}));

vi.mock("../pixel-office/engine/officeState", () => ({
  OfficeState: officeMocks.FakeOfficeState,
}));

const zones = [
  {
    zoneId: "command" as OfficeZoneId,
    label: "Command",
    activeAgents: 1,
    pendingApprovalCount: 1,
    leadAction: "Watching approvals.",
    agents: [
      {
        agentId: "agent-a",
        name: "Agent A",
        zoneId: "command" as OfficeZoneId,
        zoneLabel: "Command",
        urgency: "active" as const,
        activeSessions: 1,
        pendingApprovalCount: 1,
        latestAction: "Running a tool.",
      },
    ],
  },
  {
    zoneId: "research" as OfficeZoneId,
    label: "Research",
    activeAgents: 0,
    pendingApprovalCount: 0,
    leadAction: "Standing by.",
    agents: [
      {
        agentId: "agent-b",
        name: "Agent B",
        zoneId: "research" as OfficeZoneId,
        zoneLabel: "Research",
        urgency: "idle" as const,
        activeSessions: 0,
        pendingApprovalCount: 0,
        latestAction: "Idle.",
      },
    ],
  },
];

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferredAssetLoad() {
  let resolve!: (value: { defaultLayout: { cols: number; rows: number; tiles: never[]; furniture: never[] } }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ defaultLayout: { cols: number; rows: number; tiles: never[]; furniture: never[] } }>(
    (promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    },
  );
  return { promise, resolve, reject };
}

function createWithNodeMocks(element: React.ReactElement) {
  return create(element, {
    createNodeMock: ({ type }) => {
      if (type === "canvas") {
        return {
          width: 0,
          height: 0,
          style: {},
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 160, height: 120 }),
          getContext: () => ({ clearRect: vi.fn() }),
        };
      }
      if (type === "div") {
        return {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 160, height: 120 }),
        };
      }
      return {};
    },
  });
}

describe("PixelOfficeCanvas", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    assetMocks.supported = false;
    assetMocks.loadPixelOfficeRuntimeAssets.mockResolvedValue({
      defaultLayout: { cols: 5, rows: 4, tiles: [], furniture: [] },
    });
    loopMocks.startGameLoop.mockImplementation((_canvas, callbacks) => {
      callbacks.update(0.16);
      callbacks.render({ clearRect: vi.fn() });
      return vi.fn();
    });
    renderMocks.renderFrame.mockReturnValue({ offsetX: 0, offsetY: 0 });
    officeMocks.instances.length = 0;
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        devicePixelRatio: 2,
      },
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.clearAllMocks();
  });

  it("renders a deterministic unsupported-runtime fallback and zone deck", () => {
    const onSelectZone = vi.fn();
    renderer = createWithNodeMocks(
      <PixelOfficeCanvas
        zones={zones}
        selectedAgentId={null}
        selectedZoneId="command"
        onSelectAgent={vi.fn()}
        onSelectZone={onSelectZone}
      />,
    );

    expect(renderer.root.findByProps({ className: "pixel-office-loading" }).children.join("")).toContain("disabled");
    act(() => {
      renderer!.root.findAllByType("button")[1].props.onClick();
    });
    expect(onSelectZone).toHaveBeenCalledWith("research");
  });

  it("loads the runtime, maps agents, renders frames, and emits movement commands", async () => {
    assetMocks.supported = true;
    const onSelectAgent = vi.fn();
    const onSelectZone = vi.fn();
    const commands: PixelOfficeCanvasCommand[] = [];

    await act(async () => {
      renderer = createWithNodeMocks(
        <PixelOfficeCanvas
          zones={zones}
          selectedAgentId="agent-a"
          selectedZoneId="command"
          selectedAgentReadoutOverride="Override readout"
          recentEvents={[
            {
              eventId: "event-1",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:00.000Z",
              payload: { agentId: "agent-a", toolId: "tool-1" },
            } as never,
          ]}
          onSelectAgent={onSelectAgent}
          onSelectZone={onSelectZone}
          onAgentCommand={(command) => commands.push(command)}
        />,
      );
    });
    await flush();

    const state = officeMocks.instances[0];
    expect(assetMocks.loadPixelOfficeRuntimeAssets).toHaveBeenCalledTimes(1);
    expect(state.commands).toEqual(
      expect.arrayContaining(["active:1:true", "tool:1:Task", "permission:1", "subagent:1:tool-1"]),
    );
    expect(loopMocks.startGameLoop).toHaveBeenCalledTimes(1);
    expect(renderMocks.renderFrame).toHaveBeenCalled();

    state.hoveredAgentId = 1;
    const canvas = renderer.root.findByType("canvas");
    act(() => {
      canvas.props.onMouseDown({ button: 0, clientX: 20, clientY: 20 });
      canvas.props.onMouseMove({ clientX: 40, clientY: 40 });
      canvas.props.onMouseUp({ clientX: 32, clientY: 32 });
    });
    expect(onSelectAgent).toHaveBeenCalledWith("agent-a", "command");

    act(() => {
      canvas.props.onContextMenu({ preventDefault: vi.fn(), clientX: 32, clientY: 32 });
    });
    expect(commands.some((command) => command.kind === "move")).toBe(true);

    await act(async () => {
      renderer!.update(
        <PixelOfficeCanvas
          zones={[zones[0]]}
          selectedAgentId={null}
          selectedZoneId="command"
          recentEvents={[]}
          onSelectAgent={onSelectAgent}
          onSelectZone={onSelectZone}
          onAgentCommand={(command) => commands.push(command)}
        />,
      );
    });
    expect(state.removed).toContain(2);
  });

  it("ignores late asset load settlement after unmount", async () => {
    assetMocks.supported = true;
    const resolved = deferredAssetLoad();
    assetMocks.loadPixelOfficeRuntimeAssets.mockReturnValueOnce(resolved.promise);

    renderer = createWithNodeMocks(
      <PixelOfficeCanvas
        zones={zones}
        selectedAgentId={null}
        selectedZoneId="command"
        onSelectAgent={vi.fn()}
        onSelectZone={vi.fn()}
      />,
    );
    renderer.unmount();
    renderer = null;

    await act(async () => {
      resolved.resolve({ defaultLayout: { cols: 5, rows: 4, tiles: [], furniture: [] } });
      await resolved.promise;
    });

    const rejected = deferredAssetLoad();
    assetMocks.loadPixelOfficeRuntimeAssets.mockReturnValueOnce(rejected.promise);
    renderer = createWithNodeMocks(
      <PixelOfficeCanvas
        zones={zones}
        selectedAgentId={null}
        selectedZoneId="command"
        onSelectAgent={vi.fn()}
        onSelectZone={vi.fn()}
      />,
    );
    renderer.unmount();
    renderer = null;

    await act(async () => {
      rejected.reject(new Error("late failure"));
      await rejected.promise.catch(() => undefined);
    });

    expect(officeMocks.instances).toHaveLength(0);
  });

  it("replays selection and subagent events once the runtime is ready", async () => {
    assetMocks.supported = true;

    await act(async () => {
      renderer = createWithNodeMocks(
        <PixelOfficeCanvas
          zones={zones}
          selectedAgentId="agent-b"
          selectedZoneId="research"
          recentEvents={[
            {
              eventId: "ignored-kind",
              eventType: "message.created",
              timestamp: "2026-05-12T00:00:00.000Z",
              payload: { agentId: "agent-a", toolId: "tool-x" },
            } as never,
            {
              eventId: "missing-parent",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:01.000Z",
              payload: { toolId: "tool-x" },
            } as never,
            {
              eventId: "unknown-parent",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:02.000Z",
              payload: { parentAgentId: "missing", toolId: "tool-x" },
            } as never,
            {
              eventId: "child-1",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:03.000Z",
              payload: { parentAgentId: "agent-a", subagentId: "worker-1" },
            } as never,
            {
              eventId: "child-1-duplicate",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:04.000Z",
              payload: { parentAgentId: "agent-a", subagentId: "worker-1" },
            } as never,
            {
              eventId: "fallback-tool",
              eventType: "subagent_registered",
              timestamp: "2026-05-12T00:00:05.000Z",
              payload: { runtimeAgentId: "agent-b" },
            } as never,
          ]}
          onSelectAgent={vi.fn()}
          onSelectZone={vi.fn()}
        />,
      );
    });
    await flush();

    const state = officeMocks.instances[0];
    expect(state.selectedAgentId).toBe(2);
    expect(state.cameraFollowId).toBe(2);
    expect(state.commands.filter((command: string) => command === "subagent:1:worker-1")).toHaveLength(1);
    expect(state.commands).toContain("subagent:2:fallback-tool");
  });

  it("drives pointer selection, seat reassignment, return-to-seat, hover, and empty floor commands", async () => {
    assetMocks.supported = true;
    const onSelectAgent = vi.fn();
    const onSelectZone = vi.fn();
    const commands: PixelOfficeCanvasCommand[] = [];

    await act(async () => {
      renderer = createWithNodeMocks(
        <PixelOfficeCanvas
          zones={zones}
          selectedAgentId="agent-a"
          selectedZoneId="command"
          onSelectAgent={onSelectAgent}
          onSelectZone={onSelectZone}
          onAgentCommand={(command) => commands.push(command)}
        />,
      );
    });
    await flush();

    const state = officeMocks.instances[0];
    const canvas = renderer.root.findByType("canvas");

    act(() => {
      canvas.props.onMouseDown({ button: 1, clientX: 20, clientY: 20 });
    });

    state.hoveredAgentId = null;
    act(() => {
      canvas.props.onMouseMove({ clientX: 32, clientY: 32 });
    });
    expect(canvas.props.style?.cursor ?? "pointer").not.toBe("not-used");

    act(() => {
      canvas.props.onMouseLeave();
    });
    expect(state.hoveredAgentId).toBeNull();
    expect(state.hoveredTile).toBeNull();

    state.hoveredAgentId = 1;
    state.selectedAgentId = 1;
    act(() => {
      canvas.props.onMouseDown({ button: 0, clientX: 20, clientY: 20 });
      canvas.props.onMouseUp({ clientX: 20, clientY: 20 });
    });
    expect(onSelectZone).toHaveBeenCalledWith("command");

    state.hoveredAgentId = 1;
    state.selectedAgentId = null;
    act(() => {
      canvas.props.onMouseDown({ button: 0, clientX: 20, clientY: 20 });
      canvas.props.onMouseUp({ clientX: 20, clientY: 20 });
    });
    expect(state.commands).toContain("dismiss:1");
    expect(onSelectAgent).toHaveBeenCalledWith("agent-a", "command");

    state.hoveredAgentId = 1;
    act(() => {
      canvas.props.onMouseDown({ button: 0, clientX: 20, clientY: 20 });
      canvas.props.onMouseMove({ clientX: 60, clientY: 60 });
      canvas.props.onMouseUp({ clientX: 32, clientY: 32 });
    });
    expect(commands.some((command) => command.kind === "reassign_seat")).toBe(true);

    state.selectedAgentId = 1;
    act(() => {
      canvas.props.onMouseUp({ clientX: 54, clientY: 30 });
    });
    expect(commands.some((command) => command.kind === "return_to_seat")).toBe(true);

    state.selectedAgentId = 1;
    act(() => {
      canvas.props.onMouseUp({ clientX: 100, clientY: 80 });
    });
    expect(commands.some((command) => command.kind === "move")).toBe(true);

    state.selectedAgentId = null;
    const preventDefault = vi.fn();
    act(() => {
      canvas.props.onContextMenu({ preventDefault, clientX: 32, clientY: 32 });
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("surfaces runtime load failures", async () => {
    assetMocks.supported = true;
    assetMocks.loadPixelOfficeRuntimeAssets.mockRejectedValueOnce(new Error("asset load failed"));

    await act(async () => {
      renderer = createWithNodeMocks(
        <PixelOfficeCanvas
          zones={zones}
          selectedAgentId={null}
          selectedZoneId={null}
          onSelectAgent={vi.fn()}
          onSelectZone={vi.fn()}
        />,
      );
    });
    await flush();

    expect(renderer.root.findByProps({ className: "pixel-office-loading" }).children.join("")).toBe(
      "asset load failed",
    );
  });
});
