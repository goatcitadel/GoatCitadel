import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  buildAgentDirectory,
  inferRoleId,
  type AgentDirectoryRecord,
} from "../data/agent-roster";
import type {
  OfficeAttentionLevel,
  OfficeCollaborationEdge,
  OfficeDeskAgent,
  OfficeMotionMode,
  OfficeOperatorModel,
  OperatorPreset,
} from "../components/OfficeCanvas";
import { OfficeCanvasErrorBoundary } from "../components/OfficeCanvasErrorBoundary";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { StatusChip } from "../components/StatusChip";
import { CardSkeleton } from "../components/CardSkeleton";
import { pageCopy } from "../content/copy";
import "../styles/office.css";
import { GCSelect } from "../components/ui";
import { OFFICE_ZONE_ORDER, inferOfficeZone, officeZoneLabel, type OfficeZoneId } from "../data/office-zones";

const INITIAL_EVENT_LIMIT = 100;
const MAX_EVENTS = 200;
const SNAPSHOT_INTERVAL_MS = 20_000;
const HOT_AGENT_WINDOW_MS = 2 * 60 * 1000;
const WARM_AGENT_WINDOW_MS = 10 * 60 * 1000;
const EVENTS_PER_MINUTE_WINDOW_MS = 5 * 60 * 1000;
const PLAYBACK_WINDOW_MS = 5 * 60 * 1000;
const PLAYBACK_STEP_MS = 12_000;
const ACTIVITY_TRANSITION_WINDOW_MS = 18_000;
const MAX_VISIBLE_COLLAB_EDGES = 8;
const MAX_VISIBLE_ZONE_LANES = 6;
const OPERATOR_NAME_OPTIONS = [
  "GoatHerder",
  "Lead Herder",
  "Herd Captain",
  "Trail Commander",
].map((value) => ({ value, label: value }));

export type OfficePageVariant = "stable" | "lab";

type AgentRisk = "none" | "approval" | "blocked" | "error";
type OfficeDockTab = "inspector" | "operators" | "approvals" | "rail";

interface OfficeAgentModel extends AgentDirectoryRecord {
  currentAction: string;
  currentThought: string;
  taskId?: string;
  sessionId?: string;
  currentTaskLabel: string;
  lastSeenAt?: string;
  lastEventType?: string;
  risk: AgentRisk;
  eventTrail: RealtimeEvent[];
  activityState: OfficeDeskAgent["activityState"];
  collabPeers: string[];
  zoneId: OfficeZoneId;
  zoneLabel: string;
  attentionLevel: OfficeAttentionLevel;
  behaviorDirective: string;
  workloadScore: number;
}

interface OfficeZoneTelemetry {
  zoneId: OfficeZoneId;
  label: string;
  totalAgents: number;
  activeAgents: number;
  linkedAgents: number;
  alertAgents: number;
  focus: string;
  attentionLevel: OfficeAttentionLevel;
  workloadScore: number;
  lastSignalAt?: string;
  laneCount: number;
  landmark: string;
  architectureNote: string;
}

interface OfficeZoneActivityLane {
  fromZoneId: OfficeZoneId;
  toZoneId: OfficeZoneId;
  fromLabel: string;
  toLabel: string;
  strength: number;
  count: number;
  risk: boolean;
  label: string;
}

interface OfficeSignalRoute {
  roleId: string;
  zoneId: OfficeZoneId;
  kind: "approval" | "blocked" | "error";
  label: string;
  intensity: number;
}

interface AgentHandoff {
  label: string;
  detail: string;
  timestamp?: string;
}

interface PlaybackState {
  mode: "live" | "replay";
  playing: boolean;
  speed: 1 | 2 | 4;
  cursorTime?: number;
}

interface OperatorPreferences {
  name: string;
  preset: OperatorPreset;
  layoutMode: "immersive";
  motionMode: OfficeMotionMode;
  showCollabOverlay: boolean;
  showInspectorDock: boolean;
  showRailDock: boolean;
  idleMillingEnabled: boolean;
  focusMode: boolean;
  quietMode: boolean;
  followSelection: boolean;
}

export interface OfficeAssetPack {
  operatorModelPath?: string;
  goatModelPath?: string;
  goatModelVariant?: "animated" | "fallback" | "procedural";
  goatModelLabel?: string;
  roomFloorTilePath?: string;
  roomWallPath?: string;
  roomWindowWallPath?: string;
  roomColumnPath?: string;
  roomLightPath?: string;
  deskModelPath?: string;
  commandDeskModelPath?: string;
  chairModelPath?: string;
  lockerModelPath?: string;
  shelfModelPath?: string;
  crateModelPath?: string;
  accessPointModelPath?: string;
  computerModelPath?: string;
  mugModelPath?: string;
}

type SelectedEntityId = "operator" | string;

const DEFAULT_OPERATOR_PREFS: OperatorPreferences = {
  name: "GoatHerder",
  preset: "trailblazer",
  layoutMode: "immersive",
  motionMode: "cinematic",
  showCollabOverlay: true,
  showInspectorDock: true,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: false,
  quietMode: false,
  followSelection: false,
};

const LAB_OPERATOR_PREFS: OperatorPreferences = {
  name: "Citadel Marshal",
  preset: "nightwatch",
  layoutMode: "immersive",
  motionMode: "balanced",
  showCollabOverlay: true,
  showInspectorDock: false,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: true,
  quietMode: true,
  followSelection: true,
};

const OFFICE_PAGE_VARIANTS: Record<OfficePageVariant, {
  pageId: "office" | "officeLab";
  storageKey: string;
  eyebrow: string;
  headerHint: string;
  defaultPrefs: OperatorPreferences;
  initialDockTab: OfficeDockTab;
}> = {
  stable: {
    pageId: "office",
    storageKey: "goatcitadel.office.operator",
    eyebrow: "Office",
    headerHint: "Herd HQ stays immersive. Use the dock and inspector to move between visual awareness and operational detail.",
    defaultPrefs: DEFAULT_OPERATOR_PREFS,
    initialDockTab: "inspector",
  },
  lab: {
    pageId: "officeLab",
    storageKey: "goatcitadel.office.lab.operator",
    eyebrow: "Office Lab",
    headerHint: "Citadel Lab keeps the same live office runtime but starts from a separate citadel-first profile so both offices can be compared safely.",
    defaultPrefs: LAB_OPERATOR_PREFS,
    initialDockTab: "rail",
  },
};

const MOTION_MODE_OPTIONS: Array<{ value: OfficeMotionMode; label: string }> = [
  { value: "cinematic", label: "Cinematic" },
  { value: "balanced", label: "Balanced" },
  { value: "subtle", label: "Subtle" },
  { value: "reduced", label: "Reduced" },
];

const PLAYBACK_SPEED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "4", label: "4x" },
];

const PRESET_OPTIONS: Array<{ value: OperatorPreset; label: string }> = [
  { value: "trailblazer", label: "Trailblazer" },
  { value: "strategist", label: "Strategist" },
  { value: "nightwatch", label: "Nightwatch" },
];

const PRESET_DETAILS: Record<OperatorPreset, {
  title: string;
  description: string;
  bestFor: string;
  swatchClass: string;
}> = {
  trailblazer: {
    title: "Trailblazer",
    description: "Warm palette with assertive leadership presence.",
    bestFor: "Best for high-tempo build and delivery sessions.",
    swatchClass: "preset-trailblazer",
  },
  strategist: {
    title: "Strategist",
    description: "Balanced palette with measured planning posture.",
    bestFor: "Best for architecture, sequencing, and roadmap sessions.",
    swatchClass: "preset-strategist",
  },
  nightwatch: {
    title: "Nightwatch",
    description: "Cool palette with observant command-center vibe.",
    bestFor: "Best for monitoring, triage, and long-running operations.",
    swatchClass: "preset-nightwatch",
  },
};

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
  const [selectedEntityId, setSelectedEntityId] = useState<SelectedEntityId>("operator");
  const [operatorPrefs, setOperatorPrefs] = useState<OperatorPreferences>(() => readOperatorPreferences(
    variantConfig.storageKey,
    variantConfig.defaultPrefs,
  ));
  const [assetPack, setAssetPack] = useState<OfficeAssetPack>({});
  const [dockTab, setDockTab] = useState<OfficeDockTab>(variantConfig.initialDockTab);
  const [focusedZoneOverride, setFocusedZoneOverride] = useState<OfficeZoneId | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>({
    mode: "live",
    playing: false,
    speed: 2,
  });
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
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
  const playbackCursorTime = playback.mode === "replay"
    ? playback.cursorTime ?? replayWindow.startTime
    : undefined;
  const sceneEvents = useMemo(() => {
    if (playback.mode !== "replay") {
      return sortedEvents;
    }
    return sortedEvents.filter((event) => {
      const timestamp = parseTimestamp(event.timestamp);
      return timestamp >= replayWindow.startTime && timestamp <= (playbackCursorTime ?? replayWindow.startTime);
    });
  }, [playback.mode, playbackCursorTime, replayWindow.startTime, sortedEvents]);
  const officeAgents = useMemo(() => deriveOfficeAgents(directory, sceneEvents), [directory, sceneEvents]);
  const officeAgentNamesByRole = useMemo(
    () => new Map(officeAgents.map((agent) => [agent.roleId, agent.name])),
    [officeAgents],
  );
  const collaborationEdges = useMemo(() => deriveCollaborationEdges(officeAgents), [officeAgents]);
  const zoneActivityLanes = useMemo(
    () => deriveZoneActivityLanes(officeAgents),
    [officeAgents],
  );
  const zoneTelemetry = useMemo(
    () => deriveZoneTelemetry(officeAgents, zoneActivityLanes),
    [officeAgents, zoneActivityLanes],
  );
  const signalRoutes = useMemo(
    () => deriveSignalRoutes(officeAgents),
    [officeAgents],
  );
  const selectedAgent = useMemo(
    () => officeAgents.find((agent) => agent.roleId === selectedEntityId),
    [officeAgents, selectedEntityId],
  );
  const selectionZoneId = useMemo<OfficeZoneId>(
    () => selectedEntityId === "operator" ? "command" : selectedAgent?.zoneId ?? "command",
    [selectedAgent?.zoneId, selectedEntityId],
  );
  const selectedZoneId = useMemo<OfficeZoneId>(
    () => operatorPrefs.focusMode ? focusedZoneOverride ?? selectionZoneId : selectionZoneId,
    [focusedZoneOverride, operatorPrefs.focusMode, selectionZoneId],
  );
  const selectedZoneTelemetry = useMemo(
    () => zoneTelemetry.find((zone) => zone.zoneId === selectedZoneId) ?? null,
    [selectedZoneId, zoneTelemetry],
  );
  const stageZoneTelemetry = useMemo(
    () => operatorPrefs.focusMode ? zoneTelemetry.filter((zone) => zone.zoneId === selectedZoneId) : zoneTelemetry,
    [operatorPrefs.focusMode, selectedZoneId, zoneTelemetry],
  );
  const selectedAgentHandoffs = useMemo(
    () => selectedAgent ? buildAgentHandoffs(selectedAgent, officeAgentNamesByRole) : [],
    [officeAgentNamesByRole, selectedAgent],
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
      detail: selectedAgent?.behaviorDirective ?? selectedAgent?.currentAction ?? selectedZoneTelemetry?.focus ?? "Selected desk is in focus.",
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

  const focusZone = useCallback((zoneId: OfficeZoneId) => {
    setFocusedZoneOverride(zoneId);
    if (zoneId === "command") {
      setSelectedEntityId("operator");
      return;
    }
    const preferredAgent = officeAgents.find((agent) => agent.zoneId === zoneId && agent.attentionLevel === "priority")
      ?? officeAgents.find((agent) => agent.zoneId === zoneId && agent.attentionLevel === "watch")
      ?? officeAgents.find((agent) => agent.zoneId === zoneId);
    if (preferredAgent) {
      setSelectedEntityId(preferredAgent.roleId);
    }
  }, [officeAgents]);

  useEffect(() => {
    if (!operatorPrefs.focusMode) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable)) {
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

  const activeAgents = useMemo(
    () => officeAgents.filter((agent) => agent.status === "active").length,
    [officeAgents],
  );
  const readyAgents = useMemo(
    () => officeAgents.filter((agent) => agent.status === "ready").length,
    [officeAgents],
  );
  const eventFlow = useMemo(() => {
    const anchorTime = playback.mode === "replay"
      ? playbackCursorTime ?? replayWindow.startTime
      : Date.now();
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
    if (activeAgents >= 3 || pendingApprovals.length > 0 || eventFlow >= 2.2) {
      return "command_center";
    }
    return "idle_patrol";
  }, [activeAgents, eventFlow, pendingApprovals.length]);

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
    () => !operatorPrefs.quietMode && (blockedAgents > 0 || priorityAgents > 0 || activeAgents >= 4 || eventFlow >= 2.5),
    [activeAgents, blockedAgents, eventFlow, operatorPrefs.quietMode, priorityAgents],
  );
  const goatAssetStatus = useMemo(() => describeGoatAssetStatus(assetPack), [assetPack]);
  const sceneResetKey = useMemo(
    () => [
      effectiveMotionMode,
      assetPack.goatModelPath ?? "procedural",
      assetPack.goatModelVariant ?? "procedural",
    ].join("::"),
    [assetPack.goatModelPath, assetPack.goatModelVariant, effectiveMotionMode],
  );

  const operatorModel: OfficeOperatorModel = useMemo(() => ({
    operatorId: "operator",
    name: operatorPrefs.name,
    preset: operatorPrefs.preset,
    currentThought: buildOperatorThought({
      activeAgents,
      blockedAgents,
      pendingApprovals: pendingApprovals.length,
      eventFlow,
    }),
    activityState: operatorActivityState,
  }), [
    activeAgents,
    blockedAgents,
    eventFlow,
    operatorActivityState,
    operatorPrefs.name,
    operatorPrefs.preset,
    pendingApprovals.length,
  ]);

  useEffect(() => {
    return scheduleSceneActivation(() => setSceneReady(true));
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
  const presetDetail = PRESET_DETAILS[operatorPrefs.preset];
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

  const handleEntitySelect = (entityId: SelectedEntityId) => {
    const nextZoneId = entityId === "operator"
      ? "command"
      : officeAgents.find((agent) => agent.roleId === entityId)?.zoneId ?? "command";
    setSelectedEntityId(entityId);
    if (operatorPrefs.focusMode) {
      setFocusedZoneOverride(nextZoneId);
    }
    if (operatorPrefs.showInspectorDock) {
      setDockTab("inspector");
    }
  };

  const handlePlaybackModeChange = useCallback((mode: PlaybackState["mode"]) => {
    setPlayback((current) => ({
      ...current,
      mode,
      playing: mode === "replay" ? current.playing : false,
      cursorTime: mode === "replay" ? current.cursorTime ?? replayWindow.startTime : undefined,
    }));
  }, [replayWindow.startTime]);

  const renderInspectorPanel = () => {
    if (selectedEntityId === "operator") {
      return (
        <>
          <header className="office-agent-header">
            <div className="office-avatar office-avatar-hot">GH</div>
            <div>
              <h3>{operatorPrefs.name}</h3>
              <p className="office-agent-id">GoatHerder - Central Herd Operator - Command Hub</p>
            </div>
            <span className="office-pill office-pill-active">{operatorModel.activityState.replace("_", " ")}</span>
          </header>

          <p>Coordinates specialist goats, approvals, and live mission flow from the center desk.</p>
          <p><strong>Thinking:</strong> {operatorModel.currentThought}</p>

          <dl className="office-meta-grid">
            <div>
              <dt>Active goats</dt>
              <dd>{activeAgents}</dd>
            </div>
            <div>
              <dt>Pending approvals</dt>
              <dd>{pendingApprovals.length}</dd>
            </div>
            <div>
              <dt>Risked goats</dt>
              <dd>{blockedAgents}</dd>
            </div>
            <div>
              <dt>Event pace</dt>
              <dd>{eventFlow.toFixed(1)}/min</dd>
            </div>
            <div>
              <dt>Primary zone</dt>
              <dd>Command Hub</dd>
            </div>
          </dl>

          <h4>Zone Pressure</h4>
          <div className="office-zone-grid office-zone-grid-compact">
            {zoneTelemetry.map((zone) => (
              <article key={zone.zoneId} className={`office-zone-card office-zone-card-${zone.attentionLevel}`}>
                <div className="office-zone-card-head">
                  <p className="office-zone-card-label">{zone.label}</p>
                  <span className={`office-pill ${attentionPillClass(zone.attentionLevel)}`}>
                    {attentionLabel(zone.attentionLevel)}
                  </span>
                </div>
                <p className="office-zone-card-metrics">
                  {zone.activeAgents} active · {zone.linkedAgents} linked · {zone.alertAgents} alerts
                </p>
                <p className="office-zone-card-focus">{zone.focus}</p>
              </article>
            ))}
          </div>

          <h4>Goatherder Preset</h4>
          <div className="office-preset-active">
            <span className={`office-preset-swatch ${presetDetail.swatchClass}`} aria-hidden="true" />
            <div>
              <p className="office-preset-title">{presetDetail.title}</p>
              <p className="office-preset-copy">{presetDetail.description}</p>
              <p className="office-preset-bestfor">{presetDetail.bestFor}</p>
            </div>
          </div>

          <h4>Operator Customization</h4>
          <div className="controls-row">
            <label htmlFor="goatHerderName">Operator name</label>
            <SelectOrCustom
              id="goatHerderName"
              value={operatorPrefs.name}
              onChange={(name) => setOperatorPrefs((prev) => ({ ...prev, name: name || "GoatHerder" }))}
              options={OPERATOR_NAME_OPTIONS}
              customPlaceholder="Custom operator name"
              customLabel="Operator name"
            />
          </div>
          <FieldHelp>Use a preset name or switch to custom if you want the Goatherder identity to match the current mission theme.</FieldHelp>
          <div className="controls-row">
            <label htmlFor="goatHerderPreset">Style preset</label>
            <GCSelect
              id="goatHerderPreset"
              value={operatorPrefs.preset}
              onChange={(value) => setOperatorPrefs((prev) => ({
                ...prev,
                preset: value as OperatorPreset,
              }))}
              options={PRESET_OPTIONS}
            />
          </div>
          <FieldHelp>Presets adjust the Goatherder palette and scene mood without changing the underlying operator data.</FieldHelp>
          <div className="office-preset-grid">
            {(Object.entries(PRESET_DETAILS) as Array<[OperatorPreset, typeof PRESET_DETAILS[OperatorPreset]]>).map(([key, detail]) => (
              <article
                key={key}
                className={`office-preset-card ${operatorPrefs.preset === key ? "active" : ""}`}
              >
                <header>
                  <span className={`office-preset-swatch ${detail.swatchClass}`} aria-hidden="true" />
                  <strong>{detail.title}</strong>
                </header>
                <p>{detail.description}</p>
                <small>{detail.bestFor}</small>
              </article>
            ))}
          </div>
        </>
      );
    }

    if (!selectedAgent) {
      return <p>No goat selected.</p>;
    }

    return (
      <>
        <header className="office-agent-header">
          <div className={`office-avatar office-avatar-${classifyAgentHeat(selectedAgent.lastSeenAt)}`}>
            {initials(selectedAgent.name)}
          </div>
          <div>
            <h3>{selectedAgent.name}</h3>
            <p className="office-agent-id">{selectedAgent.title} - {selectedAgent.zoneLabel}</p>
          </div>
          <div className="office-agent-pills">
            <span className={`office-pill office-pill-${selectedAgent.status === "ready" ? "idle" : selectedAgent.status}`}>
              {selectedAgent.status}
            </span>
            <span className={`office-pill ${attentionPillClass(selectedAgent.attentionLevel)}`}>
              {attentionLabel(selectedAgent.attentionLevel)}
            </span>
          </div>
        </header>

        <div className="office-dossier-strip">
          <article className={`office-dossier-card office-dossier-card-${selectedAgent.attentionLevel}`}>
            <p className="office-dossier-label">Current task</p>
            <p className="office-dossier-value">{selectedAgent.currentTaskLabel}</p>
            <p className="office-dossier-note">{selectedAgent.currentAction}</p>
          </article>
          <article className={`office-dossier-card office-dossier-card-${selectedAgent.risk === "none" ? "stable" : selectedAgent.risk}`}>
            <p className="office-dossier-label">Risk state</p>
            <p className="office-dossier-value">{selectedAgent.risk}</p>
            <p className="office-dossier-note">{selectedAgent.currentThought}</p>
          </article>
          <article className="office-dossier-card office-dossier-card-stable">
            <p className="office-dossier-label">Recent handoffs</p>
            <p className="office-dossier-value">{selectedAgentHandoffs.length}</p>
            <p className="office-dossier-note">
              {selectedAgentHandoffs[0]?.detail ?? "No handoffs recorded yet."}
            </p>
          </article>
        </div>

        <div className={`office-behavior-banner office-behavior-banner-${selectedAgent.attentionLevel}`}>
          <p className="office-behavior-label">Behavior directive</p>
          <p>{selectedAgent.behaviorDirective}</p>
        </div>

        <dl className="office-meta-grid">
          <div>
            <dt>Risk</dt>
            <dd>{selectedAgent.risk}</dd>
          </div>
          <div>
            <dt>Task</dt>
            <dd>{selectedAgent.taskId ?? "-"}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{selectedAgent.sessionId ?? selectedAgent.runtimeAgentId ?? "-"}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{selectedAgent.activityState.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Attention</dt>
            <dd>{attentionLabel(selectedAgent.attentionLevel)}</dd>
          </div>
          <div>
            <dt>Zone</dt>
            <dd>{selectedAgent.zoneLabel}</dd>
          </div>
          <div>
            <dt>Collaborators</dt>
            <dd>
              {selectedAgent.collabPeers.length > 0
                ? selectedAgent.collabPeers.map((roleId) => officeAgentNamesByRole.get(roleId) ?? roleId).join(", ")
                : "-"}
            </dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatRelative(selectedAgent.lastSeenAt)}</dd>
          </div>
          <div>
            <dt>Signal heat</dt>
            <dd>{classifyAgentHeat(selectedAgent.lastSeenAt)}</dd>
          </div>
        </dl>

        <h4>Specialties</h4>
        <div className="token-row">
          {selectedAgent.specialties.map((specialty) => (
            <span key={specialty} className="token-chip">{specialty}</span>
          ))}
        </div>

        <h4>Recent handoffs</h4>
        <ul className="compact-list">
          {selectedAgentHandoffs.length === 0 ? <li>No handoffs recorded.</li> : selectedAgentHandoffs.map((handoff, index) => (
            <li key={`${handoff.label}-${index}`}>
              <strong>{handoff.label}</strong>
              <p>{handoff.detail}</p>
              <small>{handoff.timestamp ? formatClock(handoff.timestamp) : "current window"}</small>
            </li>
          ))}
        </ul>

        <h4>Recent Signals</h4>
        <ul className="compact-list">
          {selectedAgent.eventTrail.length === 0 ? <li>No events yet.</li> : selectedAgent.eventTrail.slice(0, 8).map((event) => (
            <li key={event.eventId}>
              <strong>{event.eventType}</strong>
              <p>{summarizeEvent(event)}</p>
              <small>{formatClock(event.timestamp)} - {event.source}</small>
            </li>
          ))}
        </ul>
      </>
    );
  };

  if (loading) {
    return (
      <section className="office-v5">
        <PageHeader eyebrow={variantConfig.eyebrow} title={officeCopy.title} subtitle={officeCopy.subtitle} className="page-header-citadel" />
        <CardSkeleton lines={10} />
      </section>
    );
  }

  return (
    <section className={`office-v5 ${operatorPrefs.focusMode ? "office-focus-mode" : ""}`}>
      <PageHeader
        eyebrow={variantConfig.eyebrow}
        title={officeCopy.title}
        subtitle={officeCopy.subtitle}
        hint={variantConfig.headerHint}
        className="page-header-citadel"
        actions={(
          <div className="office-page-actions">
            <div className="office-surface-switch" role="tablist" aria-label="Office surface views">
              <button type="button" className="active" aria-pressed="true">
                Immersive
              </button>
              <button type="button" onClick={onOpenLab} aria-pressed="false">
                Pixel Lab
              </button>
            </div>
            <StatusChip tone={streamHealthy ? "live" : "warning"}>
              Stream {streamHealthy ? "live" : "resyncing"}
            </StatusChip>
            <StatusChip tone={pendingApprovals.length > 0 ? "warning" : "muted"}>
              {pendingApprovals.length} approvals
            </StatusChip>
            <StatusChip tone={blockedAgents > 0 ? "critical" : "success"}>
              {blockedAgents} blocked
            </StatusChip>
            <StatusChip tone={priorityAgents > 0 ? "critical" : watchAgents > 0 ? "warning" : "success"}>
              {priorityAgents} priority · {watchAgents} watch
            </StatusChip>
          </div>
        )}
      />
      <PageGuideCard
        pageId="office"
        what={officeGuide.what}
        when={officeGuide.when}
        actions={officeGuide.actions}
        terms={officeGuide.terms}
      />
      {error ? (
        <div className="office-stream-banner">
          <strong>Command feed degraded.</strong>
          <span>The office shell stays interactive while GoatCitadel reconnects. {error}</span>
        </div>
      ) : null}

      <div className="office-kpi-grid">
        <article className="office-kpi-card">
          <p className="office-kpi-label">Goats in motion</p>
          <p className="office-kpi-value">{activeAgents}</p>
          <p className="office-kpi-note">Actively executing work</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Hot hooves</p>
          <p className="office-kpi-value">{hotAgents}</p>
          <p className="office-kpi-note">Updated in last 2 minutes</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Ready reserves</p>
          <p className="office-kpi-value">{readyAgents}</p>
          <p className="office-kpi-note">Ready for assignment</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Event pace</p>
          <p className="office-kpi-value">{eventFlow.toFixed(1)}/min</p>
          <p className="office-kpi-note">{pendingApprovals.length} approvals pending · stream {streamHealthy ? "live" : "syncing"}</p>
        </article>
      </div>

      <div className={`office-v5-workspace${operatorPrefs.showInspectorDock || operatorPrefs.showRailDock ? "" : " office-v5-workspace-single"}`}>
        <Panel
          className={`office-stage-panel${operatorPrefs.focusMode ? " office-stage-panel-focus" : ""}`}
          padding="spacious"
          title="Immersive Command Stage"
          subtitle="Drag to orbit, click the Goatherder or any desk, and watch live collaboration flow."
          actions={(
            <div className="office-stage-statuses">
              <StatusChip tone={sceneReady ? "success" : "muted"}>{sceneReady ? "Scene ready" : "Scene warming up"}</StatusChip>
              <StatusChip tone={operatorPrefs.showCollabOverlay ? "live" : "muted"}>
                {operatorPrefs.showCollabOverlay ? "Flow visible" : "Flow hidden"}
              </StatusChip>
              <StatusChip tone={blockedAgents > 0 ? "critical" : "success"}>
                {blockedAgents} alerts
              </StatusChip>
              <StatusChip tone={priorityAgents > 0 ? "critical" : watchAgents > 0 ? "warning" : "muted"}>
                {priorityAgents > 0 ? "Priority desks active" : watchAgents > 0 ? "Watch desks active" : "Desk pressure stable"}
              </StatusChip>
              <StatusChip tone={playback.mode === "replay" ? "warning" : "muted"}>
                {playback.mode === "replay" ? "Replay window" : "Live window"}
              </StatusChip>
              <StatusChip tone={goatAssetStatus.tone}>{goatAssetStatus.chipLabel}</StatusChip>
            </div>
          )}
        >
          {focusSummary ? (
            <div className="office-focus-banner">
              <p className="office-focus-label">Focus mode</p>
              <p className="office-focus-title">{focusSummary.title}</p>
              <p className="office-focus-summary">{focusSummary.summary}</p>
              <p className="office-focus-detail">{focusSummary.detail}</p>
              <p className="office-focus-hotkeys">Hotkeys: 1-5 jump zones, [ and ] cycle decks.</p>
            </div>
          ) : null}

          <div className="office-playback-bar">
            <div className="office-playback-head">
              <div>
                <p className="office-playback-label">Activity playback</p>
                <p className="office-playback-copy">
                  Rewind the last five minutes to watch traffic, approvals, and handoffs condense into a faster operations replay.
                </p>
              </div>
              <div className="office-playback-actions">
                <button
                  type="button"
                  className={playback.mode === "live" ? "active" : ""}
                  onClick={() => handlePlaybackModeChange("live")}
                >
                  Live
                </button>
                <button
                  type="button"
                  className={playback.mode === "replay" ? "active" : ""}
                  onClick={() => handlePlaybackModeChange("replay")}
                  disabled={replayWindow.replayableEvents.length === 0}
                >
                  Replay 5m
                </button>
                <button
                  type="button"
                  disabled={playback.mode !== "replay" || replayWindow.replayableEvents.length === 0}
                  onClick={() => setPlayback((current) => ({
                    ...current,
                    playing: current.mode === "replay" ? !current.playing : false,
                    cursorTime: current.mode === "replay" ? current.cursorTime ?? replayWindow.startTime : current.cursorTime,
                  }))}
                >
                  {playback.playing ? "Pause" : "Play"}
                </button>
              </div>
            </div>
            <div className="office-playback-controls">
              <label htmlFor="officePlaybackCursor">Replay cursor</label>
              <input
                id="officePlaybackCursor"
                type="range"
                min={0}
                max={100}
                value={playback.mode === "replay" && replayWindow.endTime > replayWindow.startTime
                  ? Math.round((((playbackCursorTime ?? replayWindow.startTime) - replayWindow.startTime) / (replayWindow.endTime - replayWindow.startTime)) * 100)
                  : 100}
                disabled={playback.mode !== "replay" || replayWindow.replayableEvents.length === 0}
                onChange={(event) => {
                  const ratio = Number.parseFloat(event.target.value) / 100;
                  const nextCursor = replayWindow.startTime + ((replayWindow.endTime - replayWindow.startTime) * ratio);
                  setPlayback((current) => ({
                    ...current,
                    cursorTime: nextCursor,
                    playing: false,
                  }));
                }}
              />
              <GCSelect
                id="officePlaybackSpeed"
                value={String(playback.speed)}
                onChange={(value) => setPlayback((current) => ({
                  ...current,
                  speed: Number.parseInt(value, 10) as PlaybackState["speed"],
                }))}
                options={PLAYBACK_SPEED_OPTIONS}
                disabled={playback.mode !== "replay"}
              />
            </div>
          </div>

          <div className="office-stage-toolbar">
            <div className="office-stage-toolbar-group office-stage-toolbar-motion">
              <label htmlFor="officeMotionMode">Motion</label>
              <GCSelect
                id="officeMotionMode"
                value={effectiveMotionMode}
                disabled={prefersReducedMotion}
                onChange={(value) => setOperatorPrefs((prev) => ({
                  ...prev,
                  motionMode: value as OfficeMotionMode,
                }))}
                options={MOTION_MODE_OPTIONS}
              />
              <FieldHelp>
                Use reduced or subtle motion for longer monitoring sessions. Reduced-motion system settings take priority.
              </FieldHelp>
            </div>
            <div className="office-stage-toolbar-group office-stage-toolbar-toggles">
              <div className="office-toggle-row">
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.showCollabOverlay}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      showCollabOverlay: event.target.checked,
                    }))}
                  />
                  Collaboration Flow
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.idleMillingEnabled}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      idleMillingEnabled: event.target.checked,
                    }))}
                  />
                  Idle Milling
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.showInspectorDock}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      showInspectorDock: event.target.checked,
                    }))}
                  />
                  Show Inspector
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.showRailDock}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      showRailDock: event.target.checked,
                    }))}
                  />
                  Show Rail
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.focusMode}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      focusMode: event.target.checked,
                    }))}
                  />
                  Focus Mode
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.quietMode}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      quietMode: event.target.checked,
                    }))}
                  />
                  Quiet Office
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={operatorPrefs.followSelection}
                    onChange={(event) => setOperatorPrefs((prev) => ({
                      ...prev,
                      followSelection: event.target.checked,
                    }))}
                  />
                  Follow Selected
                </label>
              </div>
              <FieldHelp>
                Focus mode narrows the stage, Quiet Office strips ambient churn, and Follow Selected turns the camera into a tighter operator lens.
              </FieldHelp>
            </div>
          </div>

          <div className="office-lane-grid">
            {zoneActivityLanes.length === 0 ? (
              <article className="office-lane-card office-lane-card-empty">
                <p className="office-lane-label">Activity lanes</p>
                <p className="office-lane-copy">No cross-zone traffic has surfaced yet in the current window.</p>
              </article>
            ) : zoneActivityLanes.map((lane) => (
              <article
                key={`${lane.fromZoneId}-${lane.toZoneId}`}
                className={`office-lane-card${lane.risk ? " office-lane-card-risk" : ""}`}
              >
                <p className="office-lane-label">{`${lane.fromLabel} -> ${lane.toLabel}`}</p>
                <p className="office-lane-value">{lane.count} linked handoffs</p>
                <p className="office-lane-copy">{lane.label}</p>
              </article>
            ))}
          </div>

          <div className={`office-zone-grid${operatorPrefs.focusMode ? " office-zone-grid-focus" : ""}`}>
            {stageZoneTelemetry.map((zone) => {
              const isSelectedZone = selectedEntityId === "operator"
                ? zone.zoneId === "command"
                : selectedAgent?.zoneId === zone.zoneId;
              return (
                <article
                  key={zone.zoneId}
                  className={`office-zone-card office-zone-card-${zone.attentionLevel} office-zone-card-theme-${zone.zoneId}${isSelectedZone ? " active" : ""}`}
                >
                  <div className="office-zone-card-head">
                    <p className="office-zone-card-label">{zone.label}</p>
                    <span className={`office-pill ${attentionPillClass(zone.attentionLevel)}`}>
                      {attentionLabel(zone.attentionLevel)}
                    </span>
                  </div>
                  <p className="office-zone-card-metrics">
                    {zone.totalAgents} goats · {zone.activeAgents} active · {zone.linkedAgents} linked · load {Math.round(zone.workloadScore * 100)}%
                  </p>
                  <p className="office-zone-card-focus">{zone.focus}</p>
                  <p className="office-zone-card-architecture">{zone.landmark} · {zone.architectureNote}</p>
                </article>
              );
            })}
          </div>

          <OfficeCanvasErrorBoundary resetKey={sceneResetKey}>
            {sceneReady ? (
              <Suspense
                fallback={(
                  <div className="office-webgl-stage office-webgl-stage-v5 office-stage-loading">
                    <p>Loading office scene...</p>
                  </div>
                )}
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
          <FieldHelp className="office-stage-help">
            Click the Goatherder or any desk to inspect the operator, desk zone, recent signals, collaboration edges, and alert state without leaving the scene.
          </FieldHelp>
          <FieldHelp className="office-stage-help">
            Goat asset pipeline: {goatAssetStatus.helpLabel}.
            {goatAssetStatus.helpCopy}
          </FieldHelp>
          {officeAgents.length === 0 ? (
            <div className="gc-empty-state office-empty-state">
              <p className="gc-empty-title">No agent roles are available yet.</p>
              <p className="gc-empty-subtitle">The Goatherder and office shell stay visible so you can inspect the room even before the herd is configured.</p>
            </div>
          ) : null}
          <div className="office-desk-list">
            <button type="button"
              className={selectedEntityId === "operator" ? "active" : ""}
              onClick={() => handleEntitySelect("operator")}
            >
              {operatorPrefs.name}
            </button>
            {officeAgents.map((agent) => (
              <button type="button"
                key={agent.roleId}
                className={selectedEntityId === agent.roleId ? "active" : ""}
                onClick={() => handleEntitySelect(agent.roleId)}
              >
                {agent.name}
              </button>
            ))}
          </div>
        </Panel>

        {(operatorPrefs.showInspectorDock || operatorPrefs.showRailDock) ? (
          <Panel
            className="office-dock-panel"
            padding="default"
            title="Operations Dock"
            subtitle="Keep inspection, approvals, operators, and live signals beside the command stage."
            actions={(
              <div className="office-dock-tabs">
                {availableDockTabs.map((tab) => (
                  <button type="button"
                    key={tab}
                    className={dockTab === tab ? "active" : ""}
                    onClick={() => setDockTab(tab)}
                  >
                    {tab === "inspector" && "Inspector"}
                    {tab === "operators" && "Operators"}
                    {tab === "approvals" && "Approvals"}
                    {tab === "rail" && "Live Rail"}
                  </button>
                ))}
              </div>
            )}
          >
            <div className="office-dock-body">
              {dockTab === "inspector" ? renderInspectorPanel() : null}

              {dockTab === "operators" ? (
                <>
                  <FieldHelp>Operator view summarizes session pressure and who has been active most recently.</FieldHelp>
                  <ul className="compact-list">
                    {operators.map((operator) => (
                      <li key={operator.operatorId}>
                        <strong>{operator.operatorId}</strong>
                        <p>{operator.activeSessions} active / {operator.sessionCount} total sessions</p>
                        <small>Last activity {formatRelative(operator.lastActivityAt)}</small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {dockTab === "approvals" ? (
                <>
                  <FieldHelp>Pending approvals surface the highest-friction work still waiting on human review.</FieldHelp>
                  <ul className="compact-list">
                    {pendingApprovals.length === 0 ? <li>No pending approvals.</li> : pendingApprovals.slice(0, 10).map((approval) => (
                      <li key={approval.approvalId}>
                        <strong>{approval.kind}</strong>
                        <p>{approval.riskLevel} - {approval.status}</p>
                        <small>{formatRelative(approval.createdAt)}</small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {dockTab === "rail" ? (
                <>
                  <FieldHelp>Live rail is the real-time signal feed. Use it to correlate motion in the scene with gateway and tool activity.</FieldHelp>
                  <ul className="compact-list">
                    {sceneEvents.length === 0 ? <li>No live events yet.</li> : sceneEvents.slice(0, 12).map((event) => (
                      <li key={event.eventId}>
                        <strong>{event.eventType}</strong>
                        <p>{summarizeEvent(event)}</p>
                        <small>{formatClock(event.timestamp)} - {event.source}</small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>

            <footer className="office-collab-legend">
              <span><b>Beam</b> active collaboration</span>
              <span><b>Pulse</b> handoff in progress</span>
              <span><b>Red hold</b> blocked or approval risk</span>
              <span><b>Zone deck</b> command, build, research, security, or ops lane</span>
            </footer>
          </Panel>
        ) : (
          <Panel className="office-dock-panel" tone="soft" title="Operations Dock Hidden" subtitle="The scene is still live, but the side dock is disabled right now.">
            <FieldHelp>Enable either Inspector or Rail above to restore the side dock and keep entity detail beside the scene.</FieldHelp>
          </Panel>
        )}
      </div>
    </section>
  );
}

function deriveOfficeAgents(
  directory: AgentDirectoryRecord[],
  events: RealtimeEvent[],
): OfficeAgentModel[] {
  const byRole = new Map<string, OfficeAgentModel>();
  const runtimeLookup = new Map<string, string>();

  for (const agent of directory) {
    const zoneId = inferOfficeZone(agent);
    byRole.set(agent.roleId, {
      ...agent,
      currentAction: agent.status === "active"
        ? "Pushing current assignment forward."
        : agent.status === "idle"
          ? "Idle with warm context."
          : "Waiting for first assignment.",
      currentThought: agent.status === "ready"
        ? "Standing by for orders from GoatHerder."
        : "Monitoring the event rail.",
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
    const shouldRefresh = !existing.lastSeenAt || parseTimestamp(event.timestamp) >= parseTimestamp(existing.lastSeenAt);
    const nextEventTrail = existing.eventTrail.length < 12
      ? [...existing.eventTrail, event]
      : existing.eventTrail;

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
      activityState = ageMs <= ACTIVITY_TRANSITION_WINDOW_MS
        ? "transitioning_to_desk"
        : "working_seated";
    } else {
      activityState = "idle_milling";
    }

    if (
      activityState !== "alert_response"
      && peers.length > 0
      && (agent.status === "active" || agent.risk !== "none")
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
      const recencyBoost = classifyAgentHeat(agent.lastSeenAt) === "hot" || classifyAgentHeat(peer.lastSeenAt) === "hot"
        ? 0.7
        : classifyAgentHeat(agent.lastSeenAt) === "warm" || classifyAgentHeat(peer.lastSeenAt) === "warm"
          ? 0.35
          : 0.1;
      const sharedContextBoost = agent.taskId && peer.taskId && agent.taskId === peer.taskId
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

  return [...edgeMap.values()].sort((left, right) => {
    if (left.risk !== right.risk) {
      return left.risk ? -1 : 1;
    }
    return right.strength - left.strength;
  }).slice(0, MAX_VISIBLE_COLLAB_EDGES);
}

function resolveEventRoleId(
  event: RealtimeEvent,
  runtimeLookup: Map<string, string>,
): string | undefined {
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

function summarizeEvent(event: RealtimeEvent): string {
  const payload = asRecord(event.payload);
  if (event.eventType === "tool_invoked") {
    const toolName = asString(payload.toolName) ?? "tool";
    const outcome = asString(payload.outcome) ?? "executed";
    return `${toolName} -> ${outcome}`;
  }
  if (event.eventType === "approval_created") {
    const kind = asString(payload.kind) ?? "approval";
    const riskLevel = asString(payload.riskLevel) ?? "unknown";
    return `${kind} (${riskLevel})`;
  }
  if (event.eventType === "activity_logged") {
    const activity = asRecord(payload.activity);
    return truncate(asString(activity.message) ?? "task activity", 80);
  }
  if (event.eventType === "task_updated" || event.eventType === "task_created") {
    const task = asRecord(payload.task);
    const title = asString(task.title) ?? asString(task.taskId) ?? "task";
    return truncate(title, 80);
  }
  return truncate(JSON.stringify(payload), 80);
}

function extractTaskId(event: RealtimeEvent): string | undefined {
  const payload = asRecord(event.payload);
  const taskId = asString(payload.taskId);
  if (taskId) {
    return taskId;
  }
  const task = asRecord(payload.task);
  return asString(task.taskId);
}

function extractSessionId(event: RealtimeEvent): string | undefined {
  const payload = asRecord(event.payload);
  const sessionId = asString(payload.sessionId);
  if (sessionId) {
    return sessionId;
  }
  const session = asRecord(payload.session);
  return asString(session.agentSessionId);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimestamp(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortEvents(events: RealtimeEvent[]): RealtimeEvent[] {
  return [...events].sort((left, right) => parseTimestamp(right.timestamp) - parseTimestamp(left.timestamp));
}

function statusScore(status: AgentDirectoryRecord["status"]): number {
  if (status === "active") {
    return 3;
  }
  if (status === "idle") {
    return 2;
  }
  return 1;
}

function classifyAgentHeat(lastSeenAt?: string): "hot" | "warm" | "cold" {
  const timestamp = parseTimestamp(lastSeenAt);
  const age = Date.now() - timestamp;
  if (timestamp > 0 && age <= HOT_AGENT_WINDOW_MS) {
    return "hot";
  }
  if (timestamp > 0 && age <= WARM_AGENT_WINDOW_MS) {
    return "warm";
  }
  return "cold";
}

function formatClock(value?: string): string {
  const parsed = parseTimestamp(value);
  if (parsed <= 0) {
    return "-";
  }
  return new Date(parsed).toLocaleTimeString();
}

function formatRelative(value?: string): string {
  const timestamp = parseTimestamp(value);
  if (!timestamp) {
    return "-";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }
  if (diffSeconds < 24 * 3600) {
    return `${Math.floor(diffSeconds / 3600)}h ago`;
  }
  return `${Math.floor(diffSeconds / (24 * 3600))}d ago`;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "AG";
  }
  if (parts.length === 1) {
    return (parts[0] ?? "AG").slice(0, 2).toUpperCase();
  }
  const left = parts[0]?.[0] ?? "A";
  const right = parts[1]?.[0] ?? "G";
  return `${left}${right}`.toUpperCase();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function attentionLabel(attentionLevel: OfficeAttentionLevel): string {
  if (attentionLevel === "priority") {
    return "Priority";
  }
  if (attentionLevel === "watch") {
    return "Watch";
  }
  return "Stable";
}

function attentionPillClass(attentionLevel: OfficeAttentionLevel): string {
  if (attentionLevel === "priority") {
    return "office-pill-priority";
  }
  if (attentionLevel === "watch") {
    return "office-pill-watch";
  }
  return "office-pill-active";
}

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
      const kind: OfficeSignalRoute["kind"] = agent.risk === "approval"
        ? "approval"
        : agent.risk === "blocked"
          ? "blocked"
          : "error";
      return {
        roleId: agent.roleId,
        zoneId: agent.zoneId,
        kind,
        label: agent.risk === "approval"
          ? `${agent.name} needs review`
          : `${agent.name} is in escalation`,
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
    const workloadScore = totalAgents === 0
      ? 0
      : zoneAgents.reduce((sum, agent) => sum + agent.workloadScore, 0) / totalAgents;
    const hottestAgent = zoneAgents.find((agent) => agent.attentionLevel === "priority")
      ?? zoneAgents.find((agent) => agent.attentionLevel === "watch")
      ?? zoneAgents[0];
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
  const loadLabel = workloadScore >= 0.72 ? "running hot" : workloadScore >= 0.42 ? "holding live pressure" : "idling cool";
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

function buildOperatorThought(input: {
  activeAgents: number;
  blockedAgents: number;
  pendingApprovals: number;
  eventFlow: number;
}): string {
  if (input.blockedAgents > 0) {
    return `${input.blockedAgents} goats are blocked. Prioritize approvals and clear policy conflicts.`;
  }
  if (input.pendingApprovals > 0) {
    return `${input.pendingApprovals} approvals pending while ${input.activeAgents} goats stay in motion.`;
  }
  if (input.activeAgents === 0) {
    return "No goats are currently active. Ready to assign a fresh wave.";
  }
  return `${input.activeAgents} goats are running at ${input.eventFlow.toFixed(1)} events per minute.`;
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
    manifest = await response.json() as {
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

  const resolvedEntries = await Promise.all(idsToResolve.map(async (id) => {
    const model = includedModels.get(id);
    if (!model?.path) {
      return [id, undefined] as const;
    }
    const exists = await checkAssetExists(model.path);
    return [id, exists ? model : undefined] as const;
  }));

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

function readOperatorPreferences(storageKey: string, defaults: OperatorPreferences): OperatorPreferences {
  if (typeof window === "undefined") {
    return { ...defaults };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { ...defaults };
    }
    const parsed = JSON.parse(raw) as Partial<OperatorPreferences>;
    return {
      name: sanitizeName(parsed.name) || defaults.name,
      preset: isPreset(parsed.preset) ? parsed.preset : defaults.preset,
      layoutMode: "immersive",
      motionMode: isMotionMode(parsed.motionMode) ? parsed.motionMode : defaults.motionMode,
      showCollabOverlay: asBoolean(parsed.showCollabOverlay, defaults.showCollabOverlay),
      showInspectorDock: asBoolean(parsed.showInspectorDock, defaults.showInspectorDock),
      showRailDock: asBoolean(parsed.showRailDock, defaults.showRailDock),
      idleMillingEnabled: asBoolean(parsed.idleMillingEnabled, defaults.idleMillingEnabled),
      focusMode: asBoolean(parsed.focusMode, defaults.focusMode),
      quietMode: asBoolean(parsed.quietMode, defaults.quietMode),
      followSelection: asBoolean(parsed.followSelection, defaults.followSelection),
    };
  } catch {
    return { ...defaults };
  }
}

function persistOperatorPreferences(storageKey: string, value: OperatorPreferences, defaults: OperatorPreferences): void {
  if (typeof window === "undefined") {
    return;
  }
  const payload: OperatorPreferences = {
    name: sanitizeName(value.name) || defaults.name,
    preset: isPreset(value.preset) ? value.preset : defaults.preset,
    layoutMode: "immersive",
    motionMode: isMotionMode(value.motionMode) ? value.motionMode : defaults.motionMode,
    showCollabOverlay: value.showCollabOverlay,
    showInspectorDock: value.showInspectorDock,
    showRailDock: value.showRailDock,
    idleMillingEnabled: value.idleMillingEnabled,
    focusMode: value.focusMode,
    quietMode: value.quietMode,
    followSelection: value.followSelection,
  };
  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}

function sanitizeName(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().slice(0, 40);
  return trimmed || undefined;
}

function isPreset(value: unknown): value is OperatorPreset {
  return value === "trailblazer" || value === "strategist" || value === "nightwatch";
}

function isMotionMode(value: unknown): value is OfficeMotionMode {
  return value === "cinematic" || value === "balanced" || value === "subtle" || value === "reduced";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

