import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  OfficeCanvas,
  type OfficeCollaborationEdge,
  type OfficeDeskAgent,
  type OfficeOperatorModel,
  type OfficeSignalRoute,
  type OfficeZoneId,
  type OfficeZoneActivityLane,
  type OfficeZoneSceneTelemetry,
} from "./OfficeCanvas";

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
    callback({ clock: { elapsedTime: 1.2 } });
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

function silhouetteAgent(roleId: string, title: string, zoneId: OfficeZoneId, index: number): OfficeDeskAgent {
  return {
    roleId,
    name: `${zoneId} ${index}`,
    title,
    status: index % 2 === 0 ? "active" : "ready",
    risk: index % 5 === 0 ? "approval" : index % 7 === 0 ? "blocked" : "none",
    currentThought: `${zoneId} silhouette ${index} is tracking the floor.`,
    currentAction: `Render ${zoneId} silhouette ${index}.`,
    activityState: index % 3 === 0 ? "alert_response" : index % 3 === 1 ? "collaborating" : "working_seated",
    collabPeers: [],
    zoneId,
    zoneLabel: `${zoneId} zone`,
    attentionLevel: index % 3 === 0 ? "priority" : index % 3 === 1 ? "watch" : "stable",
    behaviorDirective: "Keep the procedural avatar branch visible for coverage.",
  };
}

const allSilhouetteAgents: OfficeDeskAgent[] = [
  silhouetteAgent("command-0", "command role 0", "command", 0),
  silhouetteAgent("command-1x", "command role 1zq", "command", 1),
  silhouetteAgent("build-1x", "build role 1zq", "build", 2),
  silhouetteAgent("build-0", "build role 0", "build", 3),
  silhouetteAgent("research-0", "research role 0", "research", 4),
  silhouetteAgent("research-1x", "research role 1zq", "research", 5),
  silhouetteAgent("security-1x", "security role 1zq", "security", 6),
  silhouetteAgent("security-0", "security role 0", "security", 7),
  silhouetteAgent("operations-1x", "operations role 1zq", "operations", 8),
  silhouetteAgent("operations-0", "operations role 0", "operations", 9),
];

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

describe("OfficeCanvas coverage", () => {
  it("renders command bridge scene with procedural geometry", async () => {
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={operator}
          agents={agents}
          selectedEntityId="agent-1"
          onSelect={() => undefined}
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
      );
    });
    await act(async () => {
      renderer.root.findByType("div").props.onClick?.();
    });
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
      );
    });
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("covers every procedural agent silhouette and pointer affordance", async () => {
    const onSelect = vi.fn();
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "strategist", activityState: "command_center" }}
          agents={allSilhouetteAgents}
          selectedEntityId="security-0"
          onSelect={onSelect}
          motionMode="balanced"
          focusMode={false}
          quietMode={false}
          followSelection
          sceneBusy
          showCollabOverlay
          idleMillingEnabled
          collaborationEdges={[
            { fromRoleId: "command-0", toRoleId: "build-0", strength: 2.5, risk: true },
            { fromRoleId: "research-0", toRoleId: "operations-0", strength: 1.6, risk: false },
            { fromRoleId: "missing", toRoleId: "operations-0", strength: 1, risk: false },
          ]}
          zoneTelemetry={zoneTelemetry.map((zone) => ({
            ...zone,
            workloadScore: zone.zoneId === "command" ? 0.88 : 0.22,
            attentionLevel: zone.zoneId === "command" ? "priority" : zone.attentionLevel,
          }))}
          activityLanes={[
            ...activityLanes,
            {
              fromZoneId: "missing" as OfficeZoneId,
              toZoneId: "command",
              fromLabel: "Missing",
              toLabel: "Command",
              strength: 0.4,
              count: 1,
              risk: false,
              label: "Missing lane should be ignored.",
            },
          ]}
          signalRoutes={[
            ...signalRoutes,
            {
              roleId: "security-0",
              zoneId: "security",
              kind: "error",
              label: "Security needs review",
              intensity: 0.9,
            },
          ]}
        />,
      );
    });

    const interactiveGroups = renderer.root.findAll(
      (node) =>
        node.type === "group" &&
        (typeof node.props.onClick === "function" || typeof node.props.onPointerOver === "function"),
    );
    expect(interactiveGroups.length).toBeGreaterThan(2);

    await act(async () => {
      for (const group of interactiveGroups.slice(0, 4)) {
        group.props.onPointerOver?.({ stopPropagation: vi.fn() });
        group.props.onPointerOut?.();
        group.props.onClick?.({ stopPropagation: vi.fn() });
      }
    });

    expect(onSelect).toHaveBeenCalled();
    expect(renderer.toJSON()).toBeTruthy();
    renderer.unmount();
  });

  it("falls back to the default camera target when focus references an unknown zone", async () => {
    const onSelect = vi.fn();
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <OfficeCanvas
          operator={{ ...operator, preset: "trailblazer", activityState: "idle_patrol" }}
          agents={agents.slice(0, 2)}
          selectedEntityId="missing-agent"
          onSelect={onSelect}
          motionMode="balanced"
          focusMode
          focusedZoneId={"missing-zone" as OfficeZoneId}
          quietMode={false}
          followSelection
          sceneBusy
          showCollabOverlay={false}
          idleMillingEnabled={false}
          collaborationEdges={[]}
          zoneTelemetry={[]}
          activityLanes={[]}
          signalRoutes={[]}
        />,
      );
    });

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
});
