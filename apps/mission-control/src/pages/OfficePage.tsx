/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  connectEventStream,
  fetchAgents,
  fetchApprovals,
  fetchOperators,
  fetchRealtimeEvents,
  type ApprovalsResponse,
  type OperatorsResponse,
  type RealtimeEvent,
} from "../api/client";
import { buildAgentDirectory, inferRoleId, type AgentDirectoryRecord } from "../data/agent-roster";
import type {
  OfficeAttentionLevel,
  OfficeCollaborationEdge,
  OfficeDeskAgent,
  OfficeMotionMode,
  OfficeOperatorModel,
  OperatorPreset,
} from "../components/OfficeCanvas";
import { OfficeCanvasErrorBoundary } from "../components/OfficeCanvasErrorBoundary";
import { OfficeInspectorPanel } from "./office/OfficeInspectorPanel";
import { OfficeOperationsDock } from "./office/OfficeOperationsDock";
import { OfficeOverviewPanel } from "./office/OfficeOverviewPanel";
import { OfficeStagePanel } from "./office/OfficeStagePanel";
import { useOfficeStageState } from "./office/useOfficeStageState";
import { CardSkeleton } from "../components/CardSkeleton";
import { PageHeader } from "../components/PageHeader";
import { pageCopy } from "../content/copy";
import "../styles/office.css";
import { OFFICE_ZONE_ORDER, inferOfficeZone, officeZoneLabel, type OfficeZoneId } from "../data/office-zones";

import {
  ACTIVITY_TRANSITION_WINDOW_MS,
  DEFAULT_OPERATOR_PREFS,
  EVENTS_PER_MINUTE_WINDOW_MS,
  HOT_AGENT_WINDOW_MS,
  INITIAL_EVENT_LIMIT,
  LAB_OPERATOR_PREFS,
  MAX_EVENTS,
  MAX_VISIBLE_COLLAB_EDGES,
  MAX_VISIBLE_ZONE_LANES,
  OFFICE_PAGE_VARIANTS,
  PRESET_OPTIONS,
  SNAPSHOT_INTERVAL_MS,
  WARM_AGENT_WINDOW_MS,
  type OfficeDockTab,
  type OfficePageVariant,
  type OperatorPreferences,
} from "./office/office-page-constants";
import {
  asRecord,
  asString,
  buildOperatorThought,
  classifyAgentHeat,
  extractSessionId,
  extractTaskId,
  formatClock,
  formatRelative,
  normalize,
  parseTimestamp,
  persistOperatorPreferences,
  readOperatorPreferences,
  sortEvents,
  statusScore,
  summarizeEvent,
  truncate,
} from "./office/office-page-helpers";

export type { OfficePageVariant };

import type {
  AgentRisk,
  OfficeAgentModel,
  OfficeZoneTelemetry,
  OfficeZoneActivityLane,
  OfficeSignalRoute,
  AgentHandoff,
  OfficeAssetPack,
} from "./office/office-agent-model";

export type { OfficeAssetPack };

interface PlaybackState {
  mode: "live" | "replay";
  playing: boolean;
  speed: 1 | 2 | 4;
  cursorTime?: number;
}

type SelectedEntityId = "operator" | string;

const OfficeCanvasScene = lazy(async () => {
  const module = await import("../components/OfficeCanvas");
  return { default: module.OfficeCanvas };
});

interface OfficePageProps {
  variant?: OfficePageVariant;
  onOpenLab?: () => void;
}

export function OfficePage({ variant = "stable", onOpenLab }: OfficePageProps) {
  const variantConfig = OFFICE_PAGE_VARIANTS[variant];
  const [directory, setDirectory] = useState<AgentDirectoryRecord[]>([]);
  const [operators, setOperators] = useState<OperatorsResponse["items"]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalsResponse["items"]>([]);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [operatorPrefs, setOperatorPrefs] = useState<OperatorPreferences>(() =>
    readOperatorPreferences(variantConfig.storageKey, variantConfig.defaultPrefs),
  );
  const [assetPack, setAssetPack] = useState<OfficeAssetPack>({});
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamHealthy, setStreamHealthy] = useState(false);
  const streamHealthyRef = useRef(false);
  const snapshotResyncNeededRef = useRef(false);

  useEffect(() => {
    let active = true;

    const loadSnapshot = async (includeEvents: boolean): Promise<void> => {
      try {
        const [agentsRes, operatorsRes, approvalsRes, eventsRes] = await Promise.all([
          fetchAgents(),
          fetchOperators(),
          fetchApprovals("pending"),
          includeEvents ? fetchRealtimeEvents(INITIAL_EVENT_LIMIT) : Promise.resolve(null),
        ]);

        if (!active) {
          return;
        }

        setDirectory(buildAgentDirectory(agentsRes.items));
        setOperators(operatorsRes.items);
        setPendingApprovals(approvalsRes.items);
        if (eventsRes) {
          setEvents(sortEvents(eventsRes.items).slice(0, MAX_EVENTS));
        }
        setError(null);
      } catch (err) {
        if (!active) {
          return;
        }
        setError((err as Error).message);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadSnapshot(true);
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (streamHealthyRef.current && !snapshotResyncNeededRef.current) {
        return;
      }
      snapshotResyncNeededRef.current = false;
      void loadSnapshot(false);
    }, SNAPSHOT_INTERVAL_MS);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        snapshotResyncNeededRef.current = false;
        void loadSnapshot(false);
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const close = connectEventStream(
      (event) => {
        setEvents((prev) => sortEvents([event, ...prev]).slice(0, MAX_EVENTS));
      },
      (state) => {
        const healthy = state === "open";
        streamHealthyRef.current = healthy;
        setStreamHealthy(healthy);
        if (!healthy) {
          snapshotResyncNeededRef.current = true;
        }
      },
    );

    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      close();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    persistOperatorPreferences(variantConfig.storageKey, operatorPrefs, variantConfig.defaultPrefs);
  }, [operatorPrefs, variantConfig.defaultPrefs, variantConfig.storageKey]);

  useEffect(() => {
    let active = true;
    void loadOfficeAssetPack().then((pack) => {
      if (active) {
        setAssetPack(pack);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const officeCopy = pageCopy[variantConfig.pageId];
  const officeGuide = officeCopy.guide ?? {
    what: "Live WebGL operations room for agent activity.",
    when: "Use this for real-time observability.",
    actions: [
      "Select the Goatherder or a desk.",
      "Inspect current doing/thinking state.",
      "Review collaboration flow and risk overlays.",
    ],
    terms: [
      { term: "Goatherder", meaning: "Central human operator coordinating the herd." },
      { term: "Signal", meaning: "Realtime event from gateway, tools, tasks, or approvals." },
    ],
  };
  const {
    selectedEntityId,
    dockTab,
    setDockTab,
    playback,
    setPlayback,
    sceneReady,
    replayWindow,
    playbackCursorTime,
    sceneEvents,
    officeAgents,
    officeAgentNamesByRole,
    collaborationEdges,
    zoneActivityLanes,
    zoneTelemetry,
    signalRoutes,
    selectedAgent,
    selectedZoneId,
    stageZoneTelemetry,
    selectedAgentHandoffs,
    focusSummary,
    activeAgents,
    readyAgents,
    eventFlow,
    hotAgents,
    blockedAgents,
    priorityAgents,
    watchAgents,
    effectiveMotionMode,
    sceneBusy,
    goatAssetStatus,
    sceneResetKey,
    operatorModel,
    availableDockTabs,
    handleEntitySelect,
    handlePlaybackModeChange,
    motionModeOptions,
    playbackSpeedOptions,
  } = useOfficeStageState({
    directory,
    events,
    operatorPrefs,
    initialDockTab: variantConfig.initialDockTab,
    pendingApprovalsCount: pendingApprovals.length,
    assetPack,
    prefersReducedMotion,
    deriveOfficeAgents,
    deriveCollaborationEdges,
    deriveZoneActivityLanes,
    deriveZoneTelemetry,
    deriveSignalRoutes,
    buildAgentHandoffs,
    describeGoatAssetStatus,
    scheduleSceneActivation,
  });

  if (loading) {
    return (
      <section className="office-v5">
        <PageHeader
          eyebrow={variantConfig.eyebrow}
          title={officeCopy.title}
          subtitle={officeCopy.subtitle}
          className="page-header-citadel"
        />
        <CardSkeleton lines={10} />
      </section>
    );
  }

  return (
    <section className={`office-v5 ${operatorPrefs.focusMode ? "office-focus-mode" : ""}`}>
      <OfficeOverviewPanel
        eyebrow={variantConfig.eyebrow}
        title={officeCopy.title}
        subtitle={officeCopy.subtitle}
        hint={variantConfig.headerHint}
        onOpenLab={onOpenLab}
        streamHealthy={streamHealthy}
        pendingApprovalsCount={pendingApprovals.length}
        blockedAgents={blockedAgents}
        priorityAgents={priorityAgents}
        watchAgents={watchAgents}
        guide={officeGuide}
        error={error}
        activeAgents={activeAgents}
        hotAgents={hotAgents}
        readyAgents={readyAgents}
        eventFlow={eventFlow}
      />

      <div
        className={`office-v5-workspace${operatorPrefs.showInspectorDock || operatorPrefs.showRailDock ? "" : " office-v5-workspace-single"}`}
      >
        <OfficeStagePanel
          sceneReady={sceneReady}
          blockedAgents={blockedAgents}
          priorityAgents={priorityAgents}
          watchAgents={watchAgents}
          playbackMode={playback.mode}
          goatAssetStatus={goatAssetStatus}
          focusSummary={focusSummary}
          stageControlProps={{
            playback,
            setPlayback,
            replayWindow,
            playbackCursorTime: playbackCursorTime ?? null,
            onPlaybackModeChange: handlePlaybackModeChange,
            playbackSpeedOptions,
            operatorPrefs,
            setOperatorPrefs,
            effectiveMotionMode,
            prefersReducedMotion,
            motionModeOptions,
          }}
          zoneActivityLanes={zoneActivityLanes}
          stageZoneTelemetry={stageZoneTelemetry}
          selectedEntityId={selectedEntityId}
          selectedAgentZoneId={selectedAgent?.zoneId ?? null}
          officeAgents={officeAgents}
          operatorName={operatorPrefs.name}
          onSelectEntity={handleEntitySelect}
          renderScene={() => (
            <OfficeCanvasErrorBoundary resetKey={sceneResetKey}>
              {sceneReady ? (
                <Suspense
                  fallback={
                    <div className="office-webgl-stage office-webgl-stage-v5 office-stage-loading">
                      <p>Loading office scene...</p>
                    </div>
                  }
                >
                  <OfficeCanvasScene
                    operator={operatorModel}
                    agents={officeAgents}
                    selectedEntityId={selectedEntityId}
                    onSelect={(entityId) => handleEntitySelect(entityId as SelectedEntityId)}
                    assetPack={assetPack}
                    motionMode={effectiveMotionMode}
                    focusMode={operatorPrefs.focusMode}
                    focusedZoneId={selectedZoneId}
                    quietMode={operatorPrefs.quietMode}
                    followSelection={operatorPrefs.followSelection}
                    sceneBusy={sceneBusy}
                    showCollabOverlay={operatorPrefs.showCollabOverlay}
                    idleMillingEnabled={operatorPrefs.idleMillingEnabled}
                    collaborationEdges={collaborationEdges}
                    zoneTelemetry={zoneTelemetry}
                    activityLanes={zoneActivityLanes}
                    signalRoutes={signalRoutes}
                  />
                </Suspense>
              ) : (
                <div className="office-webgl-stage office-webgl-stage-v5 office-stage-loading">
                  <p>Loading office scene...</p>
                </div>
              )}
            </OfficeCanvasErrorBoundary>
          )}
        />

        <OfficeOperationsDock
          showInspectorDock={operatorPrefs.showInspectorDock}
          showRailDock={operatorPrefs.showRailDock}
          dockTab={dockTab}
          onDockTabChange={setDockTab}
          availableDockTabs={availableDockTabs}
          renderInspector={() => (
            <OfficeInspectorPanel
              selectedEntityId={selectedEntityId}
              operatorPrefs={operatorPrefs}
              setOperatorPrefs={setOperatorPrefs}
              operatorModel={operatorModel}
              activeAgents={activeAgents}
              pendingApprovalsCount={pendingApprovals.length}
              blockedAgents={blockedAgents}
              eventFlow={eventFlow}
              zoneTelemetry={zoneTelemetry}
              selectedAgent={selectedAgent}
              selectedAgentHandoffs={selectedAgentHandoffs}
              officeAgentNamesByRole={officeAgentNamesByRole}
            />
          )}
          operators={operators}
          pendingApprovals={pendingApprovals}
          sceneEvents={sceneEvents}
          formatRelative={formatRelative}
          formatClock={formatClock}
          summarizeEvent={summarizeEvent}
        />
      </div>
    </section>
  );
}

function deriveOfficeAgents(directory: AgentDirectoryRecord[], events: RealtimeEvent[]): OfficeAgentModel[] {
  const byRole = new Map<string, OfficeAgentModel>();
  const runtimeLookup = new Map<string, string>();

  for (const agent of directory) {
    const zoneId = inferOfficeZone(agent);
    byRole.set(agent.roleId, {
      ...agent,
      currentAction:
        agent.status === "active"
          ? "Pushing current assignment forward."
          : agent.status === "idle"
            ? "Idle with warm context."
            : "Waiting for first assignment.",
      currentThought:
        agent.status === "ready" ? "Standing by for orders from GoatHerder." : "Monitoring the event rail.",
      currentTaskLabel: "Standby slot",
      lastSeenAt: undefined,
      risk: "none",
      eventTrail: [],
      activityState: "idle_milling",
      collabPeers: [],
      zoneId,
      zoneLabel: officeZoneLabel(zoneId),
      attentionLevel: "stable",
      behaviorDirective: "Patrol the event rail and hold warm context for the next task.",
      workloadScore: 0.18,
    });

    if (agent.runtimeAgentId) {
      runtimeLookup.set(normalize(agent.runtimeAgentId), agent.roleId);
    }
    runtimeLookup.set(normalize(agent.name), agent.roleId);
    if (agent.runtimeName) {
      runtimeLookup.set(normalize(agent.runtimeName), agent.roleId);
    }
  }

  for (const event of events) {
    const roleId = resolveEventRoleId(event, runtimeLookup);
    if (!roleId) {
      continue;
    }

    const existing = byRole.get(roleId);
    if (!existing) {
      continue;
    }

    const details = describeAgentEvent(event);
    const shouldRefresh =
      !existing.lastSeenAt || parseTimestamp(event.timestamp) >= parseTimestamp(existing.lastSeenAt);
    const nextEventTrail = existing.eventTrail.length < 12 ? [...existing.eventTrail, event] : existing.eventTrail;

    byRole.set(roleId, {
      ...existing,
      currentAction: shouldRefresh ? details.action : existing.currentAction,
      currentThought: shouldRefresh ? details.thought : existing.currentThought,
      lastSeenAt: shouldRefresh ? event.timestamp : existing.lastSeenAt,
      lastEventType: shouldRefresh ? event.eventType : existing.lastEventType,
      taskId: shouldRefresh ? details.taskId : existing.taskId,
      sessionId: shouldRefresh ? details.sessionId : existing.sessionId,
      risk: shouldRefresh ? details.risk : existing.risk,
      status: shouldRefresh && details.status ? details.status : existing.status,
      eventTrail: nextEventTrail,
    });
  }

  const agents = [...byRole.values()];
  const byTask = new Map<string, string[]>();
  const bySession = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.taskId) {
      const list = byTask.get(agent.taskId) ?? [];
      list.push(agent.roleId);
      byTask.set(agent.taskId, list);
    }
    if (agent.sessionId) {
      const list = bySession.get(agent.sessionId) ?? [];
      list.push(agent.roleId);
      bySession.set(agent.sessionId, list);
    }
  }

  const peersByRole = new Map<string, Set<string>>();
  const linkGroup = (group: string[]) => {
    if (group.length < 2) {
      return;
    }
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i]!;
        const right = group[j]!;
        const leftPeers = peersByRole.get(left) ?? new Set<string>();
        leftPeers.add(right);
        peersByRole.set(left, leftPeers);

        const rightPeers = peersByRole.get(right) ?? new Set<string>();
        rightPeers.add(left);
        peersByRole.set(right, rightPeers);
      }
    }
  };

  byTask.forEach(linkGroup);
  bySession.forEach(linkGroup);

  const now = Date.now();
  const nextAgents = agents.map((agent) => {
    const ageMs = now - parseTimestamp(agent.lastSeenAt);
    const peers = [...(peersByRole.get(agent.roleId) ?? [])].sort();
    let activityState: OfficeAgentModel["activityState"];

    if (agent.risk === "blocked" || agent.risk === "error") {
      activityState = "alert_response";
    } else if (agent.status === "active") {
      activityState = ageMs <= ACTIVITY_TRANSITION_WINDOW_MS ? "transitioning_to_desk" : "working_seated";
    } else {
      activityState = "idle_milling";
    }

    if (
      activityState !== "alert_response" &&
      peers.length > 0 &&
      (agent.status === "active" || agent.risk !== "none")
    ) {
      activityState = "collaborating";
    }

    return {
      ...agent,
      lastSeenAt: agent.lastSeenAt ?? agent.lastUpdatedAt,
      currentTaskLabel: deriveCurrentTaskLabel(agent),
      collabPeers: peers,
      activityState,
      attentionLevel: deriveAttentionLevel(agent),
      behaviorDirective: deriveBehaviorDirective(agent, peers.length),
      workloadScore: deriveWorkloadScore(agent, ageMs, peers.length),
    };
  });

  return nextAgents.sort((left, right) => {
    const statusDelta = statusScore(right.status) - statusScore(left.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    return parseTimestamp(right.lastSeenAt) - parseTimestamp(left.lastSeenAt);
  });
}

function deriveCollaborationEdges(agents: OfficeAgentModel[]): OfficeCollaborationEdge[] {
  const byRole = new Map(agents.map((agent) => [agent.roleId, agent]));
  const edgeMap = new Map<string, OfficeCollaborationEdge>();

  for (const agent of agents) {
    if (agent.collabPeers.length === 0) {
      continue;
    }
    for (const peerRoleId of agent.collabPeers) {
      if (peerRoleId === agent.roleId) {
        continue;
      }
      const peer = byRole.get(peerRoleId);
      if (!peer) {
        continue;
      }
      const risk = agent.risk !== "none" || peer.risk !== "none";
      const orderedRoles = [agent.roleId, peerRoleId].sort();
      const fromRoleId = orderedRoles[0] ?? agent.roleId;
      const toRoleId = orderedRoles[1] ?? peerRoleId;
      const key = `${fromRoleId}->${toRoleId}`;
      const recencyBoost =
        classifyAgentHeat(agent.lastSeenAt) === "hot" || classifyAgentHeat(peer.lastSeenAt) === "hot"
          ? 0.7
          : classifyAgentHeat(agent.lastSeenAt) === "warm" || classifyAgentHeat(peer.lastSeenAt) === "warm"
            ? 0.35
            : 0.1;
      const sharedContextBoost =
        agent.taskId && peer.taskId && agent.taskId === peer.taskId
          ? 1
          : agent.sessionId && peer.sessionId && agent.sessionId === peer.sessionId
            ? 0.75
            : 0.35;
      const crossZoneBoost = agent.zoneId !== peer.zoneId ? 0.28 : 0;
      const strengthDelta = sharedContextBoost + recencyBoost + crossZoneBoost + (risk ? 0.18 : 0);
      const existing = edgeMap.get(key);
      if (existing) {
        existing.strength = Math.min(3, existing.strength + strengthDelta * 0.34);
        existing.risk = existing.risk || risk;
        continue;
      }
      edgeMap.set(key, {
        fromRoleId,
        toRoleId,
        strength: Math.min(3, 0.72 + strengthDelta * 0.56),
        risk,
      });
    }
  }

  return [...edgeMap.values()]
    .sort((left, right) => {
      if (left.risk !== right.risk) {
        return left.risk ? -1 : 1;
      }
      return right.strength - left.strength;
    })
    .slice(0, MAX_VISIBLE_COLLAB_EDGES);
}

function resolveEventRoleId(event: RealtimeEvent, runtimeLookup: Map<string, string>): string | undefined {
  const payload = asRecord(event.payload);
  const activity = asRecord(payload.activity);
  const session = asRecord(payload.session);
  const task = asRecord(payload.task);

  const actorType = asString(payload.actorType);
  const candidates = [
    asString(payload.agentId),
    actorType === "agent" ? asString(payload.actorId) : undefined,
    asString(activity.agentId),
    asString(session.agentName),
    asString(session.agentSessionId),
    asString(task.assignedAgentId),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const byRuntime = runtimeLookup.get(normalize(candidate));
    if (byRuntime) {
      return byRuntime;
    }
    const inferred = inferRoleId(candidate);
    if (inferred) {
      return inferred;
    }
  }

  return undefined;
}

function describeAgentEvent(event: RealtimeEvent): {
  action: string;
  thought: string;
  taskId?: string;
  sessionId?: string;
  status?: OfficeAgentModel["status"];
  risk: AgentRisk;
} {
  const payload = asRecord(event.payload);
  const taskId = extractTaskId(event);
  const sessionId = extractSessionId(event);

  if (event.eventType === "tool_invoked") {
    const toolName = asString(payload.toolName) ?? "tool";
    const outcome = asString(payload.outcome) ?? "executed";
    const policyReason = asString(payload.policyReason) ?? "policy gate reviewed the request";

    if (outcome === "approval_required") {
      return {
        action: `Waiting for approval to run ${toolName}.`,
        thought: `Safety gate paused execution: ${policyReason}.`,
        taskId,
        sessionId,
        status: "active",
        risk: "approval",
      };
    }
    if (outcome === "blocked") {
      return {
        action: `${toolName} blocked by policy.`,
        thought: policyReason,
        taskId,
        sessionId,
        status: "idle",
        risk: "blocked",
      };
    }
    return {
      action: `Executing ${toolName}.`,
      thought: `Policy outcome: ${policyReason}.`,
      taskId,
      sessionId,
      status: "active",
      risk: "none",
    };
  }

  if (event.eventType === "subagent_registered") {
    return {
      action: "Opened a new goat sub-agent session.",
      thought: "Bootstrapping workspace and context.",
      taskId,
      sessionId,
      status: "active",
      risk: "none",
    };
  }

  if (event.eventType === "subagent_updated") {
    const session = asRecord(payload.session);
    const status = asString(session.status);
    if (status === "completed") {
      return {
        action: "Completed current sub-agent run.",
        thought: "Ready to hand off results.",
        taskId,
        sessionId,
        status: "idle",
        risk: "none",
      };
    }
    if (status === "failed" || status === "killed") {
      return {
        action: `Session ended (${status}).`,
        thought: "Needs operator review before retry.",
        taskId,
        sessionId,
        status: "idle",
        risk: "error",
      };
    }
    return {
      action: "Sub-agent session active.",
      thought: "Working inside the assigned workspace.",
      taskId,
      sessionId,
      status: "active",
      risk: "none",
    };
  }

  if (event.eventType === "activity_logged") {
    const activity = asRecord(payload.activity);
    const message = asString(activity.message) ?? "Task activity logged.";
    return {
      action: "Recorded task activity.",
      thought: truncate(message, 180),
      taskId,
      sessionId,
      status: "active",
      risk: "none",
    };
  }

  if (event.eventType === "task_updated" || event.eventType === "task_created") {
    const task = asRecord(payload.task);
    const title = asString(task.title) ?? "task";
    const status = asString(task.status);
    return {
      action: `${event.eventType === "task_created" ? "Created" : "Updated"} ${title}.`,
      thought: status ? `Task status is ${status}.` : "Task metadata changed.",
      taskId,
      sessionId,
      status: status === "done" ? "idle" : "active",
      risk: "none",
    };
  }

  if (event.eventType === "orchestration_event") {
    const orchestrationEvent = asString(payload.event) ?? "phase_update";
    return {
      action: `Orchestration update: ${orchestrationEvent}.`,
      thought: "Tracking wave and phase progression.",
      taskId,
      sessionId,
      status: "active",
      risk: "none",
    };
  }

  return {
    action: `Handled ${event.eventType}.`,
    thought: "Monitoring and waiting for next instruction.",
    taskId,
    sessionId,
    risk: "none",
  };
}

// summarizeEvent, extractTaskId, extractSessionId, attentionLabel, attentionPillClass
// extracted to ./office/office-page-helpers.ts (Step 10 round 3).

function deriveAttentionLevel(
  agent: Pick<OfficeAgentModel, "risk" | "activityState" | "status">,
): OfficeAttentionLevel {
  if (agent.activityState === "alert_response" || agent.risk === "blocked" || agent.risk === "error") {
    return "priority";
  }
  if (agent.risk === "approval" || agent.activityState === "collaborating" || agent.status === "active") {
    return "watch";
  }
  return "stable";
}

function deriveBehaviorDirective(
  agent: Pick<OfficeAgentModel, "risk" | "activityState" | "status">,
  peerCount: number,
): string {
  if (agent.activityState === "alert_response" || agent.risk === "blocked" || agent.risk === "error") {
    return "Escalate the blocked path, keep the inspector pinned, and clear the failing handoff before new work enters the zone.";
  }
  if (agent.risk === "approval") {
    return "Hold warm context, surface the approval dependency, and stay ready to resume as soon as review clears.";
  }
  if (agent.activityState === "collaborating" || peerCount > 0) {
    return "Keep the shared task synchronized across linked goats and publish progress without breaking zone cadence.";
  }
  if (agent.activityState === "transitioning_to_desk") {
    return "Route the fresh signal into the desk, stabilize context, and settle into execution before accepting another interrupt.";
  }
  if (agent.activityState === "working_seated" || agent.status === "active") {
    return "Stay seated on execution, keep the desk feed current, and emit progress back to GoatHerder.";
  }
  if (agent.status === "ready") {
    return "Hold warm context, keep tools staged, and wait for the next assignment burst.";
  }
  return "Patrol the event rail, preserve context, and be ready to absorb the next signal.";
}

function deriveCurrentTaskLabel(agent: Pick<OfficeAgentModel, "taskId" | "sessionId" | "status">): string {
  if (agent.taskId) {
    return agent.taskId;
  }
  if (agent.sessionId) {
    return agent.sessionId;
  }
  if (agent.status === "ready") {
    return "Ready reserve";
  }
  if (agent.status === "active") {
    return "Live execution";
  }
  return "Standby slot";
}

function deriveWorkloadScore(
  agent: Pick<OfficeAgentModel, "status" | "risk" | "activityState" | "attentionLevel">,
  ageMs: number,
  peerCount: number,
): number {
  let score = agent.status === "active" ? 0.48 : agent.status === "ready" ? 0.24 : 0.14;
  if (agent.risk === "approval") {
    score += 0.22;
  } else if (agent.risk === "blocked" || agent.risk === "error") {
    score += 0.36;
  }
  if (agent.activityState === "collaborating") {
    score += 0.14;
  }
  if (agent.activityState === "alert_response") {
    score += 0.2;
  }
  if (peerCount > 1) {
    score += Math.min(0.16, peerCount * 0.04);
  }
  if (ageMs <= HOT_AGENT_WINDOW_MS) {
    score += 0.08;
  } else if (ageMs <= WARM_AGENT_WINDOW_MS) {
    score += 0.03;
  }
  if (agent.attentionLevel === "priority") {
    score += 0.12;
  } else if (agent.attentionLevel === "watch") {
    score += 0.05;
  }
  return Math.max(0.12, Math.min(1, score));
}

function buildAgentHandoffs(
  agent: Pick<OfficeAgentModel, "collabPeers" | "eventTrail" | "currentTaskLabel" | "risk">,
  officeAgentNamesByRole: Map<string, string>,
): AgentHandoff[] {
  const handoffs: AgentHandoff[] = [];

  for (const peerRoleId of agent.collabPeers.slice(0, 3)) {
    handoffs.push({
      label: "Cross-desk sync",
      detail: `Linked with ${officeAgentNamesByRole.get(peerRoleId) ?? peerRoleId} on ${agent.currentTaskLabel}.`,
    });
  }

  for (const event of agent.eventTrail.slice(-6).reverse()) {
    if (event.eventType === "tool_invoked") {
      const payload = asRecord(event.payload);
      const toolName = asString(payload.toolName) ?? "tool";
      const outcome = asString(payload.outcome) ?? "executed";
      handoffs.push({
        label: outcome === "approval_required" ? "Approval handoff" : "Tool handoff",
        detail: `${toolName} returned ${outcome}.`,
        timestamp: event.timestamp,
      });
    } else if (event.eventType === "subagent_updated") {
      const session = asRecord(asRecord(event.payload).session);
      const status = asString(session.status) ?? "updated";
      handoffs.push({
        label: "Sub-agent handoff",
        detail: `Session ${status} for ${agent.currentTaskLabel}.`,
        timestamp: event.timestamp,
      });
    } else if (event.eventType === "task_updated" || event.eventType === "task_created") {
      handoffs.push({
        label: "Task handoff",
        detail: summarizeEvent(event),
        timestamp: event.timestamp,
      });
    }
  }

  if (agent.risk !== "none" && handoffs.length === 0) {
    handoffs.push({
      label: "Risk handoff",
      detail: `Current risk state is ${agent.risk}. Operator review is likely the next hop.`,
    });
  }

  return handoffs.slice(0, 4);
}

function deriveZoneActivityLanes(agents: OfficeAgentModel[]): OfficeZoneActivityLane[] {
  const byRole = new Map(agents.map((agent) => [agent.roleId, agent]));
  const lanes = new Map<string, OfficeZoneActivityLane>();

  for (const agent of agents) {
    for (const peerRoleId of agent.collabPeers) {
      const peer = byRole.get(peerRoleId);
      if (!peer || peer.zoneId === agent.zoneId) {
        continue;
      }
      const orderedZones = [agent.zoneId, peer.zoneId].sort();
      const fromZoneId = orderedZones[0] as OfficeZoneId;
      const toZoneId = orderedZones[1] as OfficeZoneId;
      const key = `${fromZoneId}->${toZoneId}`;
      const risk = agent.risk !== "none" || peer.risk !== "none";
      const existing = lanes.get(key);
      if (existing) {
        existing.count += 1;
        existing.risk = existing.risk || risk;
        existing.strength = Math.min(1, existing.strength + 0.14 + (risk ? 0.08 : 0));
        continue;
      }
      lanes.set(key, {
        fromZoneId,
        toZoneId,
        fromLabel: officeZoneLabel(fromZoneId),
        toLabel: officeZoneLabel(toZoneId),
        strength: 0.34 + (risk ? 0.16 : 0),
        count: 1,
        risk,
        label: `${agent.name} and ${peer.name} are actively linking work across decks.`,
      });
    }
  }

  return [...lanes.values()]
    .sort((left, right) => {
      if (left.risk !== right.risk) {
        return left.risk ? -1 : 1;
      }
      return right.count - left.count;
    })
    .slice(0, MAX_VISIBLE_ZONE_LANES);
}

function deriveSignalRoutes(agents: OfficeAgentModel[]): OfficeSignalRoute[] {
  return agents
    .filter((agent) => agent.risk !== "none")
    .map((agent) => {
      const kind: OfficeSignalRoute["kind"] =
        agent.risk === "approval" ? "approval" : agent.risk === "blocked" ? "blocked" : "error";
      return {
        roleId: agent.roleId,
        zoneId: agent.zoneId,
        kind,
        label: agent.risk === "approval" ? `${agent.name} needs review` : `${agent.name} is in escalation`,
        intensity: Math.max(0.45, agent.workloadScore),
      };
    })
    .sort((left, right) => right.intensity - left.intensity)
    .slice(0, 6);
}

function deriveZoneTelemetry(
  agents: OfficeAgentModel[],
  zoneActivityLanes: OfficeZoneActivityLane[],
): OfficeZoneTelemetry[] {
  return OFFICE_ZONE_ORDER.map((zoneId) => {
    const zoneAgents = agents.filter((agent) => agent.zoneId === zoneId);
    const totalAgents = zoneAgents.length;
    const activeAgents = zoneAgents.filter((agent) => agent.status === "active").length;
    const linkedAgents = zoneAgents.filter((agent) => agent.activityState === "collaborating").length;
    const alertAgents = zoneAgents.filter((agent) => agent.attentionLevel === "priority").length;
    const watchAgents = zoneAgents.filter((agent) => agent.attentionLevel === "watch").length;
    const lastSignalAt = zoneAgents.reduce((latest, agent) => {
      return Math.max(latest, parseTimestamp(agent.lastSeenAt));
    }, 0);
    const laneCount = zoneActivityLanes.filter((lane) => lane.fromZoneId === zoneId || lane.toZoneId === zoneId).length;
    const workloadScore =
      totalAgents === 0 ? 0 : zoneAgents.reduce((sum, agent) => sum + agent.workloadScore, 0) / totalAgents;
    const hottestAgent =
      zoneAgents.find((agent) => agent.attentionLevel === "priority") ??
      zoneAgents.find((agent) => agent.attentionLevel === "watch") ??
      zoneAgents[0];
    const landmark = zoneLandmark(zoneId);
    const architectureNote = zoneArchitectureNote(zoneId, workloadScore);

    let focus = "No goats assigned to this deck yet.";
    if (hottestAgent?.attentionLevel === "priority") {
      focus = `${hottestAgent.name} is in escalation mode. Clear the block before new work lands here.`;
    } else if (hottestAgent?.attentionLevel === "watch") {
      focus = `${hottestAgent.name} is carrying the live signal. Keep this deck in view for follow-up.`;
    } else if (activeAgents > 0) {
      focus = `${activeAgents} goats are executing inside this deck with no active hold.`;
    } else if (totalAgents > 0) {
      focus = `${totalAgents} goats are holding warm context and waiting for the next signal.`;
    }

    return {
      zoneId,
      label: officeZoneLabel(zoneId),
      totalAgents,
      activeAgents,
      linkedAgents,
      alertAgents,
      focus,
      attentionLevel: alertAgents > 0 ? "priority" : watchAgents > 0 ? "watch" : "stable",
      workloadScore,
      lastSignalAt: lastSignalAt > 0 ? new Date(lastSignalAt).toISOString() : undefined,
      laneCount,
      landmark,
      architectureNote,
    };
  });
}

function zoneLandmark(zoneId: OfficeZoneId): string {
  if (zoneId === "command") {
    return "Command spire";
  }
  if (zoneId === "research") {
    return "Signal halo";
  }
  if (zoneId === "build") {
    return "Forge stacks";
  }
  if (zoneId === "security") {
    return "Sentinel wall";
  }
  return "Relay gantry";
}

function zoneArchitectureNote(zoneId: OfficeZoneId, workloadScore: number): string {
  const loadLabel =
    workloadScore >= 0.72 ? "running hot" : workloadScore >= 0.42 ? "holding live pressure" : "idling cool";
  if (zoneId === "command") {
    return `${loadLabel} with bridge lighting and command rails.`;
  }
  if (zoneId === "research") {
    return `${loadLabel} with halo frames and open scan surfaces.`;
  }
  if (zoneId === "build") {
    return `${loadLabel} with forge geometry and heavy work bays.`;
  }
  if (zoneId === "security") {
    return `${loadLabel} with shield walls and hard angles.`;
  }
  return `${loadLabel} with relay towers and routing pylons.`;
}

export function describeGoatAssetStatus(assetPack: OfficeAssetPack): {
  tone: "live" | "muted" | "warning";
  chipLabel: string;
  helpLabel: string;
  helpCopy: string;
} {
  if (assetPack.goatModelVariant === "animated") {
    return {
      tone: "live",
      chipLabel: "Animated goat live",
      helpLabel: assetPack.goatModelLabel ?? "Animated Goat",
      helpCopy: " Animation clips are enabled when the current GLB provides them.",
    };
  }
  if (assetPack.goatModelPath) {
    return {
      tone: "muted",
      chipLabel: "Fallback goat live",
      helpLabel: assetPack.goatModelLabel ?? "Goat Subagent",
      helpCopy: " Static goat fallback is active until an animated GLB is added to the asset manifest.",
    };
  }
  return {
    tone: "warning",
    chipLabel: "Procedural goat live",
    helpLabel: assetPack.goatModelLabel ?? "Procedural Goat",
    helpCopy: " No shipped goat asset resolved, so the scene is using the procedural fallback.",
  };
}

function scheduleSceneActivation(callback: () => void): () => void {
  if (typeof window === "undefined") {
    callback();
    return () => undefined;
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 250 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 120);
  return () => window.clearTimeout(handle);
}

export async function loadOfficeAssetPack(): Promise<OfficeAssetPack> {
  type AssetManifestModel = { id?: string; label?: string; path?: string; includedInRepo?: boolean };
  type OfficeAssetPathKey =
    | "roomFloorTilePath"
    | "roomWallPath"
    | "roomWindowWallPath"
    | "roomColumnPath"
    | "roomLightPath"
    | "deskModelPath"
    | "commandDeskModelPath"
    | "chairModelPath"
    | "lockerModelPath"
    | "shelfModelPath"
    | "crateModelPath"
    | "accessPointModelPath"
    | "computerModelPath"
    | "mugModelPath";

  let manifest: {
    models?: AssetManifestModel[];
  };
  const proceduralFallback: OfficeAssetPack = {
    goatModelVariant: "procedural",
    goatModelLabel: "Procedural Goat",
  };

  try {
    const response = await fetch("/assets/office/asset-manifest.json");
    if (!response.ok) {
      return proceduralFallback;
    }
    manifest = (await response.json()) as {
      models?: AssetManifestModel[];
    };
  } catch {
    return proceduralFallback;
  }

  const includedModels = new Map<string, AssetManifestModel>();
  for (const model of manifest.models ?? []) {
    if (model.id && model.path && model.includedInRepo) {
      includedModels.set(model.id, model);
    }
  }

  const optionalModelMap: Array<[id: string, key: OfficeAssetPathKey]> = [
    ["office-floor-tile", "roomFloorTilePath"],
    ["office-wall-panel", "roomWallPath"],
    ["office-wall-window-panel", "roomWindowWallPath"],
    ["office-column-round", "roomColumnPath"],
    ["office-light-wide", "roomLightPath"],
    ["office-desk-medium", "deskModelPath"],
    ["office-desk-command", "commandDeskModelPath"],
    ["office-chair", "chairModelPath"],
    ["office-locker", "lockerModelPath"],
    ["office-shelf", "shelfModelPath"],
    ["office-crate", "crateModelPath"],
    ["office-access-point", "accessPointModelPath"],
    ["office-computer", "computerModelPath"],
    ["office-mug", "mugModelPath"],
  ];

  const idsToResolve = [
    "central-operator",
    "goat-subagent-animated",
    "goat-subagent",
    ...optionalModelMap.map(([id]) => id),
  ];

  const resolvedEntries = await Promise.all(
    idsToResolve.map(async (id) => {
      const model = includedModels.get(id);
      if (!model?.path) {
        return [id, undefined] as const;
      }
      const exists = await checkAssetExists(model.path);
      return [id, exists ? model : undefined] as const;
    }),
  );

  const resolvedById = new Map<string, AssetManifestModel>();
  for (const [id, model] of resolvedEntries) {
    if (model) {
      resolvedById.set(id, model);
    }
  }

  const pack: OfficeAssetPack = {
    goatModelVariant: "procedural",
    goatModelLabel: "Procedural Goat",
  };

  const operator = resolvedById.get("central-operator");
  if (operator?.path) {
    pack.operatorModelPath = operator.path;
  }

  const animatedGoat = resolvedById.get("goat-subagent-animated");
  const goat = resolvedById.get("goat-subagent");
  if (animatedGoat?.path) {
    pack.goatModelPath = animatedGoat.path;
    pack.goatModelVariant = "animated";
    pack.goatModelLabel = animatedGoat.label ?? "Animated Goat";
  } else if (goat?.path) {
    pack.goatModelPath = goat.path;
    pack.goatModelVariant = "fallback";
    pack.goatModelLabel = goat.label ?? "Goat Subagent";
  }

  for (const [id, key] of optionalModelMap) {
    const model = resolvedById.get(id);
    if (model?.path) {
      pack[key] = model.path;
    }
  }

  return pack;
}

async function checkAssetExists(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// readOperatorPreferences, persistOperatorPreferences, sanitizeOperatorName,
// isOperatorPreset, isOfficeMotionMode, asBooleanOr extracted to
// ./office/office-page-helpers.ts (Step 10 round 3).
