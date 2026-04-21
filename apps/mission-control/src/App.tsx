/* eslint-disable max-lines */
import {
  Suspense,
  lazy,
  startTransition,
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
import { GCSelect } from "./components/ui";
import { GatewayAccessGate } from "./components/GatewayAccessGate";
import { NotificationStack, type NotificationItem, upsertNotificationItem } from "./components/NotificationStack";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { RemoteApprovalActionModal, type RemoteApprovalActionPrompt } from "./components/RemoteApprovalActionModal";
import { ShellPageFrame } from "./components/ShellPageFrame";
import { ShellDetailPanelProvider, type ShellDetailPanelEntry } from "./components/ShellDetailPanelContext";
import { ShellNavRail, cycleShellNavMode } from "./components/ShellNavRail";
import { ShellStatusCenter } from "./components/ShellStatusCenter";
import { SideInspectorDrawer } from "./components/SideInspectorDrawer";
import { SignalLoader } from "./components/SignalLoader";
import type { ShellStatusEntry, ShellStatusSummary } from "./components/shell-status-model";
import {
  buildRouteSearch,
  buildRouteForVisiblePage,
  DEFAULT_ROUTE,
  getVisiblePage,
  getVisiblePageLabel,
  normalizeResolvedRoute,
  PAGE_META,
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
import { type WorkTrustDescriptor } from "./pages/chat/work-trust";
import { AgentsHubPage } from "./pages/AgentsHubPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { ChatPage } from "./pages/ChatPage";
import { HealthPage } from "./pages/HealthPage";
import { emitRefresh, type RefreshTopic } from "./state/refresh-bus";
import { useUiPreferences } from "./state/ui-preferences";
import { resolveEffectiveEffectsMode } from "./state/effects-mode";
import { publishEventStreamStatus, resetEventStreamStatus } from "./state/event-stream-status-store";
import { deriveShellGatewayAccessState } from "./state/gateway-shell-state";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useRefreshSubscription } from "./hooks/useRefreshSubscription";
import { ResizablePaneLayout } from "./components/ResizablePaneLayout";
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

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const LAST_ROUTE_STORAGE_KEY = "goatcitadel.shell.last-route";

function buildPersistedRouteSearch(route: ResolvedRoute): string {
  return buildRouteSearch({
    space: route.space,
    page: route.page,
    surface: route.surface,
    tab: route.tab,
  });
}

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

const loadApprovalsPage = () => import("./pages/ApprovalsPage");
const loadCommandPalette = () => import("./components/CommandPalette");
const loadDevDiagnosticsPanel = () => import("./components/DevDiagnosticsPanel");
const loadGeneralHubPage = () => import("./pages/GeneralHubPage");
const loadIntegrationsHubPage = () => import("./pages/IntegrationsHubPage");
const loadPromptLabPage = () => import("./pages/PromptLabPage");
const loadRuntimeHubPage = () => import("./pages/RuntimeHubPage");
const loadTasksPage = () => import("./pages/TasksPage");
const loadTimelinePage = () => import("./pages/TimelinePage");
const loadToolsPage = () => import("./pages/ToolsPage");
const loadWorkspacesHubPage = () => import("./pages/WorkspacesHubPage");

const ApprovalsPage = lazyPage(loadApprovalsPage, "ApprovalsPage");
const CommandPalette = lazyPage(loadCommandPalette, "CommandPalette");
const DevDiagnosticsPanel = lazyPage(loadDevDiagnosticsPanel, "DevDiagnosticsPanel");
const GeneralHubPage = lazyPage(loadGeneralHubPage, "GeneralHubPage");
const IntegrationsHubPage = lazyPage(loadIntegrationsHubPage, "IntegrationsHubPage");
const PromptLabPage = lazyPage(loadPromptLabPage, "PromptLabPage");
const RuntimeHubPage = lazyPage(loadRuntimeHubPage, "RuntimeHubPage");
const TasksPage = lazyPage(loadTasksPage, "TasksPage");
const TimelinePage = lazyPage(loadTimelinePage, "TimelinePage");
const ToolsPage = lazyPage(loadToolsPage, "ToolsPage");
const WorkspacesHubPage = lazyPage(loadWorkspacesHubPage, "WorkspacesHubPage");
const PRELOAD_ROUTE_MODULES = [
  loadApprovalsPage,
  loadCommandPalette,
  loadDevDiagnosticsPanel,
  loadGeneralHubPage,
  loadIntegrationsHubPage,
  loadPromptLabPage,
  loadRuntimeHubPage,
  loadTasksPage,
  loadTimelinePage,
  loadToolsPage,
  loadWorkspacesHubPage,
] as const;
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
        <SignalLoader label="Resolving view..." />
      </div>
    </section>
  );
}

type IdleCallbackHandle = number;
type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};
type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => { finished: Promise<void> };
};

function resolveShellThemeClass(theme: "dark" | "light"): "theme-signal-noir" | "theme-citadel-light" {
  const forcedTheme = readThemeOverrideFromLocation();
  return (forcedTheme ?? theme) === "light" ? "theme-citadel-light" : "theme-signal-noir";
}

function readThemeOverrideFromLocation(): "dark" | "light" | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("theme")?.trim().toLowerCase();
  if (value === "light" || value === "citadel-light" || value === "theme-citadel-light") {
    return "light";
  }
  if (value === "dark" || value === "signal-noir" || value === "theme-signal-noir") {
    return "dark";
  }
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
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

function resolveShellRailDefaultSize(navMode: "expanded" | "compact" | "icon"): number {
  switch (navMode) {
    case "compact":
      return 176;
    case "icon":
      return 92;
    case "expanded":
    default:
      return 264;
  }
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
    navMode,
    setNavMode,
    showTechnicalDetails,
    setShowTechnicalDetails,
    detailPanelPinned,
    setDetailPanelPinned,
    statusCenterExpanded,
    setStatusCenterExpanded,
    activeWorkspaceId,
    setActiveWorkspaceId,
    theme,
    setTheme,
  } = useUiPreferences();
  const [route, setRoute] = useState<ResolvedRoute>(() => readRouteFromLocation());
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
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
  const [operateProviderModelSummary, setOperateProviderModelSummary] = useState<string | null>(null);
  const [desktopShellRail, setDesktopShellRail] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(min-width: 1100px)").matches;
  });
  const [compactShellNav, setCompactShellNav] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [detailPanelEntry, setDetailPanelEntry] = useState<ShellDetailPanelEntry | null>(null);
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and access policy.",
  });
  const [gatewayAccessBusy, setGatewayAccessBusy] = useState(true);
  const [gatewayAccessRunId, setGatewayAccessRunId] = useState(0);
  const [gatewayAccessAutoRetryPending, setGatewayAccessAutoRetryPending] = useState(false);
  const gatewayAccessAutoRetryTimerRef = useRef<number | null>(null);
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const stackedShellDetailPanel = useMediaQuery("(max-width: 1279px)");
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

  const navigate = useCallback(
    (nextRoute: ResolvedRoute) => {
      const normalizedRoute = normalizeResolvedRoute(nextRoute);
      const updateRoute = () => {
        startTransition(() => {
          setRoute(normalizedRoute);
        });
      };

      if (effectiveEffectsMode === "full" && typeof document !== "undefined") {
        const transitionDocument = document as ViewTransitionDocument;
        if (typeof transitionDocument.startViewTransition === "function") {
          void transitionDocument
            .startViewTransition(() => {
              updateRoute();
            })
            .finished.catch(() => undefined);
          return;
        }
      }

      updateRoute();
    },
    [effectiveEffectsMode],
  );

  useEffect(() => {
    if (typeof window === "undefined" || gatewayAccess.status !== "ready") {
      return undefined;
    }

    const idleWindow = window as IdleWindow;
    let cancelled = false;
    const preload = () => {
      if (cancelled) {
        return;
      }
      void Promise.allSettled(PRELOAD_ROUTE_MODULES.map((loader) => loader()));
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(
        () => {
          preload();
        },
        { timeout: 2_000 },
      );
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(preload, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [gatewayAccess.status]);

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
    const desktopMedia = window.matchMedia("(min-width: 1100px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setCompactShellNav(event.matches);
    };
    const handleDesktopChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setDesktopShellRail(event.matches);
    };

    handleChange(media);
    handleDesktopChange(desktopMedia);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      desktopMedia.addEventListener("change", handleDesktopChange);
      return () => {
        media.removeEventListener("change", handleChange);
        desktopMedia.removeEventListener("change", handleDesktopChange);
      };
    }
    media.addListener(handleChange);
    desktopMedia.addListener(handleDesktopChange);
    return () => {
      media.removeListener(handleChange);
      desktopMedia.removeListener(handleDesktopChange);
    };
  }, []);

  useEffect(() => {
    if (detailPanelPinned) {
      setDetailPanelOpen(true);
    }
  }, [detailPanelPinned]);

  useEffect(() => {
    if (detailPanelEntry) {
      return;
    }
    if (!detailPanelPinned) {
      setDetailPanelOpen(false);
    }
  }, [detailPanelEntry, detailPanelPinned]);

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
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") !== "pwa" || params.size !== 1) {
      return;
    }
    const savedSearch = window.localStorage.getItem(LAST_ROUTE_STORAGE_KEY)?.trim();
    if (!savedSearch || savedSearch === window.location.search) {
      return;
    }
    const url = new URL(window.location.href);
    window.history.replaceState(null, "", `${url.pathname}${savedSearch}${url.hash}`);
    setRoute(readRouteFromLocation());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setInstallPromptEvent(null);
      pushNotification("success", "Mission Control installed and ready from your launcher.", "pwa-install");
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [pushNotification]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    const search = buildRouteSearch(route);
    const persistedSearch = buildPersistedRouteSearch(route);
    window.history.replaceState(null, "", `${url.pathname}${search}${url.hash}`);
    window.localStorage.setItem(LAST_ROUTE_STORAGE_KEY, persistedSearch);
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
  const currentPageDescription = PAGE_META[route.page].description;
  const detailPanelVisible = Boolean(detailPanelEntry) && (detailPanelPinned || detailPanelOpen);
  const handleToggleDetailPanel = useCallback(() => {
    setDetailPanelOpen((current) => !current);
  }, []);
  const handleInstallApp = useCallback(async () => {
    if (!installPromptEvent) {
      return;
    }
    await installPromptEvent.prompt();
    await installPromptEvent.userChoice.catch(() => undefined);
    setInstallPromptEvent(null);
  }, [installPromptEvent]);
  const handleTogglePinnedDetailPanel = useCallback(() => {
    setDetailPanelPinned(!detailPanelPinned);
    if (!detailPanelPinned) {
      setDetailPanelOpen(true);
    }
  }, [detailPanelPinned, setDetailPanelPinned]);
  const handleCycleNavMode = useCallback(() => {
    setNavMode(cycleShellNavMode(navMode));
  }, [navMode, setNavMode]);
  const operateApprovalsCount = deriveShellApprovalCount(operateStatus, localApprovalPromptCount);
  const operateActiveAgentsCount = operateStatus?.activeSubagents ?? 0;
  const operateDailyCostUsd = operateStatus?.dailyCostUsd ?? 0;
  const operateOpenTasksCount = (operateStatus?.taskStatusCounts ?? []).reduce(
    (sum, item) => (item.status === "done" ? sum : sum + item.count),
    0,
  );
  const operateStatusFreshness = deriveOperateStatusFreshness(operateStatusLastSuccessAt, operateStatusLastError);
  const approvalsChipLabel =
    operateApprovalsCount > 0
      ? `${operateApprovalsCount} approval${operateApprovalsCount === 1 ? "" : "s"}`
      : operateStatusFreshness.state === "stale"
        ? "Approvals stale"
        : "Approvals clear";

  const operateSurfaceTab = route.space === "operate" && route.page === "surface" ? (route.surface ?? "chat") : "chat";
  const timelineTab = deriveTimelineTab(route);
  const healthTab = deriveHealthTab(route);

  const observeArtifactsTab =
    route.space === "observe" && route.page === "artifacts" ? ((route.tab ?? "memory") as ArtifactsTab) : "memory";
  const generalTab = deriveGeneralTab(route);
  const workspacesTab = deriveWorkspacesTab(route);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (paletteOpen || diagnosticsOpen || activeDeviceAccessPrompt || activeRemoteApprovalPrompt) {
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        handleCycleNavMode();
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        handleToggleDetailPanel();
        return;
      }
      if ((event.key === "\\" && event.shiftKey) || event.key === "|") {
        event.preventDefault();
        handleTogglePinnedDetailPanel();
        return;
      }
      if (route.space === "operate" && (event.key === "1" || event.key === "2" || event.key === "3")) {
        event.preventDefault();
        navigate({
          space: "operate",
          page: "surface",
          surface: event.key === "1" ? "chat" : event.key === "2" ? "cowork" : "code",
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeDeviceAccessPrompt,
    activeRemoteApprovalPrompt,
    diagnosticsOpen,
    handleCycleNavMode,
    handleToggleDetailPanel,
    handleTogglePinnedDetailPanel,
    navigate,
    paletteOpen,
    route.space,
  ]);

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
      ? `${operateActiveAgentsCount} runtime${operateActiveAgentsCount === 1 ? "" : "s"}`
      : "No runtime";
  const workTrustDescriptor = useMemo<WorkTrustDescriptor>(
    () => ({
      workspaceLabel: activeWorkspaceName.trim().length > 0 ? activeWorkspaceName : "Workspace unavailable",
      gatewayTone: shellGatewayState.tone,
      gatewayLabel: shellGatewayState.label,
      approvalsSummary: approvalsChipLabel,
      activeModeLabel:
        route.space === "operate" && route.page === "surface"
          ? CHAT_MODE_PRESETS[operateSurfaceTab].label
          : currentPageLabel,
      providerModelSummary: operateProviderModelSummary ?? "Provider routing pending",
      runtimeSummary: runtimeSummaryLabel,
    }),
    [
      activeWorkspaceName,
      approvalsChipLabel,
      currentPageLabel,
      operateProviderModelSummary,
      operateSurfaceTab,
      route.page,
      route.space,
      runtimeSummaryLabel,
      shellGatewayState.label,
      shellGatewayState.tone,
    ],
  );

  const shellStatusSummary = useMemo<ShellStatusSummary>(() => {
    const spendLabel =
      operateDailyCostUsd > 0 ? `$${operateDailyCostUsd.toFixed(operateDailyCostUsd >= 10 ? 1 : 2)}` : "$0.00";
    const decisionLabel =
      operateApprovalsCount > 0
        ? `${operateApprovalsCount} decision${operateApprovalsCount === 1 ? "" : "s"} waiting`
        : operateStatusFreshness.state === "stale"
          ? "Status needs review"
          : "Decisions clear";

    return {
      tone:
        operateApprovalsCount > 0
          ? "warning"
          : shellGatewayState.status === "degraded-live-updates" || operateStatusFreshness.state === "stale"
            ? "warning"
            : "success",
      label: decisionLabel,
      note:
        operateStatusFreshness.state === "stale"
          ? operateStatusFreshness.note
          : (shellGatewayState.summary ?? "Routing, approvals, and runtime posture are in sync."),
      approvalCount: operateApprovalsCount,
      sections: [
        {
          id: "system-health",
          title: "System health",
          summary: shellGatewayState.label,
          entries: [
            {
              id: "gateway",
              label: "Gateway",
              value: shellGatewayState.label,
              note: shellGatewayState.nextStep,
              tone: shellGatewayState.tone,
            },
            {
              id: "freshness",
              label: "Freshness",
              value: operateStatusFreshness.state === "live" ? "Live snapshot" : "Needs refresh",
              note: operateStatusFreshness.note,
              tone: operateStatusFreshness.state === "live" ? "success" : "warning",
            },
          ],
        },
        {
          id: "runtime-routing",
          title: "Runtime and routing",
          summary: runtimeSummaryLabel,
          entries: [
            {
              id: "runtime",
              label: "Runtime posture",
              value: runtimeSummaryLabel,
              note: operateProviderModelSummary ?? "Provider routing pending",
              tone: operateActiveAgentsCount > 0 ? "success" : "muted",
            },
            {
              id: "workspace",
              label: "Workspace",
              value: activeWorkspaceName.trim().length > 0 ? activeWorkspaceName : "Workspace unavailable",
              note:
                route.space === "operate" && route.page === "surface"
                  ? CHAT_MODE_PRESETS[operateSurfaceTab].label
                  : currentPageLabel,
              tone: "default",
            },
          ],
        },
        {
          id: "decisions-approvals",
          title: "Decisions and approvals",
          summary: approvalsChipLabel,
          entries: [
            {
              id: "approvals",
              label: "Approvals",
              value: approvalsChipLabel,
              note:
                operateApprovalsCount > 0
                  ? "Open the queue to review pending decisions."
                  : "No approvals are waiting for operator action.",
              tone: operateApprovalsCount > 0 ? "warning" : "success",
              actionLabel: "Open queue",
            },
            {
              id: "tasks",
              label: "Open tasks",
              value: String(operateOpenTasksCount),
              note:
                operateOpenTasksCount > 0 ? "Review linked work and blockers." : "No open tasks in the shared queue.",
              tone: operateOpenTasksCount > 0 ? "live" : "muted",
              actionLabel: "Open tasks",
            },
          ],
        },
        {
          id: "activity-spend",
          title: "Activity and spend",
          summary: `${spendLabel} today`,
          entries: [
            {
              id: "spend",
              label: "Spend today",
              value: spendLabel,
              note: "Tracked provider and runtime usage for the current dashboard window.",
              tone: "default",
              actionLabel: "Open health",
            },
            {
              id: "agents",
              label: "Active agents",
              value: String(operateActiveAgentsCount),
              note:
                operateActiveAgentsCount > 0
                  ? "Inspect current roster and live board activity."
                  : "No agents are actively running right now.",
              tone: operateActiveAgentsCount > 0 ? "live" : "muted",
              actionLabel: "Open agents",
            },
          ],
        },
      ],
    };
  }, [
    activeWorkspaceName,
    approvalsChipLabel,
    currentPageLabel,
    operateActiveAgentsCount,
    operateApprovalsCount,
    operateDailyCostUsd,
    operateOpenTasksCount,
    operateProviderModelSummary,
    operateStatusFreshness.note,
    operateStatusFreshness.state,
    operateSurfaceTab,
    route.page,
    route.space,
    runtimeSummaryLabel,
    shellGatewayState.label,
    shellGatewayState.nextStep,
    shellGatewayState.status,
    shellGatewayState.summary,
    shellGatewayState.tone,
  ]);

  const handleShellStatusEntryAction = useCallback(
    (entry: ShellStatusEntry) => {
      switch (entry.id) {
        case "approvals":
          navigate({ space: "operate", page: "approvals" });
          break;
        case "tasks":
          navigate({ space: "operate", page: "tasks" });
          break;
        case "spend":
          handleSelectVisiblePage("health");
          break;
        case "agents":
          navigate({ space: "configure", page: "agents", tab: "overview" });
          break;
        default:
          break;
      }
    },
    [handleSelectVisiblePage, navigate],
  );

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
              onNavigateSurface={(surface, options) =>
                navigate({
                  space: "operate",
                  page: "surface",
                  surface,
                  sessionId: options?.sessionId ?? undefined,
                  turnId: options?.turnId ?? undefined,
                  artifactId: options?.artifactId ?? undefined,
                })
              }
            />
          </section>
        );
      }
      if (route.page === "tasks") {
        return (
          <ShellPageFrame title="Tasks" subtitle="Track active work, blockers, and linked sessions from one queue.">
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
            showTechnicalDetails={showTechnicalDetails}
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
            onOpenGeneratedArtifact={(artifact) =>
              navigate({
                space: "operate",
                page: "surface",
                surface: artifact.sourceSurface,
                sessionId: artifact.sessionId,
                turnId: artifact.turnId,
                artifactId: artifact.artifactId,
              })
            }
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
          workspaceId={activeWorkspaceId}
          sessionId={route.sessionId}
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
    route.sessionId,
    route.space,
    route.surface,
    showTechnicalDetails,
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
  const shellThemeClass = resolveShellThemeClass(theme);
  const pageErrorResetKey = `${route.space}:${route.page}:${route.tab ?? ""}`;
  const useResizableShellLayout = desktopShellRail && !stackedShellDetailPanel;
  const shellRailDefaultSize = resolveShellRailDefaultSize(navMode);
  const shellWorkspace = (
    <div className="shell-workspace">
      {route.space === "operate" && route.page === "surface" && onboardingComplete === false ? (
        <div className="status-banner warning">
          Onboarding still needs attention. Work surfaces stay available, but finish the configuration checklist before
          trusting provider, access, or runtime defaults.
          <button
            type="button"
            className="gc-button"
            onClick={() => navigate({ space: "configure", page: "settings", tab: "onboarding" })}
          >
            Open onboarding
          </button>
        </div>
      ) : null}
      <PageErrorBoundary
        resetKey={pageErrorResetKey}
        pageLabel={currentPageLabel}
        onReturnToChat={() => navigate(DEFAULT_ROUTE)}
      >
        <Suspense fallback={<PageLoadingFallback label={currentPageLabel} />}>{content}</Suspense>
      </PageErrorBoundary>
    </div>
  );
  const shellDetailPane =
    detailPanelEntry && detailPanelVisible ? (
      <SideInspectorDrawer
        kicker={detailPanelEntry.kicker}
        title={detailPanelEntry.title}
        subtitle={detailPanelEntry.subtitle}
        open={detailPanelVisible}
        pinned={detailPanelPinned}
        onClose={() => setDetailPanelOpen(false)}
        onTogglePinned={handleTogglePinnedDetailPanel}
        actions={detailPanelEntry.actions}
        className="shell-detail-panel"
      >
        {detailPanelEntry.body}
      </SideInspectorDrawer>
    ) : null;

  return (
    <ShellDetailPanelProvider
      isOpen={detailPanelPinned || detailPanelOpen}
      onOpenPanel={() => setDetailPanelOpen(true)}
      onClosePanel={() => setDetailPanelOpen(false)}
      onActiveEntryChange={setDetailPanelEntry}
    >
      <div
        className={`app-shell layout-shell mc-app-shell ${shellThemeClass} ui-mode-${uiMode} ui-density-${density} ui-effects-${effectiveEffectsMode}${showTechnicalDetails ? "" : " ui-hide-technical"}`}
        data-density={density}
        data-effects-mode={effectsMode}
        data-effective-effects-mode={effectiveEffectsMode}
      >
        <header className="shell-bar mc-shell-bar">
          <div className="shell-bar-brand">
            <div className="shell-bar-brand-copy">
              <p className="shell-bar-kicker">GoatCitadel</p>
              <div className="shell-bar-title-row">
                <h1 className="shell-bar-title">Mission Control</h1>
                <div className="shell-bar-route-pills" aria-label="Current location">
                  <span className="shell-bar-route-pill">{SPACE_META[route.space].label}</span>
                  <span className="shell-bar-route-pill secondary">{currentPageLabel}</span>
                </div>
              </div>
              <p className="shell-bar-page-note shell-bar-page-note-inline">{currentPageDescription}</p>
            </div>
          </div>
          <div className="shell-bar-actions mc-shell-bar-actions">
            <nav className="space-nav" aria-label="Mission Control spaces">
              {(Object.keys(SPACE_META) as Space[]).map((space) => (
                <button
                  key={space}
                  type="button"
                  className={`space-nav-item gc-nav-button gc-nav-tier-space mc-shell-chip${route.space === space ? " active" : ""}`}
                  onClick={() => handleSelectSpace(space)}
                >
                  {SPACE_META[space].label}
                </button>
              ))}
            </nav>
            <label className="shell-workspace-picker">
              <span className="shell-action-label">Workspace</span>
              <GCSelect value={activeWorkspaceId} onChange={setActiveWorkspaceId} options={workspaceSelectOptions} />
            </label>
            <div className="shell-bar-utility mc-shell-bar-utility">
              {installPromptEvent ? (
                <button
                  type="button"
                  className="gc-nav-button gc-nav-tier-chip mc-shell-chip"
                  onClick={() => void handleInstallApp()}
                >
                  Install app
                </button>
              ) : null}
              <button
                type="button"
                className="shell-command-trigger-topbar gc-nav-button gc-nav-tier-chip mc-shell-chip"
                onClick={() => setPaletteOpen(true)}
              >
                Command Palette
              </button>
              <ShellStatusCenter
                summary={shellStatusSummary}
                expanded={statusCenterExpanded}
                onToggle={() => setStatusCenterExpanded(!statusCenterExpanded)}
                onEntryAction={handleShellStatusEntryAction}
              />
              {detailPanelEntry ? (
                <button
                  type="button"
                  className={`shell-detail-toggle gc-nav-button gc-nav-tier-chip mc-shell-chip${detailPanelVisible ? " active" : ""}`}
                  aria-expanded={detailPanelVisible}
                  onClick={handleToggleDetailPanel}
                >
                  {detailPanelVisible ? "Hide details" : "Show details"}
                </button>
              ) : null}
              <button
                type="button"
                className="shell-theme-toggle gc-nav-button gc-nav-tier-chip mc-shell-chip"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                {theme === "dark" ? "🌙" : "☀️"}
              </button>
              <button
                type="button"
                className="shell-settings-trigger gc-nav-button gc-nav-tier-chip mc-shell-chip"
                onClick={() => navigate({ space: "configure", page: "settings", tab: "general" })}
                title="Settings"
                aria-label="Settings"
              >
                ⚙️
              </button>
            </div>
          </div>
        </header>

        {!desktopShellRail ? (
          <div className={`shell-secondary-nav mc-shell-secondary-nav${compactShellNav ? " compact" : ""}`}>
            <div className="shell-secondary-nav-primary mc-shell-secondary-nav-primary">
              <div className="shell-context-summary">
                <p className="shell-bar-page-label">{SPACE_META[route.space].label}</p>
                <p className="shell-bar-page-note">{currentPageLabel}</p>
              </div>
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
                      className={`${route.space === "operate" ? "surface-nav-item" : "secondary-page-nav-item"} gc-nav-button gc-nav-tier-page mc-shell-chip${visiblePage === item.page ? " active" : ""}`}
                      onClick={() => handleSelectVisiblePage(item.page)}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
              )}
            </div>
          </div>
        ) : (
          <div className="shell-secondary-nav mc-shell-secondary-nav is-rail-driven">
            <div className="shell-secondary-nav-primary mc-shell-secondary-nav-primary">
              <nav
                className={route.space === "operate" ? "surface-nav" : "secondary-page-nav"}
                aria-label={`${SPACE_META[route.space].label} pages`}
              >
                {VISIBLE_SPACE_PAGES[route.space].map((item) => (
                  <button
                    key={item.page}
                    type="button"
                    className={`${route.space === "operate" ? "surface-nav-item" : "secondary-page-nav-item"} gc-nav-button gc-nav-tier-page mc-shell-chip${visiblePage === item.page ? " active" : ""}`}
                    onClick={() => handleSelectVisiblePage(item.page)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        )}

        <main className="shell-main mc-shell-main">
          {notifications.length > 0 ? (
            <div className="shell-notification-region">
              <NotificationStack
                items={notifications}
                onDismiss={(id) => setNotifications((current) => current.filter((item) => item.id !== id))}
              />
            </div>
          ) : null}
          <div
            className={`shell-main-layout mc-shell-main-layout${desktopShellRail ? " with-rail" : ""}${detailPanelVisible ? " with-detail-panel" : ""}${useResizableShellLayout ? " is-resizable" : ""}`}
          >
            {useResizableShellLayout ? (
              <ResizablePaneLayout
                storageKey={`shell.main.${navMode}${shellDetailPane ? ".detail" : ""}`}
                className="shell-main-resizable"
                panes={[
                  {
                    id: "rail",
                    defaultSize: shellRailDefaultSize,
                    minSize: navMode === "icon" ? 74 : navMode === "compact" ? 148 : 220,
                    maxSize: navMode === "icon" ? 112 : navMode === "compact" ? 248 : 340,
                    className: "shell-main-pane shell-main-pane-rail",
                    children: (
                      <ShellNavRail
                        route={route}
                        visiblePage={visiblePage}
                        navMode={navMode}
                        approvalsCount={operateApprovalsCount}
                        onSelectSpace={handleSelectSpace}
                        onSelectVisiblePage={handleSelectVisiblePage}
                        onCycleNavMode={handleCycleNavMode}
                      />
                    ),
                  },
                  {
                    id: "workspace",
                    minSize: 640,
                    className: "shell-main-pane shell-main-pane-workspace",
                    children: shellWorkspace,
                  },
                  ...(shellDetailPane
                    ? [
                        {
                          id: "detail",
                          defaultSize: 360,
                          minSize: 300,
                          maxSize: 460,
                          className: "shell-main-pane shell-main-pane-detail",
                          children: shellDetailPane,
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              <>
                {desktopShellRail ? (
                  <ShellNavRail
                    route={route}
                    visiblePage={visiblePage}
                    navMode={navMode}
                    approvalsCount={operateApprovalsCount}
                    onSelectSpace={handleSelectSpace}
                    onSelectVisiblePage={handleSelectVisiblePage}
                    onCycleNavMode={handleCycleNavMode}
                  />
                ) : null}
                {shellWorkspace}
                {detailPanelEntry ? shellDetailPane : null}
              </>
            )}
          </div>
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
    </ShellDetailPanelProvider>
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
