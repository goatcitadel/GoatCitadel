/* eslint-disable max-lines */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { CHAT_MODE_PRESETS } from "@goatcitadel/contracts";
import {
  consumeGatewayAccessBootstrapFromLocation,
  connectEventStream,
  fetchWorkspaces,
  getGatewayApiBaseUrl,
  preflightGatewayAccess,
  resolveApproval,
  resolveApprovalWithRemoteToken,
  type EventStreamConnectionState,
  type GatewayAccessPreflightResult,
  type GatewayStartupPhaseTiming,
  type RealtimeEvent,
} from "./api/shell-client";
import { fetchDashboardState, type DashboardStateResponse } from "./api/client";
import { DeviceAccessApprovalModal, type DeviceAccessApprovalPrompt } from "./components/DeviceAccessApprovalModal";
import { GCSelect } from "./components/ui";
import { GatewayAccessGate } from "./components/GatewayAccessGate";
import { NotificationStack, type NotificationItem, upsertNotificationItem } from "./components/NotificationStack";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { RemoteApprovalActionModal, type RemoteApprovalActionPrompt } from "./components/RemoteApprovalActionModal";
import { ShellPageFrame } from "./components/ShellPageFrame";
import { StatusChip } from "./components/StatusChip";
import { StatusStrip } from "./components/StatusStrip";
import { appCopy } from "./content/copy";
import {
  buildRouteSearch,
  DEFAULT_ROUTE,
  getPageLabel,
  isWorkSurface,
  normalizeResolvedRoute,
  PAGE_META,
  readRouteFromLocation,
  SPACE_META,
  SPACE_PAGES,
  type ActivityTab,
  type AgentsTab,
  type ArtifactsTab,
  type IntegrationsTab,
  type ResolvedRoute,
  type SettingsTab,
  type Space,
  type SpacePage,
  type WorkSurface,
} from "./content/page-registry";
import { emitRefresh, type RefreshTopic } from "./state/refresh-bus";
import { useUiPreferences } from "./state/ui-preferences";
import { resolveEffectiveEffectsMode } from "./state/effects-mode";
import { publishEventStreamStatus, resetEventStreamStatus } from "./state/event-stream-status-store";
import { deriveShellGatewayAccessState } from "./state/gateway-shell-state";
import { useRefreshSubscription } from "./hooks/useRefreshSubscription";
import {
  isDevDiagnosticsEnabled,
  recordClientDiagnostic,
  setDevDiagnosticsCurrentEffectsMode,
  setDevDiagnosticsCurrentRoute,
  setDevDiagnosticsGatewayReachable,
  setDevDiagnosticsStartupSummary,
  setDevDiagnosticsSseState,
} from "./state/dev-diagnostics-store";

function lazyPage(loader: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] as ComponentType<Record<string, never>> };
  });
}

const ActivityHubPage = lazyPage(() => import("./pages/ActivityHubPage"), "ActivityHubPage");
const AgentsHubPage = lazyPage(() => import("./pages/AgentsHubPage"), "AgentsHubPage");
const ApprovalsPage = lazyPage(() => import("./pages/ApprovalsPage"), "ApprovalsPage");
const ArtifactsPage = lazyPage(() => import("./pages/ArtifactsPage"), "ArtifactsPage");
const ChatPage = lazyPage(() => import("./pages/ChatPage"), "ChatPage");
const CommandPalette = lazyPage(() => import("./components/CommandPalette"), "CommandPalette");
const CostConsolePage = lazyPage(() => import("./pages/CostConsolePage"), "CostConsolePage");
const DevDiagnosticsPanel = lazyPage(() => import("./components/DevDiagnosticsPanel"), "DevDiagnosticsPanel");
const IntegrationsHubPage = lazyPage(() => import("./pages/IntegrationsHubPage"), "IntegrationsHubPage");
const PromptLabPage = lazyPage(() => import("./pages/PromptLabPage"), "PromptLabPage");
const SessionsPage = lazyPage(() => import("./pages/SessionsPage"), "SessionsPage");
const SettingsHubPage = lazyPage(() => import("./pages/SettingsHubPage"), "SettingsHubPage");
const SystemPage = lazyPage(() => import("./pages/SystemPage"), "SystemPage");
const TasksPage = lazyPage(() => import("./pages/TasksPage"), "TasksPage");
const ToolsPage = lazyPage(() => import("./pages/ToolsPage"), "ToolsPage");
const GATEWAY_ACCESS_AUTO_RETRY_MS = 300;
const OPERATE_STATUS_STALE_AFTER_MS = 45_000;

function getStartupMonotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function deriveShellApprovalCount(
  operateStatus: DashboardStateResponse | null,
  localPromptCount: number,
): number {
  const backendPendingApprovals = operateStatus?.pendingApprovals ?? 0;
  return Math.max(0, backendPendingApprovals + localPromptCount);
}

export function deriveOperateStatusFreshness(
  lastSuccessAt: number | null,
  lastError: string | null,
  now = Date.now(),
): { state: "live" | "stale"; note: string } {
  if (!lastSuccessAt) {
    return {
      state: "stale",
      note: lastError ? "Status refresh has not completed yet." : "Waiting for the first shell status refresh.",
    };
  }
  const ageMs = Math.max(0, now - lastSuccessAt);
  if (lastError || ageMs > OPERATE_STATUS_STALE_AFTER_MS) {
    return {
      state: "stale",
      note: lastError
        ? "Counts may be stale because the latest dashboard refresh failed."
        : "Counts may be stale because the dashboard has not refreshed recently.",
    };
  }
  return {
    state: "live",
    note: "Counts reflect the latest dashboard snapshot.",
  };
}

function PageLoadingFallback({ label }: { label: string }) {
  return (
    <section className="shell-page-loading" aria-live="polite">
      <div className="shell-page-loading-card">
        <p className="shell-page-loading-kicker">Loading module</p>
        <h3>{label}</h3>
      </div>
    </section>
  );
}

const refreshTopicRules: Array<{ topic: RefreshTopic; keywords: string[] }> = [
  {
    topic: "surface",
    keywords: [
      "dashboard",
      "surface",
      "operator",
      "summit",
      "cron",
      "memory",
      "settings",
      "system",
      "onboarding",
      "llm",
      "approval",
    ],
  },
  { topic: "quality", keywords: ["prompt_pack", "promptlab", "prompt_lab", "prompt-pack", "quality"] },
  {
    topic: "chat",
    keywords: [
      "chat",
      "message",
      "session",
      "delegate",
      "proactive",
      "learned_memory",
      "llm",
      "provider",
      "model",
      "onboarding",
      "settings",
    ],
  },
  { topic: "approvals", keywords: ["approval", "gatehouse"] },
  { topic: "tools", keywords: ["tool", "grant", "policy"] },
  { topic: "files", keywords: ["file", "artifact", "workspace"] },
  { topic: "memory", keywords: ["memory", "qmd", "context"] },
  { topic: "agents", keywords: ["agent", "goat", "herd"] },
  { topic: "skills", keywords: ["skill", "bankr"] },
  { topic: "mcp", keywords: ["mcp"] },
  { topic: "tasks", keywords: ["task", "trailboard"] },
  { topic: "improvement", keywords: ["improvement", "replay", "autotune", "self_improvement"] },
  { topic: "integrations", keywords: ["integration", "plugin", "connection"] },
  { topic: "npu", keywords: ["npu", "runtime", "sidecar", "model", "voice", "llm", "provider"] },
];

type GatewayAccessViewState =
  | GatewayAccessPreflightResult
  | {
      status: "checking";
      message: string;
      healthDetail?: string;
    };

export function deriveRefreshTopics(event: RealtimeEvent): RefreshTopic[] {
  if (event.payload.kind === "replay_gap") {
    return [...new Set(refreshTopicRules.map((rule) => rule.topic))];
  }
  const topics = new Set<RefreshTopic>();
  if (event.links?.approvalId) {
    topics.add("approvals");
    topics.add("surface");
  }
  if (event.links?.sessionId) {
    topics.add("chat");
  }
  if (event.links?.taskId) {
    topics.add("tasks");
    topics.add("surface");
  }
  if (event.source === "system") {
    topics.add("system");
    topics.add("surface");
  }
  const haystack = `${event.eventType} ${event.source}`.toLowerCase();

  for (const rule of refreshTopicRules) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      topics.add(rule.topic);
    }
  }

  return [...topics];
}

export function App() {
  const {
    mode: uiMode,
    setMode: setUiMode,
    density,
    setDensity,
    effectsMode,
    setEffectsMode,
    showTechnicalDetails,
    setShowTechnicalDetails,
    activeWorkspaceId,
    setActiveWorkspaceId,
  } = useUiPreferences();
  const [route, setRoute] = useState<ResolvedRoute>(() => readRouteFromLocation());
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [, setOnboardingComplete] = useState<boolean | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ workspaceId: string; name: string }>>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [deviceAccessPrompts, setDeviceAccessPrompts] = useState<DeviceAccessApprovalPrompt[]>([]);
  const [deviceAccessResolveBusy, setDeviceAccessResolveBusy] = useState(false);
  const [remoteApprovalPrompts, setRemoteApprovalPrompts] = useState<RemoteApprovalActionPrompt[]>([]);
  const [remoteApprovalResolveBusy, setRemoteApprovalResolveBusy] = useState(false);
  const [operateStatus, setOperateStatus] = useState<DashboardStateResponse | null>(null);
  const [operateStatusLastSuccessAt, setOperateStatusLastSuccessAt] = useState<number | null>(null);
  const [operateStatusLastError, setOperateStatusLastError] = useState<string | null>(null);
  const [compactShellNav, setCompactShellNav] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and access policy.",
  });
  const [gatewayAccessBusy, setGatewayAccessBusy] = useState(true);
  const [gatewayAccessRunId, setGatewayAccessRunId] = useState(0);
  const [gatewayAccessAutoRetryPending, setGatewayAccessAutoRetryPending] = useState(false);
  const gatewayAccessAutoRetryTimerRef = useRef<number | null>(null);
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const shellGatewayState = useMemo(
    () => deriveShellGatewayAccessState(gatewayAccess, streamState),
    [gatewayAccess, streamState],
  );

  const loadWorkspaceOptions = useCallback(async () => {
    try {
      const response = await fetchWorkspaces("all", 400);
      setWorkspaceOptions(
        response.items.map((item) => ({
          workspaceId: item.workspaceId,
          name: item.name,
        })),
      );
    } catch {
      setWorkspaceOptions([]);
    }
  }, []);

  const loadOperateStatus = useCallback(async () => {
    try {
      const next = await fetchDashboardState();
      setOperateStatus(next);
      setOperateStatusLastSuccessAt(Date.now());
      setOperateStatusLastError(null);
    } catch (error) {
      setOperateStatusLastError((error as Error).message);
    }
  }, []);

  const pushNotification = useCallback((tone: NotificationItem["tone"], message: string, groupKey?: string) => {
    setNotifications((current) =>
      upsertNotificationItem(current, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        tone,
        message,
        timestamp: Date.now(),
        groupKey,
      }),
    );
  }, []);

  const dismissDeviceAccessPrompt = useCallback((approvalId: string) => {
    setDeviceAccessPrompts((current) => current.filter((item) => item.approvalId !== approvalId));
  }, []);

  const dismissRemoteApprovalPrompt = useCallback((approvalId: string) => {
    setRemoteApprovalPrompts((current) => current.filter((item) => item.approvalId !== approvalId));
  }, []);

  const activeDeviceAccessPrompt = deviceAccessPrompts[0];
  const activeRemoteApprovalPrompt = remoteApprovalPrompts[0];
  const localApprovalPromptCount = deviceAccessPrompts.length + remoteApprovalPrompts.length;

  const navigate = useCallback((nextRoute: ResolvedRoute) => {
    setRoute(normalizeResolvedRoute(nextRoute));
  }, []);

  const handleSelectSpace = useCallback(
    (space: Space) => {
      const defaultRoute =
        space === "operate"
          ? { space, page: "surface" as const, surface: "chat" as const }
          : space === "observe"
            ? { space, page: "activity" as const, tab: "activity" as const }
            : { space, page: "settings" as const, tab: "general" as const };
      navigate(defaultRoute);
    },
    [navigate],
  );

  const handleSelectPage = useCallback(
    (page: SpacePage) => {
      if (page === "surface") {
        navigate({ space: "operate", page: "surface", surface: route.page === "surface" ? route.surface : "chat" });
        return;
      }
      const meta = PAGE_META[page];
      if (meta.space === "observe" && page === "activity") {
        navigate({ space: "observe", page, tab: "activity" });
        return;
      }
      if (meta.space === "observe" && page === "artifacts") {
        navigate({ space: "observe", page, tab: "memory" });
        return;
      }
      if (meta.space === "configure" && page === "settings") {
        navigate({ space: "configure", page, tab: route.page === "settings" ? route.tab : "general" });
        return;
      }
      if (meta.space === "configure" && page === "integrations") {
        navigate({ space: "configure", page, tab: route.page === "integrations" ? route.tab : "overview" });
        return;
      }
      if (meta.space === "configure" && page === "agents") {
        navigate({ space: "configure", page, tab: route.page === "agents" ? route.tab : "overview" });
        return;
      }
      navigate({ space: meta.space, page });
    },
    [navigate, route.page, route.surface, route.tab],
  );

  const handleSelectSurface = useCallback(
    (surface: WorkSurface) => {
      navigate({ space: "operate", page: "surface", surface });
    },
    [navigate],
  );

  const handleOnboardingCompleted = useCallback(() => {
    setOnboardingComplete(true);
    navigate(DEFAULT_ROUTE);
    void loadWorkspaceOptions();
  }, [loadWorkspaceOptions, navigate]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia("(max-width: 767px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setCompactShellNav(event.matches);
    };

    handleChange(media);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  const retryGatewayAccess = useCallback(() => {
    setGatewayAccessRunId((current) => current + 1);
  }, []);

  const handleResolveDeviceAccessPrompt = useCallback(
    async (decision: "approve" | "reject") => {
      if (!activeDeviceAccessPrompt) {
        return;
      }
      setDeviceAccessResolveBusy(true);
      try {
        await resolveApproval(activeDeviceAccessPrompt.approvalId, {
          decision,
          resolvedBy: buildMissionControlResolverId(),
          resolutionNote: decision === "approve" ? "Approved from Mission Control." : "Rejected from Mission Control.",
        });
        dismissDeviceAccessPrompt(activeDeviceAccessPrompt.approvalId);
        pushNotification(
          decision === "approve" ? "success" : "warning",
          `${activeDeviceAccessPrompt.deviceLabel} ${decision === "approve" ? "was approved" : "was rejected"}.`,
          `device-access:${activeDeviceAccessPrompt.approvalId}`,
        );
      } catch (error) {
        pushNotification(
          "error",
          (error as Error).message,
          `device-access-error:${activeDeviceAccessPrompt.approvalId}`,
        );
      } finally {
        setDeviceAccessResolveBusy(false);
      }
    },
    [activeDeviceAccessPrompt, dismissDeviceAccessPrompt, pushNotification],
  );

  const handleResolveRemoteApprovalPrompt = useCallback(
    async (decision: "approve" | "reject") => {
      if (!activeRemoteApprovalPrompt) {
        return;
      }
      setRemoteApprovalResolveBusy(true);
      try {
        await resolveApprovalWithRemoteToken(activeRemoteApprovalPrompt.token, decision);
        dismissRemoteApprovalPrompt(activeRemoteApprovalPrompt.approvalId);
        pushNotification(
          decision === "approve" ? "success" : "warning",
          `${activeRemoteApprovalPrompt.kind} ${decision === "approve" ? "was approved" : "was rejected"} from Mission Control.`,
          `remote-approval:${activeRemoteApprovalPrompt.approvalId}`,
        );
      } catch (error) {
        pushNotification(
          "error",
          (error as Error).message,
          `remote-approval-error:${activeRemoteApprovalPrompt.approvalId}`,
        );
      } finally {
        setRemoteApprovalResolveBusy(false);
      }
    },
    [activeRemoteApprovalPrompt, dismissRemoteApprovalPrompt, pushNotification],
  );

  useEffect(() => {
    let cancelled = false;
    const startupStartedAt = new Date().toISOString();
    const startupStartedMs = getStartupMonotonicNow();
    setGatewayAccessBusy(true);
    setDevDiagnosticsStartupSummary(undefined);
    setGatewayAccess({
      status: "checking",
      message: "Verifying gateway reachability and access policy.",
    });

    const bootstrap = consumeGatewayAccessBootstrapFromLocation();
    void preflightGatewayAccess({ bootstrap })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setGatewayAccess(result);
        const phases: GatewayStartupPhaseTiming[] = [...(result.startupTiming?.phases ?? [])];
        if (result.status === "ready") {
          phases.push({
            key: "shell",
            label: "Shell ready",
            status: "success",
            startedAt: startupStartedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Math.max(0, Math.round(getStartupMonotonicNow() - startupStartedMs)),
            detail: "Mission Control rendered the primary shell after the startup probe completed.",
          });
        }
        setDevDiagnosticsStartupSummary({
          startedAt: result.startupTiming?.startedAt ?? startupStartedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Math.round(getStartupMonotonicNow() - startupStartedMs)),
          outcome: result.status,
          phases,
        });
        recordClientDiagnostic({
          level: result.status === "ready" ? "info" : "warn",
          category: "startup",
          event: `startup.complete.${result.status}`,
          message: `Startup completed with outcome ${result.status}.`,
          context: {
            durationMs: Math.max(0, Math.round(getStartupMonotonicNow() - startupStartedMs)),
            phases,
          },
        });
        if (result.status !== "ready") {
          setStreamState("closed");
          setOnboardingComplete(null);
          setWorkspaceOptions([]);
          return;
        }
        setOnboardingComplete(result.onboardingState?.completed ?? null);
        if (!result.onboardingState?.completed) {
          setRoute((current) => {
            if (current.space === "operate" && current.page === "surface") {
              return normalizeResolvedRoute({ space: "configure", page: "settings", tab: "onboarding" });
            }
            return current;
          });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const durationMs = Math.max(0, Math.round(getStartupMonotonicNow() - startupStartedMs));
        setDevDiagnosticsStartupSummary({
          startedAt: startupStartedAt,
          finishedAt: new Date().toISOString(),
          durationMs,
          outcome: "misconfigured",
          phases: [
            {
              key: "shell",
              label: "Shell ready",
              status: "error",
              startedAt: startupStartedAt,
              finishedAt: new Date().toISOString(),
              durationMs,
              detail: "Mission Control startup crashed before the shell could become interactive.",
            },
          ],
        });
        recordClientDiagnostic({
          level: "error",
          category: "startup",
          event: "startup.complete.error",
          message: "Startup crashed before Mission Control could finish booting.",
          context: {
            durationMs,
            error: (error as Error).message,
          },
        });
        setGatewayAccess({
          status: "misconfigured",
          message: (error as Error).message,
          healthDetail: "Gateway access preflight crashed before Mission Control could finish startup.",
        });
        setStreamState("closed");
        setOnboardingComplete(null);
        setWorkspaceOptions([]);
      })
      .finally(() => {
        if (!cancelled) {
          setGatewayAccessBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [gatewayAccessRunId]);

  useEffect(() => {
    if (gatewayAccessAutoRetryTimerRef.current !== null) {
      window.clearTimeout(gatewayAccessAutoRetryTimerRef.current);
      gatewayAccessAutoRetryTimerRef.current = null;
    }
    setGatewayAccessAutoRetryPending(false);
    if (gatewayAccess.status !== "unreachable" || gatewayAccessBusy || typeof window === "undefined") {
      return;
    }

    setGatewayAccessAutoRetryPending(true);
    gatewayAccessAutoRetryTimerRef.current = window.setTimeout(() => {
      gatewayAccessAutoRetryTimerRef.current = null;
      setGatewayAccessAutoRetryPending(false);
      setGatewayAccessRunId((current) => current + 1);
    }, GATEWAY_ACCESS_AUTO_RETRY_MS);

    return () => {
      if (gatewayAccessAutoRetryTimerRef.current !== null) {
        window.clearTimeout(gatewayAccessAutoRetryTimerRef.current);
        gatewayAccessAutoRetryTimerRef.current = null;
      }
      setGatewayAccessAutoRetryPending(false);
    };
  }, [gatewayAccess.status, gatewayAccessBusy]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setStreamState("closed");
      setDevDiagnosticsSseState("closed");
      resetEventStreamStatus();
      return;
    }

    const close = connectEventStream(
      (event) => {
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "event",
          message: `Realtime event ${event.eventType}`,
          context: {
            source: event.source,
            eventId: event.eventId,
          },
        });
        const topics = deriveRefreshTopics(event);
        for (const topic of topics) {
          emitRefresh(topic, {
            reason: event.payload.kind === "replay_gap" ? "replay_gap" : event.eventType,
            source: event.source,
            eventType: event.payload.kind === "replay_gap" ? "replay_gap" : event.eventType,
            eventId: event.eventId,
            timestamp: Date.now(),
          });
        }
        if (event.eventType === "auth_device_request_created") {
          const prompt = parseDeviceAccessPrompt(event);
          if (prompt) {
            setDeviceAccessPrompts((current) => upsertDeviceAccessPrompt(current, prompt));
            pushNotification(
              "warning",
              `${prompt.deviceLabel} is waiting for approval.`,
              `device-access:${prompt.approvalId}`,
            );
          }
        }
        if (event.eventType === "auth_device_request_resolved") {
          const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
          if (approvalId) {
            dismissDeviceAccessPrompt(approvalId);
          }
        }
        if (event.eventType === "approval_remote_action_ready") {
          const prompt = parseRemoteApprovalActionPrompt(event);
          if (prompt) {
            setRemoteApprovalPrompts((current) => upsertRemoteApprovalPrompt(current, prompt));
            pushNotification(
              "warning",
              `${prompt.kind} is waiting for a Mission Control decision.`,
              `remote-approval:${prompt.approvalId}`,
            );
          }
        }
        if (event.eventType === "approval_resolved") {
          const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
          if (approvalId) {
            dismissRemoteApprovalPrompt(approvalId);
          }
        }
        if (event.payload.kind === "replay_gap") {
          pushNotification(
            "warning",
            "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
            "stream-replay-gap",
          );
        }
      },
      (nextState) => {
        setStreamState(nextState);
        setDevDiagnosticsSseState(nextState);
        if (nextState === "open") {
          setDevDiagnosticsGatewayReachable(true);
        }
        recordClientDiagnostic({
          level: nextState === "error" ? "warn" : "info",
          category: "sse",
          event: "state_change",
          message: `Realtime stream is now ${nextState}`,
        });
      },
      publishEventStreamStatus,
    );

    return () => {
      close();
      resetEventStreamStatus();
    };
  }, [gatewayAccess.status, pushNotification, dismissDeviceAccessPrompt, dismissRemoteApprovalPrompt]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setWorkspaceOptions([]);
      return;
    }
    void loadWorkspaceOptions();
  }, [gatewayAccess.status, loadWorkspaceOptions]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setOperateStatus(null);
      return;
    }
    void loadOperateStatus();
  }, [gatewayAccess.status, loadOperateStatus]);

  useRefreshSubscription("surface", () => loadOperateStatus(), {
    enabled: gatewayAccess.status === "ready",
    coalesceMs: 900,
    staleMs: 20000,
    pollIntervalMs: 15000,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    const search = buildRouteSearch(route);
    window.history.replaceState(null, "", `${url.pathname}${search}${url.hash}`);
    setDevDiagnosticsCurrentRoute(`${url.pathname}${search}${url.hash}`);
    recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "route.change",
      message: `Switched to ${route.space}/${route.page}`,
      context: { ...route },
    });
  }, [route]);

  useEffect(() => {
    setDevDiagnosticsCurrentEffectsMode(effectiveEffectsMode);
  }, [effectiveEffectsMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const commandItems = useMemo(
    () => [
      ...Object.entries(SPACE_META).map(([space, meta]) => ({
        id: `space:${space}`,
        label: `Open ${meta.label}`,
        keywords: [space, meta.label.toLowerCase()],
        run: () => handleSelectSpace(space as Space),
      })),
      ...SPACE_PAGES.operate.map((item) => ({
        id: `operate:${item.page}`,
        label: item.page === "surface" ? "Open Chat surface" : `Open ${item.label}`,
        keywords: [item.label.toLowerCase(), item.page],
        run: () => (item.page === "surface" ? handleSelectSurface("chat") : handleSelectPage(item.page)),
      })),
      ...(["chat", "cowork", "code"] as const).map((surface) => ({
        id: `surface:${surface}`,
        label: `Open ${CHAT_MODE_PRESETS[surface].label}`,
        keywords: [surface, CHAT_MODE_PRESETS[surface].label.toLowerCase()],
        run: () => handleSelectSurface(surface),
      })),
      {
        id: "settings:open",
        label: "Open Settings",
        keywords: ["settings", "configure"],
        run: () => navigate({ space: "configure", page: "settings", tab: "general" }),
      },
      {
        id: "density:compact",
        label: "Use Compact density",
        keywords: ["compact", "density", "layout"],
        run: () => setDensity("compact"),
      },
      {
        id: "density:default",
        label: "Use Default density",
        keywords: ["default", "density", "layout"],
        run: () => setDensity("default"),
      },
      {
        id: "density:comfortable",
        label: "Use Comfortable density",
        keywords: ["comfortable", "density", "layout"],
        run: () => setDensity("comfortable"),
      },
      {
        id: "mode:simple",
        label: "Switch to Beginner experience",
        keywords: ["beginner", "simple", "guided", "experience"],
        run: () => setUiMode("simple"),
      },
      {
        id: "mode:advanced",
        label: "Switch to Advanced experience",
        keywords: ["advanced", "full controls", "experience"],
        run: () => setUiMode("advanced"),
      },
      {
        id: "effects:auto",
        label: "Use automatic effects",
        keywords: ["effects", "auto"],
        run: () => setEffectsMode("auto"),
      },
      {
        id: "effects:full",
        label: "Use full effects",
        keywords: ["effects", "full"],
        run: () => setEffectsMode("full"),
      },
      {
        id: "effects:reduced",
        label: "Use reduced effects",
        keywords: ["effects", "reduced"],
        run: () => setEffectsMode("reduced"),
      },
      {
        id: "details:toggle",
        label: showTechnicalDetails ? "Hide technical details" : "Show technical details",
        keywords: ["technical", "details", "debug"],
        run: () => setShowTechnicalDetails(!showTechnicalDetails),
      },
      ...(isDevDiagnosticsEnabled()
        ? [
            {
              id: "dev:diagnostics",
              label: diagnosticsOpen ? "Hide developer diagnostics" : "Show developer diagnostics",
              keywords: ["diagnostics", "dev", "logs", "debug"],
              run: () => setDiagnosticsOpen((current) => !current),
            },
          ]
        : []),
    ],
    [
      diagnosticsOpen,
      handleSelectPage,
      handleSelectSpace,
      handleSelectSurface,
      navigate,
      setDensity,
      setEffectsMode,
      setShowTechnicalDetails,
      setUiMode,
      showTechnicalDetails,
    ],
  );

  const currentPageLabel = getPageLabel(route);
  const operateApprovalsCount = deriveShellApprovalCount(operateStatus, localApprovalPromptCount);
  const operateActiveAgentsCount = operateStatus?.activeSubagents ?? 0;
  const operateDailyCostUsd = operateStatus?.dailyCostUsd ?? 0;
  const operateOpenTasksCount = (operateStatus?.taskStatusCounts ?? []).reduce(
    (sum, item) => (item.status === "done" ? sum : sum + item.count),
    0,
  );
  const operateStatusFreshness = deriveOperateStatusFreshness(operateStatusLastSuccessAt, operateStatusLastError);
  const decisionsChipLabel =
    operateApprovalsCount > 0
      ? `${operateApprovalsCount} decisions`
      : operateStatusFreshness.state === "stale"
        ? "Decision status stale"
        : "Decisions clear";

  const operateSurfaceTab = route.space === "operate" && route.page === "surface" ? (route.surface ?? "chat") : "chat";

  const observeActivityTab =
    route.space === "observe" && route.page === "activity" ? ((route.tab ?? "activity") as ActivityTab) : "activity";

  const observeArtifactsTab =
    route.space === "observe" && route.page === "artifacts" ? ((route.tab ?? "memory") as ArtifactsTab) : "memory";

  const configureSettingsTab =
    route.space === "configure" && route.page === "settings" ? ((route.tab ?? "general") as SettingsTab) : "general";

  const configureIntegrationsTab =
    route.space === "configure" && route.page === "integrations"
      ? ((route.tab ?? "overview") as IntegrationsTab)
      : "overview";

  const configureAgentsTab =
    route.space === "configure" && route.page === "agents" ? ((route.tab ?? "overview") as AgentsTab) : "overview";

  const content = useMemo(() => {
    if (route.space === "operate") {
      if (route.page === "surface") {
        return (
          <section className="space-page space-page-surface">
            <ChatPage workspaceId={activeWorkspaceId} surface={route.surface} lockSurface />
          </section>
        );
      }
      if (route.page === "tasks") {
        return (
          <ShellPageFrame
            eyebrow="Operate"
            title="Trailboard"
            subtitle="Track active work, blockers, and linked sessions without leaving the operator flow."
          >
            <TasksPage workspaceId={activeWorkspaceId} />
          </ShellPageFrame>
        );
      }
      return (
        <ShellPageFrame
          eyebrow="Operate"
          title="Approvals"
          subtitle="Review risky actions, device access prompts, and operator decisions in one queue."
        >
          <ApprovalsPage />
        </ShellPageFrame>
      );
    }

    if (route.space === "observe") {
      if (route.page === "activity") {
        return (
          <ActivityHubPage
            workspaceId={activeWorkspaceId}
            activeTab={observeActivityTab}
            onTabChange={(tab: ActivityTab) => navigate({ space: "observe", page: "activity", tab })}
          />
        );
      }
      if (route.page === "sessions") {
        return (
          <ShellPageFrame
            eyebrow="Observe"
            title="Sessions"
            subtitle="Inspect completed and active runs, timelines, and outcome summaries."
          >
            <SessionsPage />
          </ShellPageFrame>
        );
      }
      if (route.page === "artifacts") {
        return (
          <ArtifactsPage
            workspaceId={activeWorkspaceId}
            activeTab={observeArtifactsTab}
            onTabChange={(tab: ArtifactsTab) => navigate({ space: "observe", page: "artifacts", tab })}
          />
        );
      }
      if (route.page === "costs") {
        return (
          <ShellPageFrame
            eyebrow="Observe"
            title="Costs"
            subtitle="Monitor spend, provider usage, and runtime cost posture."
          >
            <CostConsolePage />
          </ShellPageFrame>
        );
      }
      if (route.page === "quality") {
        return (
          <ShellPageFrame
            eyebrow="Observe"
            title="Quality"
            subtitle="Run prompt packs, inspect regressions, and benchmark reliability in one place."
          >
            <PromptLabPage workspaceId={activeWorkspaceId} />
          </ShellPageFrame>
        );
      }
      return (
        <ShellPageFrame
          eyebrow="Observe"
          title="System"
          subtitle="Machine, runtime, and infrastructure health for this Mission Control node."
        >
          <SystemPage />
        </ShellPageFrame>
      );
    }

    if (route.page === "settings") {
      return (
        <SettingsHubPage
          activeTab={configureSettingsTab}
          activeWorkspaceId={activeWorkspaceId}
          onWorkspaceChange={setActiveWorkspaceId}
          onTabChange={(tab: SettingsTab) => navigate({ space: "configure", page: "settings", tab })}
          onOnboardingCompleted={handleOnboardingCompleted}
        />
      );
    }
    if (route.page === "integrations") {
      return (
        <IntegrationsHubPage
          activeTab={configureIntegrationsTab}
          onTabChange={(tab: IntegrationsTab) => navigate({ space: "configure", page: "integrations", tab })}
        />
      );
    }
    if (route.page === "agents") {
      return (
        <AgentsHubPage
          activeTab={configureAgentsTab}
          onTabChange={(tab: AgentsTab) => navigate({ space: "configure", page: "agents", tab })}
        />
      );
    }
    return (
      <ShellPageFrame
        eyebrow="Configure"
        title="Tools"
        subtitle="Manage tool access, grants, and operational safeguards."
      >
        <ToolsPage />
      </ShellPageFrame>
    );
  }, [
    activeWorkspaceId,
    configureAgentsTab,
    configureIntegrationsTab,
    configureSettingsTab,
    handleOnboardingCompleted,
    navigate,
    observeActivityTab,
    observeArtifactsTab,
    route.page,
    route.space,
    route.surface,
    setActiveWorkspaceId,
  ]);

  if (gatewayAccess.status !== "ready") {
    return (
      <GatewayAccessGate
        gatewayBaseUrl={getGatewayApiBaseUrl()}
        access={gatewayAccess}
        busy={gatewayAccessBusy}
        autoRetryPending={gatewayAccessAutoRetryPending}
        onRetry={retryGatewayAccess}
      />
    );
  }

  const workspaceSelectOptions = [...workspaceOptions, { workspaceId: activeWorkspaceId, name: activeWorkspaceId }]
    .filter((item, index, arr) => arr.findIndex((other) => other.workspaceId === item.workspaceId) === index)
    .map((item) => ({ value: item.workspaceId, label: item.name }));

  const compactShellNavOptions =
    route.space === "operate"
      ? [
          { value: "chat", label: CHAT_MODE_PRESETS.chat.label },
          { value: "cowork", label: CHAT_MODE_PRESETS.cowork.label },
          { value: "code", label: CHAT_MODE_PRESETS.code.label },
          { value: "tasks", label: "Tasks" },
          { value: "approvals", label: "Approvals" },
        ]
      : SPACE_PAGES[route.space].map((item) => ({ value: item.page, label: item.label }));

  const compactShellNavValue =
    route.space === "operate" ? (route.page === "surface" ? (route.surface ?? "chat") : route.page) : route.page;

  return (
    <div
      className={`app-shell layout-shell theme-signal-noir ui-mode-${uiMode} ui-density-${density} ui-effects-${effectiveEffectsMode}${showTechnicalDetails ? "" : " ui-hide-technical"}`}
      data-density={density}
      data-effects-mode={effectsMode}
      data-effective-effects-mode={effectiveEffectsMode}
    >
      <header className="shell-bar">
        <div className="shell-bar-brand">
          <div className="shell-bar-brand-copy">
            <p className="shell-bar-kicker">GoatCitadel Mission Control</p>
            <h1 className="shell-bar-title">{SPACE_META[route.space].label}</h1>
          </div>
        </div>
        <nav className="space-nav" aria-label="Mission Control spaces">
          {(Object.keys(SPACE_META) as Space[]).map((space) => (
            <button
              key={space}
              type="button"
              className={`space-nav-item${route.space === space ? " active" : ""}`}
              onClick={() => handleSelectSpace(space)}
            >
              {SPACE_META[space].label}
            </button>
          ))}
        </nav>
        <div className="shell-bar-actions">
          <button type="button" className="shell-command-trigger-topbar" onClick={() => setPaletteOpen(true)}>
            {appCopy.quickActionsButton}
          </button>
          <label className="shell-workspace-picker">
            <span className="shell-action-label">Workspace</span>
            <GCSelect value={activeWorkspaceId} onChange={setActiveWorkspaceId} options={workspaceSelectOptions} />
          </label>
          <button
            type="button"
            className="shell-status-link"
            onClick={() => navigate({ space: "operate", page: "approvals" })}
          >
            <StatusChip
              tone={operateApprovalsCount > 0 || operateStatusFreshness.state === "stale" ? "warning" : "success"}
            >
              {decisionsChipLabel}
            </StatusChip>
          </button>
        </div>
      </header>

      <div className={`shell-secondary-nav${compactShellNav ? " compact" : ""}`}>
        {compactShellNav ? (
          <label className="shell-context-picker">
            <span className="shell-action-label">Current area</span>
            <GCSelect
              value={compactShellNavValue}
              onChange={(value) => {
                if (route.space === "operate" && isWorkSurface(value)) {
                  handleSelectSurface(value);
                  return;
                }
                handleSelectPage(value as SpacePage);
              }}
              options={compactShellNavOptions}
              aria-label={`${SPACE_META[route.space].label} pages`}
            />
          </label>
        ) : route.space === "operate" ? (
          <nav className="surface-nav" aria-label="Operate destinations">
            {(["chat", "cowork", "code"] as WorkSurface[]).map((surface) => (
              <button
                key={surface}
                type="button"
                className={`surface-nav-item${route.page === "surface" && operateSurfaceTab === surface ? " active" : ""}`}
                onClick={() => handleSelectSurface(surface)}
              >
                {CHAT_MODE_PRESETS[surface].label}
              </button>
            ))}
            <button
              type="button"
              className={`surface-nav-item${route.page === "tasks" ? " active" : ""}`}
              onClick={() => handleSelectPage("tasks")}
            >
              Tasks
            </button>
            <button
              type="button"
              className={`surface-nav-item${route.page === "approvals" ? " active" : ""}`}
              onClick={() => handleSelectPage("approvals")}
            >
              Approvals
            </button>
          </nav>
        ) : (
          <nav className="secondary-page-nav" aria-label={`${SPACE_META[route.space].label} pages`}>
            {SPACE_PAGES[route.space].map((item) => (
              <button
                key={item.page}
                type="button"
                className={`secondary-page-nav-item${route.page === item.page ? " active" : ""}`}
                onClick={() => handleSelectPage(item.page)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}
      </div>

      <main className="shell-main">
        {notifications.length > 0 ? (
          <div className="shell-notification-region">
            <NotificationStack
              items={notifications}
              onDismiss={(id) => setNotifications((current) => current.filter((item) => item.id !== id))}
            />
          </div>
        ) : null}
        {shellGatewayState.status === "degraded-live-updates" ? (
          <div className="status-banner warning">
            {shellGatewayState.summary} {shellGatewayState.nextStep}
          </div>
        ) : null}
        {route.space === "operate" && operateStatusFreshness.state === "stale" ? (
          <div className="status-banner warning">{operateStatusFreshness.note}</div>
        ) : null}
        {route.space === "operate" ? (
          <StatusStrip
            approvalsCount={operateApprovalsCount}
            approvalsLabel="Pending decisions"
            approvalsNote={
              operateStatusFreshness.state === "stale"
                ? `${operateStatusFreshness.note} Review the Approvals page before trusting these counts.`
                : "Backend approvals plus local Mission Control prompts."
            }
            activeAgentsCount={operateActiveAgentsCount}
            dailyCostUsd={operateDailyCostUsd}
            openTasksCount={operateOpenTasksCount}
            onOpenApprovals={() => navigate({ space: "operate", page: "approvals" })}
            onOpenAgents={() => navigate({ space: "configure", page: "agents", tab: "herd-live" })}
            onOpenCosts={() => navigate({ space: "observe", page: "costs" })}
            onOpenTasks={() => navigate({ space: "operate", page: "tasks" })}
          />
        ) : null}
        <PageErrorBoundary
          resetKey={`${route.space}:${route.page}:${route.surface ?? ""}:${route.tab ?? ""}`}
          pageLabel={currentPageLabel}
          onReturnToChat={() => navigate(DEFAULT_ROUTE)}
        >
          <Suspense fallback={<PageLoadingFallback label={currentPageLabel} />}>{content}</Suspense>
        </PageErrorBoundary>
      </main>

      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={commandItems} />
        </Suspense>
      ) : null}
      {diagnosticsOpen && isDevDiagnosticsEnabled() ? (
        <Suspense fallback={null}>
          <DevDiagnosticsPanel open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
        </Suspense>
      ) : null}
      <DeviceAccessApprovalModal
        open={Boolean(activeDeviceAccessPrompt)}
        prompt={activeDeviceAccessPrompt}
        busy={deviceAccessResolveBusy}
        onApprove={() => void handleResolveDeviceAccessPrompt("approve")}
        onReject={() => void handleResolveDeviceAccessPrompt("reject")}
        onDismiss={() => {
          if (activeDeviceAccessPrompt) {
            dismissDeviceAccessPrompt(activeDeviceAccessPrompt.approvalId);
          }
        }}
      />
      <RemoteApprovalActionModal
        open={Boolean(activeRemoteApprovalPrompt)}
        prompt={activeRemoteApprovalPrompt}
        busy={remoteApprovalResolveBusy}
        onApprove={() => void handleResolveRemoteApprovalPrompt("approve")}
        onReject={() => void handleResolveRemoteApprovalPrompt("reject")}
        onDismiss={() => {
          if (activeRemoteApprovalPrompt) {
            dismissRemoteApprovalPrompt(activeRemoteApprovalPrompt.approvalId);
          }
        }}
      />
    </div>
  );
}

function parseDeviceAccessPrompt(event: RealtimeEvent): DeviceAccessApprovalPrompt | undefined {
  const approvalId = readDeviceAccessPromptField(event.payload, "approvalId");
  const requestId = readDeviceAccessPromptField(event.payload, "requestId");
  if (!approvalId || !requestId) {
    return undefined;
  }
  return {
    approvalId,
    requestId,
    deviceLabel: readDeviceAccessPromptField(event.payload, "deviceLabel") ?? "New device",
    deviceType: readDeviceAccessPromptField(event.payload, "deviceType"),
    platform: readDeviceAccessPromptField(event.payload, "platform"),
    requestedIp: readDeviceAccessPromptField(event.payload, "requestedIp"),
    requestedOrigin: readDeviceAccessPromptField(event.payload, "requestedOrigin"),
    createdAt: readDeviceAccessPromptField(event.payload, "createdAt"),
  };
}

function upsertDeviceAccessPrompt(
  current: DeviceAccessApprovalPrompt[],
  incoming: DeviceAccessApprovalPrompt,
): DeviceAccessApprovalPrompt[] {
  const withoutMatch = current.filter((item) => item.approvalId !== incoming.approvalId);
  return [incoming, ...withoutMatch];
}

function parseRemoteApprovalActionPrompt(event: RealtimeEvent): RemoteApprovalActionPrompt | undefined {
  const nested = event.payload.payload;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return undefined;
  }
  const payload = nested as Record<string, unknown>;
  const approvalId = readDeviceAccessPromptField(payload, "approvalId");
  const tokenId = readDeviceAccessPromptField(payload, "tokenId");
  const token = readDeviceAccessPromptField(payload, "token");
  if (!approvalId || !tokenId || !token) {
    return undefined;
  }
  const preview = payload.preview;
  return {
    approvalId,
    actionType: "approval.resolve",
    tokenId,
    token,
    kind: readDeviceAccessPromptField(payload, "kind") ?? "approval",
    riskLevel: readDeviceAccessPromptField(payload, "riskLevel") ?? "danger",
    status: readDeviceAccessPromptField(payload, "status") ?? "pending",
    preview:
      preview && typeof preview === "object" && !Array.isArray(preview)
        ? (preview as Record<string, unknown>)
        : undefined,
    expiresAt: readDeviceAccessPromptField(payload, "expiresAt"),
  };
}

function upsertRemoteApprovalPrompt(
  current: RemoteApprovalActionPrompt[],
  incoming: RemoteApprovalActionPrompt,
): RemoteApprovalActionPrompt[] {
  const withoutMatch = current.filter((item) => item.approvalId !== incoming.approvalId);
  return [incoming, ...withoutMatch];
}

function readDeviceAccessPromptField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMissionControlResolverId(): string {
  if (typeof window === "undefined") {
    return "mission-control";
  }
  return `mission-control:${window.location.hostname}`;
}
