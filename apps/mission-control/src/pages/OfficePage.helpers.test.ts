import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "../api/client";
import type { AgentDirectoryRecord } from "../data/agent-roster";
import type { OfficeAgentModel } from "./office/office-agent-model";
import {
  buildAgentHandoffs,
  deriveAttentionLevel,
  deriveBehaviorDirective,
  deriveCollaborationEdges,
  deriveCurrentTaskLabel,
  deriveOfficeAgents,
  deriveSignalRoutes,
  deriveWorkloadScore,
  deriveZoneActivityLanes,
  deriveZoneTelemetry,
  describeAgentEvent,
  loadOfficeAssetPack,
  resolveEventRoleId,
  scheduleSceneActivation,
  zoneArchitectureNote,
  zoneLandmark,
} from "./OfficePage";

function directoryAgent(overrides: Partial<AgentDirectoryRecord>): AgentDirectoryRecord {
  return {
    agentId: overrides.agentId ?? overrides.roleId ?? "agent-1",
    roleId: overrides.roleId ?? "architect",
    name: overrides.name ?? "Architect",
    title: overrides.title ?? "Systems Architect",
    summary: overrides.summary ?? "Plans systems.",
    specialties: overrides.specialties ?? ["Architecture"],
    defaultTools: overrides.defaultTools ?? [],
    aliases: overrides.aliases ?? [],
    status: overrides.status ?? "active",
    sessionCount: overrides.sessionCount ?? 1,
    activeSessions: overrides.activeSessions ?? 1,
    lastUpdatedAt: overrides.lastUpdatedAt ?? "2026-05-14T11:55:00.000Z",
    runtimeAgentId: overrides.runtimeAgentId,
    runtimeName: overrides.runtimeName,
    isBuiltin: overrides.isBuiltin ?? true,
    editable: overrides.editable ?? false,
    lifecycleStatus: overrides.lifecycleStatus ?? "active",
  };
}

function event(overrides: Partial<RealtimeEvent>): RealtimeEvent {
  return {
    id: overrides.eventId ?? "evt-1",
    eventId: overrides.eventId ?? "evt-1",
    eventType: overrides.eventType ?? "activity_logged",
    source: overrides.source ?? "chat",
    timestamp: overrides.timestamp ?? "2026-05-14T12:00:00.000Z",
    payload: overrides.payload ?? {},
    ...overrides,
  } as RealtimeEvent;
}

function officeAgent(overrides: Partial<OfficeAgentModel>): OfficeAgentModel {
  return {
    ...directoryAgent({
      roleId: overrides.roleId ?? "architect",
      name: overrides.name ?? "Architect",
      status: overrides.status ?? "active",
    }),
    currentAction: overrides.currentAction ?? "Executing.",
    currentThought: overrides.currentThought ?? "Thinking.",
    currentTaskLabel: overrides.currentTaskLabel ?? "task-1",
    lastSeenAt: overrides.lastSeenAt ?? "2026-05-14T12:00:00.000Z",
    risk: overrides.risk ?? "none",
    eventTrail: overrides.eventTrail ?? [],
    activityState: overrides.activityState ?? "working_seated",
    collabPeers: overrides.collabPeers ?? [],
    zoneId: overrides.zoneId ?? "command",
    zoneLabel: overrides.zoneLabel ?? "Command Deck",
    attentionLevel: overrides.attentionLevel ?? "watch",
    behaviorDirective: overrides.behaviorDirective ?? "Stay on task.",
    workloadScore: overrides.workloadScore ?? 0.5,
    taskId: overrides.taskId,
    sessionId: overrides.sessionId,
    lastEventType: overrides.lastEventType,
  };
}

describe("OfficePage internal derivations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("derives office agents from runtime directory records and realtime event lineage", () => {
    const directory = [
      directoryAgent({ roleId: "architect", name: "Architect", runtimeAgentId: "runtime-architect" }),
      directoryAgent({ roleId: "qa", name: "QA", title: "Verification Lead", status: "ready" }),
      directoryAgent({ roleId: "ops", name: "Ops", title: "Runtime Operator", status: "idle" }),
    ];
    const events = [
      event({
        eventId: "evt-approval",
        eventType: "tool_invoked",
        timestamp: "2026-05-14T11:59:30.000Z",
        payload: {
          agentId: "runtime-architect",
          toolName: "shell_command",
          outcome: "approval_required",
          policyReason: "needs operator review",
          taskId: "task-shared",
          sessionId: "session-shared",
        },
      }),
      event({
        eventId: "evt-qa",
        eventType: "task_updated",
        timestamp: "2026-05-14T11:59:40.000Z",
        payload: {
          task: { assignedAgentId: "qa", title: "Verify coverage", status: "running" },
          taskId: "task-shared",
        },
      }),
      event({
        eventId: "evt-ops",
        eventType: "subagent_updated",
        timestamp: "2026-05-14T11:59:50.000Z",
        payload: {
          session: { agentName: "Ops", status: "failed" },
          sessionId: "session-shared",
        },
      }),
    ];

    const agents = deriveOfficeAgents(directory, events);

    expect(agents.map((agent) => agent.roleId)).toEqual(["qa", "architect", "ops"]);
    expect(agents.find((agent) => agent.roleId === "architect")).toMatchObject({
      risk: "approval",
      activityState: "collaborating",
      currentTaskLabel: "task-shared",
    });
    expect(agents.find((agent) => agent.roleId === "ops")).toMatchObject({
      risk: "error",
      activityState: "alert_response",
    });
  });

  it("describes event types and resolves runtime role ids defensively", () => {
    const lookup = new Map([["runtime architect", "architect"]]);

    expect(resolveEventRoleId(event({ payload: { actorType: "agent", actorId: "runtime architect" } }), lookup)).toBe(
      "architect",
    );
    expect(resolveEventRoleId(event({ payload: { task: { assignedAgentId: "qa" } } }), lookup)).toBe("qa");
    expect(resolveEventRoleId(event({ payload: { agentId: "missing" } }), new Map())).toBeUndefined();

    expect(
      describeAgentEvent(
        event({
          eventType: "tool_invoked",
          payload: { toolName: "fs.write", outcome: "blocked", policyReason: "jail" },
        }),
      ),
    ).toMatchObject({ risk: "blocked", status: "idle" });
    expect(
      describeAgentEvent(event({ eventType: "tool_invoked", payload: { toolName: "browser.search" } })),
    ).toMatchObject({
      risk: "none",
      status: "active",
    });
    expect(describeAgentEvent(event({ eventType: "subagent_registered" }))).toMatchObject({ status: "active" });
    expect(
      describeAgentEvent(event({ eventType: "subagent_updated", payload: { session: { status: "completed" } } })),
    ).toMatchObject({ status: "idle", risk: "none" });
    expect(
      describeAgentEvent(event({ eventType: "subagent_updated", payload: { session: { status: "killed" } } })),
    ).toMatchObject({ status: "idle", risk: "error" });
    expect(
      describeAgentEvent(event({ eventType: "orchestration_event", payload: { event: "phase_started" } })),
    ).toMatchObject({
      risk: "none",
      status: "active",
    });
    expect(describeAgentEvent(event({ eventType: "custom_event" }))).toMatchObject({ action: "Handled custom_event." });
  });

  it("builds collaboration, handoff, zone, and signal summaries", () => {
    const agents = [
      officeAgent({
        roleId: "architect",
        name: "Architect",
        zoneId: "command",
        collabPeers: ["qa", "missing", "architect"],
        taskId: "task-1",
        risk: "approval",
        workloadScore: 0.8,
        eventTrail: [
          event({ eventType: "tool_invoked", payload: { toolName: "shell", outcome: "approval_required" } }),
          event({ eventType: "subagent_updated", payload: { session: { status: "completed" } } }),
          event({ eventType: "task_created", payload: { task: { title: "Ship Loop 11" } } }),
        ],
      }),
      officeAgent({
        roleId: "qa",
        name: "QA",
        zoneId: "build",
        collabPeers: ["architect"],
        taskId: "task-1",
        risk: "none",
        workloadScore: 0.5,
      }),
      officeAgent({
        roleId: "security",
        name: "Security",
        zoneId: "security",
        collabPeers: [],
        risk: "blocked",
        attentionLevel: "priority",
        workloadScore: 0.9,
      }),
    ];

    expect(deriveCollaborationEdges(agents)).toEqual([
      expect.objectContaining({ fromRoleId: "architect", toRoleId: "qa", risk: true }),
    ]);
    expect(buildAgentHandoffs(agents[0]!, new Map([["qa", "QA"]]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Cross-desk sync" }),
        expect.objectContaining({ label: "Task handoff" }),
      ]),
    );
    expect(buildAgentHandoffs(agents[2]!, new Map())).toEqual([expect.objectContaining({ label: "Risk handoff" })]);
    expect(deriveZoneActivityLanes(agents)).toEqual([
      expect.objectContaining({ fromZoneId: "build", toZoneId: "command", risk: true }),
    ]);
    expect(deriveSignalRoutes(agents).map((route) => route.kind)).toEqual(["blocked", "approval"]);

    const telemetry = deriveZoneTelemetry(agents, deriveZoneActivityLanes(agents));
    expect(telemetry.find((zone) => zone.zoneId === "security")).toMatchObject({
      attentionLevel: "priority",
      landmark: "Sentinel wall",
    });
    expect(telemetry.find((zone) => zone.zoneId === "research")?.focus).toContain("No goats assigned");
  });

  it("covers attention, workload, zone, scene activation, and asset-pack fallbacks", async () => {
    expect(deriveAttentionLevel({ activityState: "alert_response", risk: "none", status: "idle" })).toBe("priority");
    expect(deriveAttentionLevel({ activityState: "collaborating", risk: "none", status: "ready" })).toBe("watch");
    expect(deriveAttentionLevel({ activityState: "idle_milling", risk: "none", status: "ready" })).toBe("stable");
    expect(
      deriveBehaviorDirective({ activityState: "transitioning_to_desk", risk: "none", status: "active" }, 0),
    ).toContain("fresh signal");
    expect(deriveBehaviorDirective({ activityState: "idle_milling", risk: "none", status: "ready" }, 0)).toContain(
      "warm context",
    );
    expect(deriveBehaviorDirective({ activityState: "idle_milling", risk: "none", status: "idle" }, 0)).toContain(
      "Patrol",
    );
    expect(deriveCurrentTaskLabel({ status: "ready" })).toBe("Ready reserve");
    expect(deriveCurrentTaskLabel({ status: "active" })).toBe("Live execution");
    expect(deriveCurrentTaskLabel({ status: "idle" })).toBe("Standby slot");
    expect(
      deriveWorkloadScore(
        { status: "active", risk: "blocked", activityState: "alert_response", attentionLevel: "priority" },
        10,
        6,
      ),
    ).toBeLessThanOrEqual(1);
    expect(zoneLandmark("operations")).toBe("Relay gantry");
    expect(zoneArchitectureNote("research", 0.8)).toContain("running hot");
    expect(zoneArchitectureNote("build", 0.5)).toContain("holding live pressure");
    expect(zoneArchitectureNote("operations", 0.1)).toContain("idling cool");

    const callback = vi.fn();
    const cleanupWithoutWindow = scheduleSceneActivation(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    cleanupWithoutWindow();

    const idleCallback = vi.fn((cb: () => void) => {
      cb();
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("window", { requestIdleCallback: idleCallback, cancelIdleCallback });
    const idleCleanup = scheduleSceneActivation(callback);
    idleCleanup();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("asset-manifest.json")) {
          return new Response(
            JSON.stringify({
              models: [
                { id: "central-operator", path: "/operator.glb", includedInRepo: true },
                {
                  id: "goat-subagent-animated",
                  label: "Animated Goat",
                  path: "/goat-animated.glb",
                  includedInRepo: true,
                },
                { id: "office-desk-medium", path: "/desk.glb", includedInRepo: true },
                { id: "office-mug", path: "/missing-mug.glb", includedInRepo: true },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: init?.method === "HEAD" && url.includes("missing") ? 404 : 200 });
      }) as unknown as typeof fetch,
    );

    const pack = await loadOfficeAssetPack();
    expect(pack).toMatchObject({
      operatorModelPath: "/operator.glb",
      goatModelPath: "/goat-animated.glb",
      goatModelVariant: "animated",
      deskModelPath: "/desk.glb",
    });
    expect(pack.mugModelPath).toBeUndefined();
  });
});
