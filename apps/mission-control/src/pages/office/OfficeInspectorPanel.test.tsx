import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { OfficeOperatorModel } from "../../components/OfficeCanvas";
import { OfficeInspectorPanel } from "./OfficeInspectorPanel";
import type { AgentHandoff, OfficeAgentModel, OfficeZoneTelemetry } from "./office-agent-model";
import type { OperatorPreferences } from "./office-page-constants";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/SelectOrCustom", () => ({
  SelectOrCustom: (props: { id?: string; value: string; onChange: (value: string) => void }) => (
    <input id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const operatorModel: OfficeOperatorModel = {
  operatorId: "operator",
  name: "GoatHerder",
  preset: "trailblazer",
  currentThought: "Sequencing the next work wave.",
  activityState: "idle_patrol",
};

const operatorPrefs: OperatorPreferences = {
  name: "GoatHerder",
  preset: "trailblazer",
  layoutMode: "immersive",
  motionMode: "balanced",
  showCollabOverlay: true,
  showInspectorDock: true,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: false,
  quietMode: false,
  followSelection: true,
};

const zoneTelemetry: OfficeZoneTelemetry[] = [
  {
    zoneId: "command",
    label: "Command",
    totalAgents: 3,
    activeAgents: 2,
    linkedAgents: 1,
    alertAgents: 1,
    focus: "Approvals and routing",
    attentionLevel: "priority",
    workloadScore: 0.8,
    laneCount: 2,
    landmark: "Command Hub",
    architectureNote: "Central desk",
  },
];

const selectedAgent: OfficeAgentModel = {
  agentId: "agent-1",
  roleId: "coder",
  name: "Coder Goat",
  title: "Implementation Engineer",
  summary: "Writes patches",
  specialties: ["TypeScript", "Coverage"],
  defaultTools: ["shell.exec"],
  aliases: ["coder"],
  status: "ready",
  sessionCount: 3,
  activeSessions: 1,
  runtimeAgentId: "runtime-coder",
  isBuiltin: false,
  editable: true,
  lifecycleStatus: "active",
  currentAction: "Adding behavioral tests",
  currentThought: "Coverage should reflect runtime behavior.",
  taskId: "task-1",
  currentTaskLabel: "Strict coverage",
  lastSeenAt: "2026-05-14T12:00:00.000Z",
  risk: "approval",
  eventTrail: [
    {
      eventId: "event-1",
      eventType: "tool_invoked",
      sequence: 1,
      timestamp: "2026-05-14T12:01:00.000Z",
      source: "mission-control",
      payload: { toolName: "vitest", outcome: "passed" },
    },
  ],
  activityState: "working_seated",
  collabPeers: ["qa"],
  zoneId: "build",
  zoneLabel: "Build",
  attentionLevel: "watch",
  behaviorDirective: "Keep tests behavioral.",
  workloadScore: 0.6,
};

const handoffs: AgentHandoff[] = [
  {
    label: "QA",
    detail: "Review coverage results",
    timestamp: "2026-05-14T12:02:00.000Z",
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

function hostControl(renderer: ReactTestRenderer, type: "input" | "select", id: string) {
  const node = renderer.root.findAll((candidate) => candidate.type === type && candidate.props.id === id).at(0);
  if (!node) {
    throw new Error(`Expected ${type}#${id}`);
  }
  return node;
}

function renderInspector(
  overrides: Partial<React.ComponentProps<typeof OfficeInspectorPanel>> = {},
  setOperatorPrefs = vi.fn(),
) {
  return create(
    <OfficeInspectorPanel
      selectedEntityId="operator"
      operatorPrefs={operatorPrefs}
      setOperatorPrefs={setOperatorPrefs}
      operatorModel={operatorModel}
      activeAgents={2}
      pendingApprovalsCount={1}
      blockedAgents={1}
      eventFlow={3.4}
      zoneTelemetry={zoneTelemetry}
      selectedAgent={undefined}
      selectedAgentHandoffs={[]}
      officeAgentNamesByRole={new Map([["qa", "QA Goat"]])}
      {...overrides}
    />,
  );
}

describe("OfficeInspectorPanel", () => {
  it("renders operator telemetry and updates operator customization controls", async () => {
    const setOperatorPrefs = vi.fn();
    const renderer = renderInspector({}, setOperatorPrefs);

    expect(rendererText(renderer)).toContain("GoatHerder");
    expect(rendererText(renderer)).toContain("Sequencing the next work wave.");
    expect(rendererText(renderer)).toContain("Approvals and routing");
    expect(rendererText(renderer)).toContain("Event pace 3.4 /min");

    await act(async () => {
      hostControl(renderer, "input", "goatHerderName").props.onChange({ target: { value: "Mission Lead" } });
      hostControl(renderer, "select", "goatHerderPreset").props.onChange({ target: { value: "nightwatch" } });
    });

    expect(setOperatorPrefs).toHaveBeenCalledTimes(2);
    const firstUpdate = setOperatorPrefs.mock.calls[0]?.[0];
    const secondUpdate = setOperatorPrefs.mock.calls[1]?.[0];
    expect(firstUpdate).toBeDefined();
    expect(secondUpdate).toBeDefined();
    expect(firstUpdate?.(operatorPrefs)).toMatchObject({ name: "Mission Lead" });
    expect(secondUpdate?.(operatorPrefs)).toMatchObject({ preset: "nightwatch" });

    renderer.unmount();
  });

  it("renders selected agent dossier, collaborator names, handoffs, and event summaries", () => {
    const renderer = renderInspector({
      selectedEntityId: "agent-1",
      selectedAgent,
      selectedAgentHandoffs: handoffs,
    });

    const text = rendererText(renderer);
    expect(text).toContain("Coder Goat");
    expect(text).toContain("Implementation Engineer - Build");
    expect(text).toContain("Current task Strict coverage");
    expect(text).toContain("QA Goat");
    expect(text).toContain("TypeScript");
    expect(text).toContain("Review coverage results");
    expect(text).toContain("vitest -> passed");

    renderer.unmount();
  });

  it("renders empty selected-agent state and empty handoff/event lists", () => {
    const emptyRenderer = renderInspector({ selectedEntityId: "missing", selectedAgent: undefined });
    expect(rendererText(emptyRenderer)).toContain("No goat selected.");
    emptyRenderer.unmount();

    const renderer = renderInspector({
      selectedEntityId: "agent-1",
      selectedAgent: {
        ...selectedAgent,
        status: "active",
        risk: "none",
        sessionId: undefined,
        runtimeAgentId: undefined,
        collabPeers: [],
        specialties: [],
        eventTrail: [],
      } as OfficeAgentModel,
      selectedAgentHandoffs: [],
      officeAgentNamesByRole: new Map(),
    });

    const text = rendererText(renderer);
    expect(text).toContain("Recent handoffs 0 No handoffs recorded yet.");
    expect(text).toContain("Collaborators -");
    expect(text).toContain("No handoffs recorded.");
    expect(text).toContain("No events yet.");

    renderer.unmount();
  });
});
