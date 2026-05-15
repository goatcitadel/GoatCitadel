import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "../../api/client";
import type { AgentDirectoryRecord } from "../../data/agent-roster";
import type { OfficeZoneId } from "../../data/office-zones";
import { DEFAULT_OPERATOR_PREFS, type OperatorPreferences } from "./office-page-constants";
import type { OfficeAgentModel, OfficeZoneTelemetry } from "./office-agent-model";
import { useOfficeStageState } from "./useOfficeStageState";

type StageState = ReturnType<typeof useOfficeStageState>;

let latest: StageState | null = null;
let windowListeners: Map<string, Array<(event?: unknown) => void>>;

const baseEvents: RealtimeEvent[] = [
  {
    eventId: "evt-new",
    sequence: 2,
    eventType: "approval_created",
    source: "approval",
    timestamp: "2026-03-10T18:00:00.000Z",
    payload: { taskId: "task-new" },
  } as RealtimeEvent,
  {
    eventId: "evt-old",
    sequence: 1,
    eventType: "activity_logged",
    source: "chat",
    timestamp: "2026-03-10T17:56:00.000Z",
    payload: { taskId: "task-old" },
  } as RealtimeEvent,
];

function officeAgent(overrides: Partial<OfficeAgentModel>): OfficeAgentModel {
  return {
    agentId: overrides.roleId ?? "agent",
    roleId: "agent",
    name: "Agent",
    title: "Agent",
    summary: "Agent summary",
    specialties: [],
    defaultTools: [],
    aliases: [],
    isBuiltin: true,
    editable: false,
    lifecycleStatus: "active",
    sessionCount: 0,
    activeSessions: 0,
    status: "idle",
    currentAction: "Waiting",
    currentThought: "Ready",
    currentTaskLabel: "Ready",
    risk: "none",
    eventTrail: [],
    activityState: "working_seated",
    collabPeers: [],
    zoneId: "command",
    zoneLabel: "Command Deck",
    attentionLevel: "stable",
    behaviorDirective: "Stay ready.",
    workloadScore: 0.2,
    ...overrides,
  } as OfficeAgentModel;
}

const agents = [
  officeAgent({
    agentId: "builder",
    roleId: "builder",
    name: "Build Goat",
    status: "active",
    zoneId: "build",
    zoneLabel: "Build Bay",
    attentionLevel: "priority",
    risk: "approval",
    currentTaskLabel: "Ship patch",
    lastSeenAt: "2026-03-10T17:59:30.000Z",
  }),
  officeAgent({
    agentId: "researcher",
    roleId: "researcher",
    name: "Research Goat",
    zoneId: "research",
    zoneLabel: "Research Lab",
    attentionLevel: "watch",
    lastSeenAt: "2026-03-10T17:50:00.000Z",
  }),
];

function zoneTelemetry(zoneId: OfficeZoneId): OfficeZoneTelemetry {
  return {
    zoneId,
    label:
      zoneId === "command"
        ? "Command Deck"
        : zoneId === "build"
          ? "Build Bay"
          : zoneId === "research"
            ? "Research Lab"
            : zoneId,
    totalAgents: zoneId === "build" || zoneId === "research" ? 1 : 0,
    activeAgents: zoneId === "build" ? 1 : 0,
    linkedAgents: 0,
    alertAgents: zoneId === "build" ? 1 : 0,
    focus: `${zoneId} focus detail`,
    attentionLevel: zoneId === "build" ? "priority" : zoneId === "research" ? "watch" : "stable",
    workloadScore: zoneId === "build" ? 0.8 : 0.2,
    laneCount: 0,
    landmark: `${zoneId} landmark`,
    architectureNote: `${zoneId} note`,
  };
}

function Harness({
  events = baseEvents,
  prefs,
  initialDockTab = "operators",
  prefersReducedMotion = false,
}: {
  events?: RealtimeEvent[];
  prefs?: Partial<OperatorPreferences>;
  initialDockTab?: "inspector" | "operators" | "approvals" | "rail";
  prefersReducedMotion?: boolean;
}) {
  latest = useOfficeStageState({
    directory: [] as AgentDirectoryRecord[],
    events,
    operatorPrefs: {
      ...DEFAULT_OPERATOR_PREFS,
      ...prefs,
    },
    initialDockTab,
    pendingApprovalsCount: 1,
    assetPack: { goatModelPath: "/assets/goat.glb", goatModelVariant: "animated" },
    prefersReducedMotion,
    deriveOfficeAgents: (_directory, sceneEvents) =>
      agents.map((agent) => ({
        ...agent,
        eventTrail: sceneEvents,
      })),
    deriveCollaborationEdges: () => [],
    deriveZoneActivityLanes: () => [],
    deriveZoneTelemetry: () => [zoneTelemetry("command"), zoneTelemetry("build"), zoneTelemetry("research")],
    deriveSignalRoutes: () => [],
    buildAgentHandoffs: (agent) => agent.collabPeers.map((peer) => ({ label: peer, detail: agent.currentTaskLabel })),
    describeGoatAssetStatus: () => ({
      tone: "live",
      chipLabel: "Animated goats",
      helpLabel: "Assets ready",
      helpCopy: "Animated goat asset pack is available.",
    }),
    scheduleSceneActivation: (setSceneReady) => {
      const id = window.setTimeout(setSceneReady, 25);
      return () => window.clearTimeout(id);
    },
  });
  return null;
}

function installWindowStub(): void {
  windowListeners = new Map();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      addEventListener: (eventName: string, handler: (event?: unknown) => void) => {
        windowListeners.set(eventName, [...(windowListeners.get(eventName) ?? []), handler]);
      },
      removeEventListener: (eventName: string, handler: (event?: unknown) => void) => {
        windowListeners.set(
          eventName,
          (windowListeners.get(eventName) ?? []).filter((candidate) => candidate !== handler),
        );
      },
      dispatchEvent: (event: { type: string }) => {
        for (const handler of windowListeners.get(event.type) ?? []) {
          handler(event);
        }
        return true;
      },
    },
  });
}

function dispatchKey(key: string): void {
  window.dispatchEvent({
    type: "keydown",
    key,
    target: null,
    preventDefault: vi.fn(),
  } as unknown as Event);
}

describe("useOfficeStageState", () => {
  beforeEach(() => {
    latest = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
    installWindowStub();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("keeps focus-mode zone navigation, selection, and inspector state synchronized", async () => {
    await act(async () => {
      create(<Harness prefs={{ focusMode: true }} />);
    });

    expect(latest?.selectedEntityId).toBe("operator");
    expect(latest?.selectedZoneId).toBe("command");
    expect(latest?.stageZoneTelemetry.map((zone) => zone.zoneId)).toEqual(["command"]);

    act(() => {
      dispatchKey("2");
    });

    expect(latest?.selectedEntityId).toBe("builder");
    expect(latest?.selectedZoneId).toBe("build");
    expect(latest?.stageZoneTelemetry.map((zone) => zone.zoneId)).toEqual(["build"]);
    expect(latest?.focusSummary?.title).toBe("Build Goat focus lens");

    act(() => {
      latest?.handleEntitySelect("researcher");
    });

    expect(latest?.selectedEntityId).toBe("researcher");
    expect(latest?.selectedZoneId).toBe("research");
    expect(latest?.dockTab).toBe("inspector");
  });

  it("filters replay scene events by cursor time and stops playback at the replay end", async () => {
    await act(async () => {
      create(<Harness prefs={{ focusMode: false }} initialDockTab="rail" />);
    });

    expect(latest?.sceneEvents.map((event) => event.eventId)).toEqual(["evt-new", "evt-old"]);
    expect(latest?.eventFlow).toBe(0.4);

    act(() => {
      latest?.handlePlaybackModeChange("replay");
    });

    expect(latest?.playback.mode).toBe("replay");
    expect(latest?.sceneEvents.map((event) => event.eventId)).toEqual(["evt-old"]);
    expect(latest?.eventFlow).toBe(0.2);

    act(() => {
      latest?.setPlayback((current) => ({ ...current, playing: true, speed: 4 }));
    });
    act(() => {
      vi.advanceTimersByTime(2_520);
    });

    expect(latest?.playback.playing).toBe(false);
    expect(latest?.playback.cursorTime).toBe(latest?.replayWindow.endTime);
    expect(latest?.sceneEvents.map((event) => event.eventId)).toEqual(["evt-new", "evt-old"]);
  });

  it("applies dock fallbacks, reduced motion, quiet mode, and delayed scene readiness", async () => {
    let renderer = create(<div />);
    await act(async () => {
      renderer = create(
        <Harness
          initialDockTab="inspector"
          prefs={{ showInspectorDock: false, showRailDock: true, quietMode: true, motionMode: "cinematic" }}
        />,
      );
    });

    expect(latest?.dockTab).toBe("operators");
    expect(latest?.effectiveMotionMode).toBe("subtle");
    expect(latest?.sceneReady).toBe(false);

    act(() => {
      vi.advanceTimersByTime(25);
    });

    expect(latest?.sceneReady).toBe(true);

    await act(async () => {
      renderer.update(<Harness prefersReducedMotion prefs={{ motionMode: "cinematic" }} />);
    });

    expect(latest?.effectiveMotionMode).toBe("reduced");
    renderer.unmount();
  });
});
