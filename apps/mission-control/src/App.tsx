/* eslint-disable max-lines */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
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
import { GlobalFreshnessPill } from "./components/GlobalFreshnessPill";
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
  buildRouteForVisiblePage,
  DEFAULT_ROUTE,
  getVisiblePage,
  getVisiblePageLabel,
  normalizeResolvedRoute,
  readRouteFromLocation,
  SPACE_META,
  VISIBLE_SPACE_PAGES,
  type AgentsTab,
  type ArtifactsTab,
  type IntegrationsTab,
  type ResolvedRoute,
  type Space,
  type VisiblePage,
} from "./content/page-registry";
import type { GeneralTab } from "./pages/GeneralHubPage";
import type { HealthTab } from "./pages/HealthPage";
import type { TimelineTab } from "./pages/TimelinePage";
import type { WorkspacesTab } from "./pages/WorkspacesHubPage";
import { formatWorkloadSummaryDescriptor, type WorkTrustDescriptor } from "./pages/chat/work-trust";
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

type LazyPageExport<TModule, TExport extends keyof TModule> =
  TModule[TExport] extends ComponentType<infer TProps> ? ComponentType<TProps> : never;
type LazyPageComponent<TModule, TExport extends keyof TModule> = LazyExoticComponent<LazyPageExport<TModule, TExport>>;

function lazyPage<TModule extends Record<string, unknown>, TExport extends keyof TModule>(
  loader: () => Promise<TModule>,
  exportName: TExport,
): LazyPageComponent<TModule, TExport> {
  return lazy(async () => {
    const module = await loader();
    const exportedComponent = module[exportName];

    if (!exportedComponent) {
      throw new Error(`Expected lazy page export "${String(exportName)}" to exist.`);
    }

    return {
      default: exportedComponent as LazyPageExport<TModule, TExport>,
    };
  }) as LazyPageComponent<TModule, TExport>;
}

const AgentsHubPage = lazyPage(() => import("./pages/AgentsHubPage"), "AgentsHubPage");
const ApprovalsPage = lazyPage(() => import("./pages/ApprovalsPage"), "ApprovalsPage");
const ArtifactsPage = lazyPage(() => import("./pages/ArtifactsPage"), "ArtifactsPage");
const ChatPage = lazyPage(() => import("./pages/ChatPage"), "ChatPage");
const CommandPalette = lazyPage(() => import("./components/CommandPalette"), "CommandPalette");
const DevDiagnosticsPanel = lazyPage(() => import("./components/DevDiagnosticsPanel"), "DevDiagnosticsPanel");
const GeneralHubPage = lazyPage(() => import("./pages/GeneralHubPage"), "GeneralHubPage");
const HealthPage = lazyPage(() => import("./pages/HealthPage"), "HealthPage");
const IntegrationsHubPage = lazyPage(() => import("./pages/IntegrationsHubPage"), "IntegrationsHubPage");
const PromptLabPage = lazyPage(() => import("./pages/PromptLabPage"), "PromptLabPage");
const RuntimeHubPage = lazyPage(() => import("./pages/RuntimeHubPage"), "RuntimeHubPage");
const TasksPage = lazyPage(() => import("./pages/TasksPage"), "TasksPage");
const TimelinePage = lazyPage(() => import("./pages/TimelinePage"), "TimelinePage");
const ToolsPage = lazyPage(() => import("./pages/ToolsPage"), "ToolsPage");
const WorkspacesHubPage = lazyPage(() => import("./pages/WorkspacesHubPage"), "WorkspacesHubPage");
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

function deriveOperateStatusStripExpanded(): boolean {
  return false;
}

function resolveShellThemeClass(): "theme-signal-noir" | "theme-citadel-light" {
  if (typeof window === "undefined") {
    return "theme-signal-noir";
  }
  const value = new URLSearchParams(window.location.search).get("theme")?.trim().toLowerCase();
  if (value === "light" || value === "citadel-light" || value === "theme-citadel-light") {
    return "theme-citadel-light";
  }
  return "theme-signal-noir";
}

function deriveTimelineTab(route: ResolvedRoute): TimelineTab {
  if (route.space !== "observe") {
    return "activity";
  }
  if (route.page === "sessions") {
    return "sessions";
  }
  if (route.page === "activity" && route.tab === "scheduler") {
    return "scheduler";
  }
  if (route.page === "activity" && route.tab === "improvement") {
    return "improvement";
  }
  return "activity";
}

function deriveHealthTab(route: ResolvedRoute): HealthTab {
  return route.space === "observe" && route.page === "system" ? "system" : "costs";
}

function deriveGeneralTab(route: ResolvedRoute): GeneralTab {
  if (
    route.space === "configure" &&
    route.page === "settings" &&
    (route.tab === "providers" || route.tab === "access" || route.tab === "budget" || route.tab === "onboarding")
  ) {
    return route.tab;
  }
  return "general";
}

function deriveWorkspacesTab(route: ResolvedRoute): WorkspacesTab {
  return route.space === "configure" && route.page === "settings" && route.tab === "addons" ? "addons" : "workspaces";
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
  { topic: "llamaCpp", keywords: ["llamacpp", "llama.cpp"] },
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
  const [operateStatusStripExpanded, setOperateStatusStripExpanded] = useState(() =>
    deriveOperateStatusStripExpanded(),
  );
  const [operateProviderModelSummary, setOperateProviderModelSummary] = useState<string | null>(null);
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

  const handleSelectVisiblePage = useCallback(
    (page: VisiblePage) => {
      navigate(buildRouteForVisiblePage(route, page));
    },
    [navigate, route],
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
    const syncRouteFromLocation = () => {
      setRoute(readRouteFromLocation());
    };
    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, []);

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
      ...Object.entries(VISIBLE_SPACE_PAGES).flatMap(([space, pages]) =>
        pages.map((item) => ({
          id: `page:${space}:${item.page}`,
          label: `Open ${item.label}`,
          keywords: [space, item.label.toLowerCase(), item.page],
          run: () => handleSelectVisiblePage(item.page),
        })),
      ),
      ...(["chat", "cowork", "code"] as const).map((surface) => ({
        id: `surface:${surface}`,
        label: `Open ${CHAT_MODE_PRESETS[surface].label}`,
        keywords: [surface, CHAT_MODE_PRESETS[surface].label.toLowerCase()],
        run: () => handleSelectVisiblePage(surface),
      })),
      {
        id: "settings:open",
        label: "Open General",
        keywords: ["general", "settings", "configure", "tune"],
        run: () => handleSelectVisiblePage("general"),
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
      handleSelectVisiblePage,
      handleSelectSpace,
      setDensity,
      setEffectsMode,
      setShowTechnicalDetails,
      setUiMode,
      showTechnicalDetails,
    ],
  );

  const visiblePage = getVisiblePage(route);
  const currentPageLabel = getVisiblePageLabel(route);
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
  const timelineTab = deriveTimelineTab(route);
  const healthTab = deriveHealthTab(route);

  const observeArtifactsTab =
    route.space === "observe" && route.page === "artifacts" ? ((route.tab ?? "memory") as ArtifactsTab) : "memory";
  const generalTab = deriveGeneralTab(route);
  const workspacesTab = deriveWorkspacesTab(route);

  const configureIntegrationsTab =
    route.space === "configure" && route.page === "integrations"
      ? ((route.tab ?? "overview") as IntegrationsTab)
      : "overview";

  const configureAgentsTab =
    route.space === "configure" && route.page === "agents" ? ((route.tab ?? "overview") as AgentsTab) : "overview";
  const activeWorkspaceName =
    workspaceOptions.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? activeWorkspaceId;
  const runtimeSummaryLabel =
    operateActiveAgentsCount > 0
      ? `${operateActiveAgentsCount} active runtime${operateActiveAgentsCount === 1 ? "" : "s"}`
      : "No active runtime";
  const hasOperateUrgency =
    operateStatusFreshness.state === "stale" || shellGatewayState.status === "degraded-live-updates";
  const operateStatusVariant = hasOperateUrgency || operateStatusStripExpanded ? "expanded" : "compact";
  const workloadSummary = formatWorkloadSummaryDescriptor({
    approvalsCount: operateApprovalsCount,
    activeAgentsCount: operateActiveAgentsCount,
    openTasksCount: operateOpenTasksCount,
    dailyCostUsd: operateDailyCostUsd,
  });
  const workTrustDescriptor = useMemo<WorkTrustDescriptor>(
    () => ({
      workspaceLabel: activeWorkspaceName.trim().length > 0 ? activeWorkspaceName : "Workspace unavailable",
      gatewayTone: shellGatewayState.tone,
      gatewayLabel: shellGatewayState.label,
      approvalsSummary: decisionsChipLabel,
      activeModeLabel:
        route.space === "operate" && route.page === "surface"
          ? CHAT_MODE_PRESETS[operateSurfaceTab].label
          : currentPageLabel,
      providerModelSummary: operateProviderModelSummary ?? "Provider routing pending",
      runtimeSummary: runtimeSummaryLabel,
    }),
    [
      activeWorkspaceName,
      currentPageLabel,
      decisionsChipLabel,
      operateProviderModelSummary,
      operateSurfaceTab,
      route.page,
      route.space,
      runtimeSummaryLabel,
      shellGatewayState.label,
      shellGatewayState.tone,
    ],
  );

  useEffect(() => {
    if (route.space !== "operate") {
      return;
    }
    setOperateStatusStripExpanded(deriveOperateStatusStripExpanded());
  }, [route]);

  useEffect(() => {
    if (route.space !== "operate" || route.page !== "surface") {
      setOperateProviderModelSummary(null);
    }
  }, [route.page, route.space]);

  const content = useMemo(() => {
    if (route.space === "operate") {
      if (route.page === "surface") {
        return (
          <section className="space-page space-page-surface">
            <ChatPage
              workspaceId={activeWorkspaceId}
              workspaceName={activeWorkspaceName}
              approvalsCount={operateApprovalsCount}
              surface={route.surface}
              lockSurface
              workTrust={workTrustDescriptor}
              onWorkTrustSummaryChange={setOperateProviderModelSummary}
              onOpenCowork={() => navigate({ space: "operate", page: "surface", surface: "cowork" })}
              onOpenCode={() => navigate({ space: "operate", page: "surface", surface: "code" })}
              onOpenTasks={() => navigate({ space: "operate", page: "tasks" })}
              onOpenApprovals={() => navigate({ space: "operate", page: "approvals" })}
            />
          </section>
        );
      }
      if (route.page === "tasks") {
        return (
          <ShellPageFrame
            title="Trailboard"
            subtitle="Track active work, blockers, and linked sessions without leaving the operator flow."
          >
            <TasksPage workspaceId={activeWorkspaceId} />
          </ShellPageFrame>
        );
      }
      return (
        <ShellPageFrame
          title="Approvals"
          subtitle="Persisted approval records, history, and runtime recovery for decisions that still need audit or intervention."
        >
          <ApprovalsPage />
        </ShellPageFrame>
      );
    }

    if (route.space === "observe") {
      if (visiblePage === "timeline") {
        return (
          <TimelinePage
            workspaceId={activeWorkspaceId}
            activeTab={timelineTab}
            onTabChange={(tab: TimelineTab) =>
              navigate(
                tab === "sessions"
                  ? { space: "observe", page: "sessions" }
                  : { space: "observe", page: "activity", tab: tab === "activity" ? "activity" : tab },
              )
            }
          />
        );
      }
      if (visiblePage === "artifacts") {
        return (
          <ArtifactsPage
            workspaceId={activeWorkspaceId}
            activeTab={observeArtifactsTab}
            onTabChange={(tab: ArtifactsTab) => navigate({ space: "observe", page: "artifacts", tab })}
          />
        );
      }
      if (visiblePage === "health") {
        return (
          <HealthPage
            activeTab={healthTab}
            onTabChange={(tab: HealthTab) =>
              navigate(tab === "system" ? { space: "observe", page: "system" } : { space: "observe", page: "costs" })
            }
          />
        );
      }
      if (visiblePage === "quality") {
        return (
          <ShellPageFrame
            title="Quality"
            subtitle="Run prompt packs, inspect regressions, and benchmark reliability in one place."
          >
            <PromptLabPage workspaceId={activeWorkspaceId} />
          </ShellPageFrame>
        );
      }
    }

    if (visiblePage === "general") {
      return (
        <GeneralHubPage
          activeTab={generalTab}
          onTabChange={(tab: GeneralTab) => navigate({ space: "configure", page: "settings", tab })}
          onOnboardingCompleted={handleOnboardingCompleted}
        />
      );
    }
    if (visiblePage === "runtime") {
      return <RuntimeHubPage />;
    }
    if (visiblePage === "workspaces") {
      return (
        <WorkspacesHubPage
          activeTab={workspacesTab}
          activeWorkspaceId={activeWorkspaceId}
          onWorkspaceChange={setActiveWorkspaceId}
          onTabChange={(tab: WorkspacesTab) => navigate({ space: "configure", page: "settings", tab })}
        />
      );
    }
    if (visiblePage === "integrations") {
      return (
        <IntegrationsHubPage
          activeTab={configureIntegrationsTab}
          onTabChange={(tab: IntegrationsTab) => navigate({ space: "configure", page: "integrations", tab })}
        />
      );
    }
    if (visiblePage === "agents") {
      return (
        <AgentsHubPage
          activeTab={configureAgentsTab}
          onTabChange={(tab: AgentsTab) => navigate({ space: "configure", page: "agents", tab })}
        />
      );
    }
    return (
      <ShellPageFrame title="Tools" subtitle="Manage tool access, grants, and operational safeguards.">
        <ToolsPage />
      </ShellPageFrame>
    );
  }, [
    activeWorkspaceId,
    activeWorkspaceName,
    configureAgentsTab,
    configureIntegrationsTab,
    generalTab,
    handleOnboardingCompleted,
    healthTab,
    navigate,
    observeArtifactsTab,
    operateApprovalsCount,
    setActiveWorkspaceId,
    timelineTab,
    visiblePage,
    workspacesTab,
    workTrustDescriptor,
    route.page,
    route.space,
    route.surface,
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

  const compactShellNavOptions = VISIBLE_SPACE_PAGES[route.space].map((item) => ({
    value: item.page,
    label: item.label,
  }));
  const compactShellNavValue = visiblePage;
  const shellThemeClass = resolveShellThemeClass();

  return (
    <div
      className={`app-shell layout-shell ${shellThemeClass} ui-mode-${uiMode} ui-density-${density} ui-effects-${effectiveEffectsMode}${showTechnicalDetails ? "" : " ui-hide-technical"}`}
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
              className={`space-nav-item gc-nav-button gc-nav-tier-space${route.space === space ? " active" : ""}`}
              onClick={() => handleSelectSpace(space)}
            >
              {SPACE_META[space].label}
            </button>
          ))}
        </nav>
        <div className="shell-bar-actions">
          <div className="shell-bar-utility">
            <GlobalFreshnessPill streamState={streamState} variant="compact" />
            <button
              type="button"
              className="shell-command-trigger-topbar gc-nav-button gc-nav-tier-chip"
              onClick={() => setPaletteOpen(true)}
            >
              {appCopy.quickActionsButton}
            </button>
          </div>
          <label className="shell-workspace-picker">
            <span className="shell-action-label">Workspace</span>
            <GCSelect value={activeWorkspaceId} onChange={setActiveWorkspaceId} options={workspaceSelectOptions} />
          </label>
        </div>
      </header>

      <div className={`shell-secondary-nav${compactShellNav ? " compact" : ""}`}>
        <div className="shell-secondary-nav-primary">
          {compactShellNav ? (
            <label className="shell-context-picker">
              <span className="shell-action-label">Current area</span>
              <GCSelect
                value={compactShellNavValue}
                onChange={(value) => handleSelectVisiblePage(value as VisiblePage)}
                options={compactShellNavOptions}
                aria-label={`${SPACE_META[route.space].label} pages`}
              />
            </label>
          ) : (
            <nav
              className={route.space === "operate" ? "surface-nav" : "secondary-page-nav"}
              aria-label={`${SPACE_META[route.space].label} pages`}
            >
              {VISIBLE_SPACE_PAGES[route.space].map((item) => (
                <button
                  key={item.page}
                  type="button"
                  className={`${route.space === "operate" ? "surface-nav-item" : "secondary-page-nav-item"} gc-nav-button gc-nav-tier-page${visiblePage === item.page ? " active" : ""}`}
                  onClick={() => handleSelectVisiblePage(item.page)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="shell-trust-hud" aria-label="Shell trust context">
          {route.space === "operate" ? (
            <StatusChip tone="muted">{workTrustDescriptor.workspaceLabel}</StatusChip>
          ) : null}
          <StatusChip tone={workTrustDescriptor.gatewayTone}>{workTrustDescriptor.gatewayLabel}</StatusChip>
          {route.space === "operate" && route.page === "surface" ? (
            <StatusChip tone="muted" className="shell-trust-provider">
              {workTrustDescriptor.activeModeLabel} · {workTrustDescriptor.providerModelSummary}
            </StatusChip>
          ) : route.space === "operate" ? (
            <StatusChip tone="muted">{workTrustDescriptor.activeModeLabel}</StatusChip>
          ) : null}
          <button
            type="button"
            className={`shell-trust-action gc-nav-button gc-nav-tier-chip${operateApprovalsCount > 0 ? " active" : ""}`}
            onClick={() => navigate({ space: "operate", page: "approvals" })}
          >
            {workTrustDescriptor.approvalsSummary}
          </button>
          {route.space === "operate" ? (
            <StatusChip tone={operateActiveAgentsCount > 0 ? "live" : "muted"}>
              {workTrustDescriptor.runtimeSummary}
            </StatusChip>
          ) : null}
          {route.space === "operate" ? (
            <button
              type="button"
              className={`shell-workload-toggle gc-nav-button gc-nav-tier-chip${operateStatusVariant === "expanded" ? " active" : ""}`}
              aria-expanded={operateStatusVariant === "expanded"}
              onClick={() => setOperateStatusStripExpanded((current) => !current)}
            >
              {workloadSummary.label}
            </button>
          ) : null}
        </div>
      </div>

      <main className="shell-main">
        {route.space === "operate" && operateStatusVariant === "expanded" ? (
          <div className="shell-attached-status-panel">
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
              variant="expanded"
              context="work"
              placement="attached"
              onToggleVariant={(next) => setOperateStatusStripExpanded(next === "expanded")}
              onOpenApprovals={() => navigate({ space: "operate", page: "approvals" })}
              onOpenAgents={() => navigate({ space: "configure", page: "agents", tab: "herd-live" })}
              onOpenCosts={() => handleSelectVisiblePage("health")}
              onOpenTasks={() => navigate({ space: "operate", page: "tasks" })}
            />
          </div>
        ) : null}
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
