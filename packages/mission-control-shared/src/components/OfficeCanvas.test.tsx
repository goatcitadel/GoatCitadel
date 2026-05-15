import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OfficeCanvas,
  type OfficeCollaborationEdge,
  type OfficeDeskAgent,
  type OfficeOperatorModel,
  type OfficeSignalRoute,
  type OfficeZoneActivityLane,
  type OfficeZoneSceneTelemetry,
} from "./OfficeCanvas";

const fiberMocks = vi.hoisted(() => ({
  frameCallbacks: [] as Array<(state: { clock: { elapsedTime: number } }) => void>,
}));

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children, onPointerMissed }: { children: React.ReactNode; onPointerMissed?: () => void }) => (
    <div
      onClick={() => {
        onPointerMissed?.();
      }}
    >
      {children}
    </div>
  ),
  useFrame: (callback: (state: { clock: { elapsedTime: number } }) => void) => {
    fiberMocks.frameCallbacks.push(callback);
  },
  useThree: () => ({
    camera: {
      position: {
        lerp: () => undefined,
      },
      lookAt: () => undefined,
    },
  }),
}));

vi.mock("@react-three/drei", () => ({
  Html: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  OrbitControls: () => <div />,
}));

function createThreeNodeMock(element: { type: unknown }) {
  if (element.type === "group" || element.type === "mesh") {
    return {
      position: { x: 0, y: 0, z: 0, set: vi.fn() },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1, setScalar: vi.fn() },
    };
  }
  return null;
}

const threeTestOptions = {
  createNodeMock: createThreeNodeMock,
};

function runFrameCallbacks(elapsedTime = 1.2) {
  for (const callback of fiberMocks.frameCallbacks) {
    callback({ clock: { elapsedTime } });
  }
}

const operator: OfficeOperatorModel = {
  operatorId: "operator-1",
  name: "GoatHerder",
  preset: "trailblazer",
  currentThought: "Routing next work wave.",
  activityState: "idle_patrol",
};

const agents: OfficeDeskAgent[] = Array.from({ length: 14 }, (_, index) => ({
  roleId: `agent-${index + 1}`,
  name: `Agent ${index + 1}`,
  title: `Role ${index + 1}`,
  status: index % 3 === 0 ? "active" : index % 3 === 1 ? "ready" : "idle",
  risk: index % 4 === 0 ? "approval" : index % 4 === 1 ? "blocked" : index % 4 === 2 ? "error" : "none",
  currentThought: `Thought ${index + 1}`,
  currentAction: `Action ${index + 1}`,
  activityState: index % 3 === 0 ? "idle_milling" : index % 3 === 1 ? "transitioning_to_desk" : "collaborating",
  collabPeers: index > 0 ? [`agent-${index}`] : [],
}));

const edges: OfficeCollaborationEdge[] = [
  { fromRoleId: "agent-1", toRoleId: "agent-2", strength: 0.8, risk: false },
  { fromRoleId: "agent-3", toRoleId: "agent-4", strength: 0.6, risk: true },
];

const zoneTelemetry: OfficeZoneSceneTelemetry[] = [
  {
    zoneId: "command",
    label: "Command",
    activeAgents: 1,
    linkedAgents: 1,
    alertAgents: 0,
    attentionLevel: "watch",
    workloadScore: 0.52,
    landmark: "Command spire",
  },
  {
    zoneId: "research",
    label: "Research",
    activeAgents: 1,
    linkedAgents: 1,
    alertAgents: 0,
    attentionLevel: "stable",
    workloadScore: 0.38,
    landmark: "Signal halo",
  },
];

const activityLanes: OfficeZoneActivityLane[] = [
  {
    fromZoneId: "command",
    toZoneId: "research",
    fromLabel: "Command",
    toLabel: "Research",
    strength: 0.72,
    count: 3,
    risk: false,
    label: "Command and research are exchanging live work.",
  },
];

const signalRoutes: OfficeSignalRoute[] = [
  {
    roleId: "agent-1",
    zoneId: "command",
    kind: "approval",
    label: "Agent 1 needs review",
    intensity: 0.82,
  },
];

const fullZoneTelemetry: OfficeZoneSceneTelemetry[] = [
  {
    zoneId: "command",
    label: "Command",
    activeAgents: 2,
    linkedAgents: 2,
    alertAgents: 1,
    attentionLevel: "priority",
    workloadScore: 0.9,
    landmark: "Command spire",
  },
  {
    zoneId: "build",
    label: "Build",
    activeAgents: 2,
    linkedAgents: 2,
    alertAgents: 0,
    attentionLevel: "watch",
    workloadScore: 0.66,
    landmark: "Build stack",
  },
  {
    zoneId: "research",
    label: "Research",
    activeAgents: 2,
    linkedAgents: 2,
    alertAgents: 0,
    attentionLevel: "stable",
    workloadScore: 0.42,
    landmark: "Research halo",
  },
  {
    zoneId: "security",
    label: "Security",
    activeAgents: 2,
    linkedAgents: 2,
    alertAgents: 2,
    attentionLevel: "priority",
    workloadScore: 0.98,
    landmark: "Security shield",
  },
  {
    zoneId: "operations",
    label: "Operations",
    activeAgents: 2,
    linkedAgents: 2,
    alertAgents: 0,
    attentionLevel: "watch",
    workloadScore: 0.58,
    landmark: "Ops relay",
  },
];

const silhouetteAgents: OfficeDeskAgent[] = [
  { zoneId: "command", roleId: "r0-f9tv", title: "t4q4w-0", risk: "approval", status: "active" },
  { zoneId: "command", roleId: "r3-ko8c", title: "thh25-3", risk: "none", status: "ready" },
  { zoneId: "build", roleId: "r0-jlo1", title: "tks3y-0", risk: "none", status: "active" },
  { zoneId: "build", roleId: "r4-d7u5", title: "tjk5h-4", risk: "blocked", status: "idle" },
  { zoneId: "research", roleId: "r0-6sm0", title: "tcpp8-0", risk: "none", status: "ready" },
  { zoneId: "research", roleId: "r5-7c5b", title: "t4eye-5", risk: "approval", status: "active" },
  { zoneId: "security", roleId: "r0-kw5", title: "ti0rf-0", risk: "error", status: "active" },
  { zoneId: "security", roleId: "r5-aups", title: "t8fw3-5", risk: "blocked", status: "idle" },
  { zoneId: "operations", roleId: "r0-c3q5", title: "t5tgm-0", risk: "none", status: "ready" },
  { zoneId: "operations", roleId: "r3-f7ui", title: "tc3ql-3", risk: "none", status: "active" },
].map((agent, index) => ({
  ...agent,
  name: `Silhouette Agent ${index + 1}`,
  currentThought:
    "Investigating a deliberately long operator-visible activity trail that should be truncated in the hover card.",
  currentAction: `Action ${index + 1}`,
  activityState:
    index % 5 === 0
      ? "alert_response"
      : index % 5 === 1
        ? "working_seated"
        : index % 5 === 2
          ? "transitioning_to_desk"
          : index % 5 === 3
            ? "collaborating"
            : "idle_milling",
  collabPeers: index > 0 ? ["r0-f9tv"] : [],
  attentionLevel: index % 3 === 0 ? "priority" : index % 3 === 1 ? "watch" : "stable",
  behaviorDirective: index % 2 === 0 ? "Hold for operator confirmation before tool escalation." : undefined,
})) satisfies OfficeDeskAgent[];

describe("OfficeCanvas coverage", () => {
  afterEach(() => {
    fiberMocks.frameCallbacks = [];
  });

  it("renders command bridge scene with procedural geometry", async () => {
    const onSelect = vi.fn();
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={operator}
          agents={agents}
          selectedEntityId="agent-1"
          onSelect={onSelect}
          assetPack={{ operatorModelPath: "/assets/operator.glb", goatModelPath: "/assets/goat.glb" }}
          motionMode="cinematic"
          focusMode={false}
          quietMode={false}
          followSelection={false}
          sceneBusy={false}
          showCollabOverlay
          idleMillingEnabled
          collaborationEdges={edges}
          zoneTelemetry={zoneTelemetry}
          activityLanes={activityLanes}
          signalRoutes={signalRoutes}
        />,
        threeTestOptions,
      );
    });
    runFrameCallbacks();
    await act(async () => {
      renderer.root
        .findAllByType("div")
        .find((node) => typeof node.props.onClick === "function")
        ?.props.onClick();
    });
    expect(onSelect).toHaveBeenCalledWith("operator");
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("renders all zone architecture and agent silhouette branches with scene interactions", async () => {
    const onSelect = vi.fn();
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "strategist", activityState: "command_center" }}
          agents={silhouetteAgents}
          selectedEntityId="r0-kw5"
          onSelect={onSelect}
          motionMode="subtle"
          focusMode={false}
          quietMode={false}
          followSelection
          sceneBusy
          showCollabOverlay
          idleMillingEnabled
          collaborationEdges={[
            { fromRoleId: "r0-f9tv", toRoleId: "r3-ko8c", strength: 0.9, risk: false },
            { fromRoleId: "r0-jlo1", toRoleId: "r4-d7u5", strength: 1.8, risk: true },
            { fromRoleId: "missing", toRoleId: "r0-f9tv", strength: 0.4, risk: false },
          ]}
          zoneTelemetry={fullZoneTelemetry}
          activityLanes={[
            {
              fromZoneId: "command",
              toZoneId: "build",
              fromLabel: "Command",
              toLabel: "Build",
              strength: 0.8,
              count: 2,
              risk: true,
              label: "Command is feeding implementation.",
            },
            {
              fromZoneId: "security",
              toZoneId: "operations",
              fromLabel: "Security",
              toLabel: "Operations",
              strength: 0.4,
              count: 1,
              risk: false,
              label: "Security handed off runtime follow-up.",
            },
          ]}
          signalRoutes={[
            { roleId: "r0-f9tv", zoneId: "command", kind: "approval", label: "Needs approval", intensity: 1 },
            { roleId: "r0-kw5", zoneId: "security", kind: "blocked", label: "Blocked route", intensity: 0.72 },
            { roleId: "r5-aups", zoneId: "security", kind: "error", label: "Error route", intensity: 0.88 },
            { roleId: "missing-agent", zoneId: "operations", kind: "error", label: "Missing route", intensity: 0.3 },
          ]}
        />,
        threeTestOptions,
      );
    });
    runFrameCallbacks(2.4);

    const interactiveGroups = renderer.root.findAll(
      (node) => node.type === "group" && typeof node.props.onClick === "function",
    );
    const stopPropagation = vi.fn();
    await act(async () => {
      interactiveGroups[0]?.props.onPointerOver?.({ stopPropagation });
      interactiveGroups[0]?.props.onClick?.({ stopPropagation });
      interactiveGroups[0]?.props.onPointerOut?.();
      interactiveGroups[1]?.props.onPointerOver?.({ stopPropagation });
      interactiveGroups[1]?.props.onClick?.({ stopPropagation });
      interactiveGroups[1]?.props.onPointerOut?.();
    });

    expect(onSelect).toHaveBeenCalledWith("operator");
    expect(onSelect).toHaveBeenCalledWith("r0-f9tv");
    expect(stopPropagation).toHaveBeenCalled();
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("renders reduced-motion scene without collaboration overlay", async () => {
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "nightwatch", activityState: "command_center" }}
          agents={agents.map((agent) => ({ ...agent, activityState: "working_seated" }))}
          selectedEntityId="operator"
          onSelect={() => undefined}
          motionMode="reduced"
          focusMode
          focusedZoneId="research"
          quietMode
          followSelection
          sceneBusy
          showCollabOverlay={false}
          idleMillingEnabled={false}
          collaborationEdges={[]}
          zoneTelemetry={zoneTelemetry}
          activityLanes={activityLanes}
          signalRoutes={signalRoutes}
        />,
        threeTestOptions,
      );
    });
    runFrameCallbacks(3.6);
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("handles empty scene overlays and missing focus anchors without geometry failures", async () => {
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "sentinel", activityState: "idle_milling" }}
          agents={[]}
          selectedEntityId="missing-agent"
          onSelect={() => undefined}
          motionMode="balanced"
          focusMode
          focusedZoneId={"unknown" as never}
          quietMode={false}
          followSelection={false}
          sceneBusy={false}
          showCollabOverlay
          idleMillingEnabled={false}
          collaborationEdges={[]}
          zoneTelemetry={[]}
          activityLanes={[]}
          signalRoutes={[]}
        />,
        threeTestOptions,
      );
    });
    runFrameCallbacks(4.8);
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("filters focused collaboration edges while preserving selected and same-zone links", async () => {
    const onSelect = vi.fn();
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "trailblazer", activityState: "working_seated" }}
          agents={silhouetteAgents.slice(0, 5)}
          selectedEntityId="r0-f9tv"
          onSelect={onSelect}
          motionMode="balanced"
          focusMode
          focusedZoneId="command"
          quietMode
          followSelection
          sceneBusy={false}
          showCollabOverlay
          idleMillingEnabled
          collaborationEdges={[
            { fromRoleId: "r0-f9tv", toRoleId: "r3-ko8c", strength: 0.6, risk: false },
            { fromRoleId: "r3-ko8c", toRoleId: "r0-f9tv", strength: 0.6, risk: true },
            { fromRoleId: "r0-jlo1", toRoleId: "r0-6sm0", strength: 0.6, risk: false },
          ]}
          zoneTelemetry={fullZoneTelemetry}
          activityLanes={[
            {
              fromZoneId: "command",
              toZoneId: "missing" as never,
              fromLabel: "Command",
              toLabel: "Missing",
              strength: 0.2,
              count: 1,
              risk: false,
              label: "Missing lane endpoint.",
            },
          ]}
          signalRoutes={[
            { roleId: "missing-agent", zoneId: "command", kind: "blocked", label: "Missing", intensity: 0.2 },
          ]}
        />,
        threeTestOptions,
      );
    });
    runFrameCallbacks(6);
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("keeps animation frames safe when three refs are not attached", async () => {
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "trailblazer", activityState: "transitioning_to_desk" }}
          agents={[
            { ...silhouetteAgents[0]!, activityState: "transitioning_to_desk", attentionLevel: "watch" },
            { ...silhouetteAgents[1]!, activityState: "working_seated", attentionLevel: "stable" },
            { ...silhouetteAgents[2]!, activityState: "collaborating", attentionLevel: "priority" },
          ]}
          selectedEntityId="r3-ko8c"
          onSelect={() => undefined}
          motionMode="balanced"
          focusMode={false}
          quietMode={false}
          followSelection={false}
          sceneBusy={false}
          showCollabOverlay
          idleMillingEnabled
          collaborationEdges={[]}
          zoneTelemetry={fullZoneTelemetry}
          activityLanes={[]}
          signalRoutes={[]}
        />,
      );
    });

    expect(() => runFrameCallbacks(8.4)).not.toThrow();
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });
});
