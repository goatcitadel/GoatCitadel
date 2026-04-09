import { useCallback, useEffect, useMemo, useState } from "react";
import type { OfficeMotionMode, OfficeOperatorModel } from "../../components/OfficeCanvas";
import type { RealtimeEvent } from "../../api/client";
import type { AgentDirectoryRecord } from "../../data/agent-roster";
import { OFFICE_ZONE_ORDER, officeZoneLabel, type OfficeZoneId } from "../../data/office-zones";
import {
  EVENTS_PER_MINUTE_WINDOW_MS,
  MOTION_MODE_OPTIONS,
  PLAYBACK_SPEED_OPTIONS,
  PLAYBACK_STEP_MS,
  PLAYBACK_WINDOW_MS,
  type OfficeDockTab,
  type OperatorPreferences,
} from "./office-page-constants";
import { buildOperatorThought, classifyAgentHeat, parseTimestamp, sortEvents } from "./office-page-helpers";
import type {
  AgentHandoff,
  OfficeAgentModel,
  OfficeAssetPack,
  OfficeSignalRoute,
  OfficeZoneActivityLane,
  OfficeZoneTelemetry,
} from "./office-agent-model";

export interface OfficePlaybackState {
  mode: "live" | "replay";
  playing: boolean;
  speed: 1 | 2 | 4;
  cursorTime?: number;
}

type SelectedEntityId = "operator" | string;

interface UseOfficeStageStateArgs {
  directory: AgentDirectoryRecord[];
  events: RealtimeEvent[];
  operatorPrefs: OperatorPreferences;
  initialDockTab: OfficeDockTab;
  pendingApprovalsCount: number;
  assetPack: OfficeAssetPack;
  prefersReducedMotion: boolean;
  deriveOfficeAgents: (directory: AgentDirectoryRecord[], events: RealtimeEvent[]) => OfficeAgentModel[];
  deriveCollaborationEdges: (
    agents: OfficeAgentModel[],
  ) => import("../../components/OfficeCanvas").OfficeCollaborationEdge[];
  deriveZoneActivityLanes: (agents: OfficeAgentModel[]) => OfficeZoneActivityLane[];
  deriveZoneTelemetry: (agents: OfficeAgentModel[], lanes: OfficeZoneActivityLane[]) => OfficeZoneTelemetry[];
  deriveSignalRoutes: (agents: OfficeAgentModel[]) => OfficeSignalRoute[];
  buildAgentHandoffs: (
    agent: Pick<OfficeAgentModel, "collabPeers" | "eventTrail" | "currentTaskLabel" | "risk">,
    names: Map<string, string>,
  ) => AgentHandoff[];
  describeGoatAssetStatus: (assetPack: OfficeAssetPack) => {
    tone: "default" | "live" | "warning" | "critical" | "success" | "muted";
    chipLabel: string;
    helpLabel: string;
    helpCopy: string;
  };
  scheduleSceneActivation: (setSceneReady: () => void) => () => void;
}

export function useOfficeStageState({
  directory,
  events,
  operatorPrefs,
  initialDockTab,
  pendingApprovalsCount,
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
}: UseOfficeStageStateArgs) {
  const [selectedEntityId, setSelectedEntityId] = useState<SelectedEntityId>("operator");
  const [dockTab, setDockTab] = useState<OfficeDockTab>(initialDockTab);
  const [focusedZoneOverride, setFocusedZoneOverride] = useState<OfficeZoneId | null>(null);
  const [playback, setPlayback] = useState<OfficePlaybackState>({
    mode: "live",
    playing: false,
    speed: 2,
  });
  const [sceneReady, setSceneReady] = useState(false);

  const sortedEvents = useMemo(() => sortEvents(events), [events]);
  const replayWindow = useMemo(() => {
    const newestTimestamp = parseTimestamp(sortedEvents[0]?.timestamp) || Date.now();
    const startTime = newestTimestamp - PLAYBACK_WINDOW_MS;
    const replayableEvents = sortedEvents.filter((event) => parseTimestamp(event.timestamp) >= startTime);
    const earliestReplayTimestamp = parseTimestamp(replayableEvents.at(-1)?.timestamp);
    return {
      newestTimestamp,
      replayableEvents,
      startTime: earliestReplayTimestamp || startTime,
      endTime: newestTimestamp,
    };
  }, [sortedEvents]);
  const playbackCursorTime = playback.mode === "replay" ? (playback.cursorTime ?? replayWindow.startTime) : undefined;
  const sceneEvents = useMemo(() => {
    if (playback.mode !== "replay") {
      return sortedEvents;
    }
    return sortedEvents.filter((event) => {
      const timestamp = parseTimestamp(event.timestamp);
      return timestamp >= replayWindow.startTime && timestamp <= (playbackCursorTime ?? replayWindow.startTime);
    });
  }, [playback.mode, playbackCursorTime, replayWindow.startTime, sortedEvents]);

  const officeAgents = useMemo(
    () => deriveOfficeAgents(directory, sceneEvents),
    [deriveOfficeAgents, directory, sceneEvents],
  );
  const officeAgentNamesByRole = useMemo(
    () => new Map(officeAgents.map((agent) => [agent.roleId, agent.name])),
    [officeAgents],
  );
  const collaborationEdges = useMemo(
    () => deriveCollaborationEdges(officeAgents),
    [deriveCollaborationEdges, officeAgents],
  );
  const zoneActivityLanes = useMemo(
    () => deriveZoneActivityLanes(officeAgents),
    [deriveZoneActivityLanes, officeAgents],
  );
  const zoneTelemetry = useMemo(
    () => deriveZoneTelemetry(officeAgents, zoneActivityLanes),
    [deriveZoneTelemetry, officeAgents, zoneActivityLanes],
  );
  const signalRoutes = useMemo(() => deriveSignalRoutes(officeAgents), [deriveSignalRoutes, officeAgents]);
  const selectedAgent = useMemo(
    () => officeAgents.find((agent) => agent.roleId === selectedEntityId),
    [officeAgents, selectedEntityId],
  );
  const selectionZoneId = useMemo<OfficeZoneId>(
    () => (selectedEntityId === "operator" ? "command" : (selectedAgent?.zoneId ?? "command")),
    [selectedAgent?.zoneId, selectedEntityId],
  );
  const selectedZoneId = useMemo<OfficeZoneId>(
    () => (operatorPrefs.focusMode ? (focusedZoneOverride ?? selectionZoneId) : selectionZoneId),
    [focusedZoneOverride, operatorPrefs.focusMode, selectionZoneId],
  );
  const selectedZoneTelemetry = useMemo(
    () => zoneTelemetry.find((zone) => zone.zoneId === selectedZoneId) ?? null,
    [selectedZoneId, zoneTelemetry],
  );
  const stageZoneTelemetry = useMemo(
    () => (operatorPrefs.focusMode ? zoneTelemetry.filter((zone) => zone.zoneId === selectedZoneId) : zoneTelemetry),
    [operatorPrefs.focusMode, selectedZoneId, zoneTelemetry],
  );
  const selectedAgentHandoffs = useMemo(
    () => (selectedAgent ? buildAgentHandoffs(selectedAgent, officeAgentNamesByRole) : []),
    [buildAgentHandoffs, officeAgentNamesByRole, selectedAgent],
  );
  const focusSummary = useMemo(() => {
    if (!operatorPrefs.focusMode) {
      return null;
    }
    if (selectedEntityId === "operator") {
      return {
        title: `${operatorPrefs.name} focus lens`,
        summary: "Command view tightens around the bridge while the rest of the office quiets down.",
        detail: selectedZoneTelemetry?.focus ?? "Command pressure is stable.",
      };
    }
    return {
      title: `${selectedAgent?.name ?? "Selected desk"} focus lens`,
      summary: `${selectedAgent?.zoneLabel ?? officeZoneLabel(selectedZoneId)} takes priority, with background desks de-emphasized.`,
      detail:
        selectedAgent?.behaviorDirective ??
        selectedAgent?.currentAction ??
        selectedZoneTelemetry?.focus ??
        "Selected desk is in focus.",
    };
  }, [
    operatorPrefs.focusMode,
    operatorPrefs.name,
    selectedAgent?.behaviorDirective,
    selectedAgent?.currentAction,
    selectedAgent?.name,
    selectedAgent?.zoneLabel,
    selectedEntityId,
    selectedZoneId,
    selectedZoneTelemetry?.focus,
  ]);

  useEffect(() => {
    if (selectedEntityId === "operator") {
      return;
    }
    const exists = officeAgents.some((agent) => agent.roleId === selectedEntityId);
    if (!exists) {
      setSelectedEntityId("operator");
    }
  }, [officeAgents, selectedEntityId]);

  useEffect(() => {
    if (!operatorPrefs.focusMode) {
      setFocusedZoneOverride(selectionZoneId);
      return;
    }
    setFocusedZoneOverride((current) => current ?? selectionZoneId);
  }, [operatorPrefs.focusMode, selectionZoneId]);

  useEffect(() => {
    if (playback.mode !== "replay") {
      return;
    }
    setPlayback((current) => ({
      ...current,
      cursorTime: current.cursorTime ?? replayWindow.startTime,
    }));
  }, [playback.mode, replayWindow.startTime]);

  useEffect(() => {
    if (playback.mode !== "replay" || !playback.playing) {
      return;
    }
    const interval = window.setInterval(() => {
      setPlayback((current) => {
        const baseCursor = current.cursorTime ?? replayWindow.startTime;
        const nextCursor = baseCursor + PLAYBACK_STEP_MS * current.speed;
        if (nextCursor >= replayWindow.endTime) {
          return {
            ...current,
            cursorTime: replayWindow.endTime,
            playing: false,
          };
        }
        return {
          ...current,
          cursorTime: nextCursor,
        };
      });
    }, 420);
    return () => window.clearInterval(interval);
  }, [playback.mode, playback.playing, replayWindow.endTime, replayWindow.startTime]);

  useEffect(() => {
    if (dockTab === "inspector" && operatorPrefs.showInspectorDock) {
      return;
    }
    if (dockTab !== "inspector" && operatorPrefs.showRailDock) {
      return;
    }
    if (operatorPrefs.showInspectorDock) {
      setDockTab("inspector");
      return;
    }
    if (operatorPrefs.showRailDock) {
      setDockTab("operators");
    }
  }, [dockTab, operatorPrefs.showInspectorDock, operatorPrefs.showRailDock]);

  const focusZone = useCallback(
    (zoneId: OfficeZoneId) => {
      setFocusedZoneOverride(zoneId);
      if (zoneId === "command") {
        setSelectedEntityId("operator");
        return;
      }
      const preferredAgent =
        officeAgents.find((agent) => agent.zoneId === zoneId && agent.attentionLevel === "priority") ??
        officeAgents.find((agent) => agent.zoneId === zoneId && agent.attentionLevel === "watch") ??
        officeAgents.find((agent) => agent.zoneId === zoneId);
      if (preferredAgent) {
        setSelectedEntityId(preferredAgent.roleId);
      }
    },
    [officeAgents],
  );

  useEffect(() => {
    if (!operatorPrefs.focusMode) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable)
      ) {
        return;
      }
      const zoneIndex = Number.parseInt(event.key, 10);
      if (zoneIndex >= 1 && zoneIndex <= OFFICE_ZONE_ORDER.length) {
        event.preventDefault();
        focusZone(OFFICE_ZONE_ORDER[zoneIndex - 1] ?? "command");
        return;
      }
      if (event.key !== "[" && event.key !== "]" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      const currentIndex = Math.max(0, OFFICE_ZONE_ORDER.indexOf(selectedZoneId));
      const delta = event.key === "[" || event.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = (currentIndex + delta + OFFICE_ZONE_ORDER.length) % OFFICE_ZONE_ORDER.length;
      focusZone(OFFICE_ZONE_ORDER[nextIndex] ?? "command");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusZone, operatorPrefs.focusMode, selectedZoneId]);

  const activeAgents = useMemo(() => officeAgents.filter((agent) => agent.status === "active").length, [officeAgents]);
  const readyAgents = useMemo(() => officeAgents.filter((agent) => agent.status === "ready").length, [officeAgents]);
  const eventFlow = useMemo(() => {
    const anchorTime = playback.mode === "replay" ? (playbackCursorTime ?? replayWindow.startTime) : Date.now();
    const threshold = anchorTime - EVENTS_PER_MINUTE_WINDOW_MS;
    const count = sceneEvents.filter((event) => {
      const timestamp = parseTimestamp(event.timestamp);
      return timestamp >= threshold && timestamp <= anchorTime;
    }).length;
    return count / 5;
  }, [playback.mode, playbackCursorTime, replayWindow.startTime, sceneEvents]);
  const hotAgents = useMemo(
    () => officeAgents.filter((agent) => classifyAgentHeat(agent.lastSeenAt) === "hot").length,
    [officeAgents],
  );
  const blockedAgents = useMemo(
    () => officeAgents.filter((agent) => agent.risk === "blocked" || agent.risk === "error").length,
    [officeAgents],
  );
  const priorityAgents = useMemo(
    () => officeAgents.filter((agent) => agent.attentionLevel === "priority").length,
    [officeAgents],
  );
  const watchAgents = useMemo(
    () => officeAgents.filter((agent) => agent.attentionLevel === "watch").length,
    [officeAgents],
  );

  const operatorActivityState: OfficeOperatorModel["activityState"] = useMemo(() => {
    if (activeAgents >= 3 || pendingApprovalsCount > 0 || eventFlow >= 2.2) {
      return "command_center";
    }
    return "idle_patrol";
  }, [activeAgents, eventFlow, pendingApprovalsCount]);

  const effectiveMotionMode: OfficeMotionMode = prefersReducedMotion
    ? "reduced"
    : operatorPrefs.quietMode && operatorPrefs.motionMode === "cinematic"
      ? "subtle"
      : operatorPrefs.quietMode && operatorPrefs.motionMode === "balanced"
        ? "subtle"
        : operatorPrefs.quietMode && operatorPrefs.motionMode === "subtle"
          ? "reduced"
          : operatorPrefs.motionMode;

  const sceneBusy = useMemo(
    () =>
      !operatorPrefs.quietMode && (blockedAgents > 0 || priorityAgents > 0 || activeAgents >= 4 || eventFlow >= 2.5),
    [activeAgents, blockedAgents, eventFlow, operatorPrefs.quietMode, priorityAgents],
  );
  const goatAssetStatus = useMemo(() => describeGoatAssetStatus(assetPack), [assetPack, describeGoatAssetStatus]);
  const sceneResetKey = useMemo(
    () =>
      [effectiveMotionMode, assetPack.goatModelPath ?? "procedural", assetPack.goatModelVariant ?? "procedural"].join(
        "::",
      ),
    [assetPack.goatModelPath, assetPack.goatModelVariant, effectiveMotionMode],
  );

  const operatorModel: OfficeOperatorModel = useMemo(
    () => ({
      operatorId: "operator",
      name: operatorPrefs.name,
      preset: operatorPrefs.preset,
      currentThought: buildOperatorThought({
        activeAgents,
        blockedAgents,
        pendingApprovals: pendingApprovalsCount,
        eventFlow,
      }),
      activityState: operatorActivityState,
    }),
    [
      activeAgents,
      blockedAgents,
      eventFlow,
      operatorActivityState,
      operatorPrefs.name,
      operatorPrefs.preset,
      pendingApprovalsCount,
    ],
  );

  useEffect(() => scheduleSceneActivation(() => setSceneReady(true)), [scheduleSceneActivation]);

  const availableDockTabs = useMemo(() => {
    const tabs: OfficeDockTab[] = [];
    if (operatorPrefs.showInspectorDock) {
      tabs.push("inspector");
    }
    if (operatorPrefs.showRailDock) {
      tabs.push("operators", "approvals", "rail");
    }
    return tabs;
  }, [operatorPrefs.showInspectorDock, operatorPrefs.showRailDock]);

  const handleEntitySelect = useCallback(
    (entityId: SelectedEntityId) => {
      const nextZoneId =
        entityId === "operator"
          ? "command"
          : (officeAgents.find((agent) => agent.roleId === entityId)?.zoneId ?? "command");
      setSelectedEntityId(entityId);
      if (operatorPrefs.focusMode) {
        setFocusedZoneOverride(nextZoneId);
      }
      if (operatorPrefs.showInspectorDock) {
        setDockTab("inspector");
      }
    },
    [officeAgents, operatorPrefs.focusMode, operatorPrefs.showInspectorDock],
  );

  const handlePlaybackModeChange = useCallback(
    (mode: OfficePlaybackState["mode"]) => {
      setPlayback((current) => ({
        ...current,
        mode,
        playing: mode === "replay" ? current.playing : false,
        cursorTime: mode === "replay" ? (current.cursorTime ?? replayWindow.startTime) : undefined,
      }));
    },
    [replayWindow.startTime],
  );

  return {
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
    motionModeOptions: MOTION_MODE_OPTIONS,
    playbackSpeedOptions: PLAYBACK_SPEED_OPTIONS,
  };
}
