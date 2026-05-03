import { Suspense, startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  BookOpenText,
  Code2,
  FolderKanban,
  LibraryBig,
  Menu,
  MoonStar,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  SlidersHorizontal,
  SunMedium,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import type { DashboardStateResponse, HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  connectEventStream,
  consumeGatewayAccessBootstrapFromLocation,
  fetchWorkspaces,
  getGatewayApiBaseUrl,
  preflightGatewayAccess,
  type EventStreamConnectionState,
  type GatewayAccessPreflightResult,
} from "@goatcitadel/mission-control-shared/api/shell-client";
import { fetchDashboardState, fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/client";
import { GatewayAccessGate } from "@goatcitadel/mission-control-shared/components/GatewayAccessGate";
import {
  NotificationStack,
  upsertNotificationItem,
  type NotificationItem,
} from "@goatcitadel/mission-control-shared/components/NotificationStack";
import { PageErrorBoundary } from "@goatcitadel/mission-control-shared/components/PageErrorBoundary";
import { SideInspectorDrawer } from "@goatcitadel/mission-control-shared/components/SideInspectorDrawer";
import {
  ShellDetailPanelProvider,
  type ShellDetailPanelEntry,
} from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { resolveEffectiveEffectsMode } from "@goatcitadel/mission-control-shared/state/effects-mode";
import { emitRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import {
  publishEventStreamStatus,
  resetEventStreamStatus,
} from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import {
  deriveRealtimeNotification,
  deriveRealtimeRefresh,
  type RealtimeTruthMode,
} from "@goatcitadel/mission-control-shared/state/realtime-derived";
import {
  LazyNativeRoutePages,
  LazyPromptPacksWorkbenchPage,
  LazyThreadedSurfaceRoute,
  preloadThreadedSurfaceRoute,
} from "./lazy-legacy-pages";
import { BlocksShuffleLoader } from "../components/BlocksShuffleLoader";
import {
  AREA_META,
  RAIL_ITEMS,
  buildAppHref,
  buildNavigationTarget,
  getRouteDescription,
  getRouteLabel,
  isRailItemActive,
  normalizeAppRoute,
  type AppRoute,
  type PrimaryArea,
  type RailItem,
} from "./route-model";
import { coerceLegacyHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";

type GatewayAccessViewState =
  | GatewayAccessPreflightResult
  | {
      status: "checking";
      message: string;
      healthDetail?: string;
      authMode?: "none" | "basic" | "token";
    };

type ShellStatusState = {
  dashboard: DashboardStateResponse | null;
  health: HealthSummaryResponse | null;
  lastLoadedAt: number | null;
  error: string | null;
};

type RailSection = {
  id: string;
  label?: string;
  items: RailItem[];
};

const PRIMARY_NAV: Array<{ area: PrimaryArea; icon: typeof Bot }> = [
  { area: "chat", icon: Bot },
  { area: "cowork", icon: Workflow },
  { area: "code", icon: Code2 },
  { area: "library", icon: LibraryBig },
  { area: "ops", icon: Activity },
  { area: "settings", icon: SlidersHorizontal },
];

export function MissionControlNextApp() {
  const {
    mode,
    density,
    effectsMode,
    showTechnicalDetails,
    detailPanelPinned,
    setDetailPanelPinned,
    activeWorkspaceId,
    setActiveWorkspaceId,
    theme,
    setTheme,
  } = useUiPreferences();
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const [route, setRoute] = useState<AppRoute>(() => resolveRouteFromLocation(window.location.href));
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<ShellDetailPanelEntry | null>(null);
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and Mission Control access policy.",
  });
  const [gatewayBusy, setGatewayBusy] = useState(true);
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [streamTruthMode, setStreamTruthMode] = useState<RealtimeTruthMode>("authoritative");
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ workspaceId: string; name: string }>>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [status, setStatus] = useState<ShellStatusState>({
    dashboard: null,
    health: null,
    lastLoadedAt: null,
    error: null,
  });

  const navigate = useCallback((nextRoute: AppRoute, options?: { replace?: boolean }) => {
    const normalized = normalizeAppRoute(nextRoute);
    const href = buildAppHref(normalized);
    const mutate = options?.replace ? window.history.replaceState : window.history.pushState;
    mutate.call(window.history, {}, "", href);
    startTransition(() => {
      setRoute(normalized);
    });
    setNavOpen(false);
  }, []);

  const shellThemeClass = resolveShellThemeClass(route.theme === "light" ? "light" : theme);
  const currentAreaMeta = AREA_META[route.area];
  const currentRailItems = RAIL_ITEMS[route.area];
  const groupedRailItems = useMemo(
    () => buildRailSections(route.area, currentRailItems),
    [route.area, currentRailItems],
  );
  const currentRouteLabel = getRouteLabel(route);
  const currentRouteDescription = getRouteDescription(route);
  const realtimeStatusCopy = useMemo(
    () => describeRealtimeTruthUi(streamState, streamTruthMode),
    [streamState, streamTruthMode],
  );
  const isWorkArea = route.area === "chat" || route.area === "cowork" || route.area === "code";
  const immersiveRoute = isImmersiveRoute(route);
  const usesFullStageLayout = isWorkArea || immersiveRoute;
  const showStageHeader = !usesFullStageLayout && !usesEmbeddedRouteHeader(route);
  const hasVisibleInspector = detailPanelPinned || inspectorOpen;
  const activeWorkspaceName =
    workspaceOptions.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? activeWorkspaceId;
  const passiveInspectorEntry = useMemo<ShellDetailPanelEntry>(() => {
    const pendingApprovals = status.dashboard?.pendingApprovals ?? 0;
    const taskBacklog = (status.dashboard?.taskStatusCounts ?? [])
      .filter((item) => item.status !== "done")
      .reduce((sum, item) => sum + item.count, 0);
    return {
      id: "mc-next-route-context",
      kicker: currentAreaMeta.kicker,
      title: currentRouteLabel,
      subtitle: (
        <div className="mc-next-inspector-subtitle">
          <span>{activeWorkspaceName}</span>
          <span>{currentRouteDescription}</span>
        </div>
      ),
      actions: null,
      body: (
        <div className="mc-next-inspector-stack">
          <div className="mc-next-inline-metrics">
            <div>
              <strong>{pendingApprovals}</strong>
              <span>Pending approvals</span>
            </div>
            <div>
              <strong>{taskBacklog}</strong>
              <span>Open tasks</span>
            </div>
            <div>
              <strong>{status.dashboard?.activeSubagents ?? 0}</strong>
              <span>Active subagents</span>
            </div>
          </div>
          <section className="mc-next-inspector-section">
            <h4>Focus</h4>
            <p>{currentRouteDescription}</p>
          </section>
          <section className="mc-next-inspector-section">
            <h4>Keep in view</h4>
            <ul className="mc-next-inspector-list">
              <li>Workspace: {activeWorkspaceName}</li>
              <li>Area: {currentAreaMeta.label}</li>
              <li>Realtime: {realtimeStatusCopy.inspector}</li>
            </ul>
          </section>
        </div>
      ),
    };
  }, [
    activeWorkspaceName,
    currentAreaMeta.kicker,
    currentAreaMeta.label,
    currentRouteDescription,
    currentRouteLabel,
    realtimeStatusCopy.inspector,
    status.dashboard,
  ]);
  const inspectorEntry = detailEntry ?? passiveInspectorEntry;
  const pendingApprovals = status.dashboard?.pendingApprovals ?? 0;
  const railSignalTitle = route.area === "settings" ? "Configuration posture" : "Operator posture";
  const railSignalLines =
    route.area === "settings"
      ? [`${activeWorkspaceName} active`, `${pendingApprovals} approvals waiting`, realtimeStatusCopy.rail]
      : [
          `${status.dashboard?.sessions.length ?? 0} recent sessions`,
          `${status.dashboard?.activeSubagents ?? 0} active subagents`,
          `${formatUsd(status.dashboard?.dailyCostUsd ?? 0)} daily spend`,
        ];

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

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const syncShellStatus = useCallback(async () => {
    try {
      const [dashboard, health] = await Promise.all([fetchDashboardState(), fetchHealthSummary()]);
      setStatus({
        dashboard,
        health,
        lastLoadedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      setStatus((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to refresh shell status.",
      }));
    }
  }, []);

  const loadWorkspaceOptions = useCallback(async () => {
    try {
      const response = await fetchWorkspaces("all", 400);
      setWorkspaceOptions(
        response.items.map((item) => ({
          workspaceId: item.workspaceId,
          name: item.name,
        })),
      );
      if (!response.items.some((item) => item.workspaceId === activeWorkspaceId)) {
        const fallbackWorkspaceId = response.items[0]?.workspaceId;
        if (fallbackWorkspaceId) {
          setActiveWorkspaceId(fallbackWorkspaceId);
        }
      }
    } catch {
      setWorkspaceOptions([]);
    }
  }, [activeWorkspaceId, setActiveWorkspaceId]);

  const retryGatewayAccess = useCallback(async () => {
    setGatewayBusy(true);
    try {
      const bootstrap = consumeGatewayAccessBootstrapFromLocation();
      const next = await preflightGatewayAccess({ bootstrap });
      setGatewayAccess(next);
    } catch (error) {
      setGatewayAccess({
        status: "unreachable",
        message: error instanceof Error ? error.message : "Gateway preflight failed.",
        healthDetail: getGatewayApiBaseUrl(),
      });
    } finally {
      setGatewayBusy(false);
    }
  }, []);

  useEffect(() => {
    const nextHref = coerceLegacyHrefToNext(window.location.href);
    if (nextHref && nextHref !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState({}, "", nextHref);
      setRoute(resolveRouteFromLocation(window.location.href));
      return;
    }
    setRoute(resolveRouteFromLocation(window.location.href));
  }, []);

  useEffect(() => {
    if (route.area === "ops" && route.section === "quality") {
      navigate(
        {
          area: "library",
          section: "prompt-packs",
          sessionId: route.sessionId,
          turnId: route.turnId,
          artifactId: route.artifactId,
          approvalId: route.approvalId,
          view: route.view,
          theme: route.theme,
        },
        { replace: true },
      );
    }
  }, [navigate, route]);

  useEffect(() => {
    if (route.area === "chat" || route.area === "cowork" || route.area === "code") {
      void preloadThreadedSurfaceRoute();
    }
  }, [route.area]);

  useEffect(() => {
    void retryGatewayAccess();
  }, [retryGatewayAccess]);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(resolveRouteFromLocation(window.location.href));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("wa-theme-default", "wa-palette-default", "wa-brand-blue");
    return () => {
      document.documentElement.classList.remove("wa-theme-default", "wa-palette-default", "wa-brand-blue");
    };
  }, []);

  useEffect(() => {
    const themeClasses = ["theme-signal-noir", "theme-citadel-light"];
    document.documentElement.classList.remove(...themeClasses);
    document.body.classList.remove(...themeClasses);
    document.documentElement.classList.add(shellThemeClass);
    document.body.classList.add(shellThemeClass);
    return () => {
      document.documentElement.classList.remove(...themeClasses);
      document.body.classList.remove(...themeClasses);
    };
  }, [shellThemeClass]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setWorkspaceOptions([]);
      setStatus({
        dashboard: null,
        health: null,
        lastLoadedAt: null,
        error: null,
      });
      return;
    }
    void Promise.all([loadWorkspaceOptions(), syncShellStatus()]);
  }, [gatewayAccess.status, loadWorkspaceOptions, syncShellStatus]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void syncShellStatus();
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [gatewayAccess.status, syncShellStatus]);

  useEffect(() => {
    if (gatewayAccess.status !== "ready") {
      setStreamState("closed");
      resetEventStreamStatus();
      return;
    }

    const close = connectEventStream(
      (event) => {
        const derivedRefresh = deriveRealtimeRefresh(event, { defaultTopics: ["surface"] });
        for (const topic of derivedRefresh.topics) {
          emitRefresh(topic, {
            reason: derivedRefresh.signalReason,
            source: event.source,
            eventType: derivedRefresh.signalEventType,
            eventId: event.eventId,
            timestamp: Date.now(),
          });
        }
        setStreamTruthMode(derivedRefresh.truthMode);
        const notification = deriveRealtimeNotification(event);
        if (notification) {
          pushNotification(notification.tone, notification.message, notification.groupKey);
        }
      },
      (nextState) => {
        setStreamState(nextState);
        if (nextState === "closed") {
          setStreamTruthMode("authoritative");
        }
      },
      publishEventStreamStatus,
    );

    return () => {
      close();
      resetEventStreamStatus();
    };
  }, [gatewayAccess.status, pushNotification]);

  useEffect(() => {
    if (detailEntry) {
      setInspectorOpen(true);
    }
  }, [detailEntry]);

  useEffect(() => {
    document.title = `GoatCitadel ${currentRouteLabel}`;
  }, [currentRouteLabel]);

  if (gatewayAccess.status !== "ready") {
    return (
      <GatewayAccessGate
        gatewayBaseUrl={getGatewayApiBaseUrl()}
        access={gatewayAccess}
        busy={gatewayBusy}
        onRetry={retryGatewayAccess}
      />
    );
  }

  const pageErrorResetKey = buildAppHref(route);
  const routeContent = renderRouteContent({
    route,
    activeWorkspaceId,
    activeWorkspaceName,
    pendingApprovals,
    navigate,
    setActiveWorkspaceId,
  });

  return (
    <ShellDetailPanelProvider
      isOpen={detailPanelPinned || inspectorOpen}
      onOpenPanel={() => setInspectorOpen(true)}
      onClosePanel={() => setInspectorOpen(false)}
      onActiveEntryChange={setDetailEntry}
    >
      <div
        className={[
          "mc-next-shell",
          shellThemeClass,
          `ui-mode-${mode}`,
          `ui-density-${density}`,
          `ui-effects-${effectiveEffectsMode}`,
          showTechnicalDetails ? "" : "ui-hide-technical",
        ]
          .filter(Boolean)
          .join(" ")}
        data-area={route.area}
        data-section={route.section ?? "root"}
        data-route={pageErrorResetKey.split("?")[0]}
      >
        <div className="mc-next-app-frame">
          <header className="mc-next-topbar">
            <div className="mc-next-topbar-left">
              <button type="button" className="mc-next-icon-button mc-next-nav-toggle" onClick={() => setNavOpen(true)}>
                <Menu size={16} />
                <span>Menu</span>
              </button>
              <div className="mc-next-brand">
                <p>GoatCitadel</p>
                <h1>Mission Control</h1>
              </div>
              <nav className="mc-next-primary-nav" aria-label="Primary mission areas">
                {PRIMARY_NAV.map(({ area, icon: Icon }) => (
                  <button
                    key={area}
                    type="button"
                    className={`mc-next-primary-link${route.area === area ? " active" : ""}`}
                    onClick={() =>
                      navigate({
                        area,
                        theme: route.theme ?? theme,
                        sessionId:
                          area === "chat" || area === "cowork" || area === "code" ? route.sessionId : undefined,
                        turnId: area === "chat" || area === "cowork" || area === "code" ? route.turnId : undefined,
                        artifactId:
                          area === "chat" || area === "cowork" || area === "code" ? route.artifactId : undefined,
                      })
                    }
                  >
                    <Icon size={16} />
                    <span>{AREA_META[area].label}</span>
                  </button>
                ))}
              </nav>
            </div>
            <div className="mc-next-topbar-right">
              <label className="mc-next-select-field">
                <span>Workspace</span>
                <select value={activeWorkspaceId} onChange={(event) => setActiveWorkspaceId(event.target.value)}>
                  {[...workspaceOptions, { workspaceId: activeWorkspaceId, name: activeWorkspaceName }]
                    .filter(
                      (item, index, items) =>
                        items.findIndex((candidate) => candidate.workspaceId === item.workspaceId) === index,
                    )
                    .map((item) => (
                      <option key={item.workspaceId} value={item.workspaceId}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="mc-next-topbar-status">
                <span className="mc-next-badge">{realtimeStatusCopy.badge}</span>
                <span className="mc-next-badge">{pendingApprovals} approvals</span>
              </div>
              <button
                type="button"
                className="mc-next-button mc-next-button-secondary mc-next-wa-button"
                onClick={() => setInspectorOpen((current) => !current)}
              >
                {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                {inspectorOpen ? "Hide Context" : "Open Context"}
              </button>
              <button
                type="button"
                className="mc-next-button mc-next-button-ghost"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <SunMedium size={16} /> : <MoonStar size={16} />}
                {theme === "dark" ? "Light theme" : "Dark theme"}
              </button>
            </div>
          </header>

          <div className={`mc-next-body${usesFullStageLayout ? " is-work-area" : ""}`}>
            <aside className={`mc-next-rail${navOpen ? " open" : ""}`}>
              <div className="mc-next-rail-head">
                <div>
                  <p>{currentAreaMeta.kicker}</p>
                  <h2>{currentAreaMeta.label}</h2>
                </div>
                <button type="button" className="mc-next-rail-close" onClick={() => setNavOpen(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="mc-next-rail-menu">
                {groupedRailItems.map((group) => (
                  <section key={group.id} className="mc-next-rail-section">
                    {group.label ? (
                      <div className="mc-next-rail-separator" aria-hidden="true">
                        <span>{group.label}</span>
                      </div>
                    ) : null}
                    <div className="mc-next-rail-group">
                      {group.items.map((item) => {
                        const target = buildNavigationTarget(route, item);
                        const backlogCount =
                          item.section === "tasks"
                            ? (status.dashboard?.taskStatusCounts ?? [])
                                .filter((entry) => entry.status !== "done")
                                .reduce((sum, entry) => sum + entry.count, 0)
                            : item.section === "approvals"
                              ? pendingApprovals
                              : undefined;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`mc-next-rail-link${isRailItemActive(route, item) ? " active" : ""}`}
                            onClick={() => navigate(target)}
                          >
                            <div>
                              <strong>{item.label}</strong>
                              <span>{item.description}</span>
                            </div>
                            {typeof backlogCount === "number" ? (
                              <span className="mc-next-rail-count">{backlogCount}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
              <div className="mc-next-rail-signal-card">
                <div className="mc-next-rail-signal-head">
                  <FolderKanban size={18} />
                  <span>{railSignalTitle}</span>
                </div>
                <ul>
                  {railSignalLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </aside>

            <main className={`mc-next-stage${usesFullStageLayout ? " mc-next-stage-work" : ""}`}>
              {showStageHeader ? (
                <div className="mc-next-stage-header">
                  <div>
                    <p>{currentAreaMeta.label}</p>
                    <h2>{currentRouteLabel}</h2>
                    <span>{currentRouteDescription}</span>
                  </div>
                  <div className="mc-next-stage-chips">
                    <span className="mc-next-stage-chip">{activeWorkspaceName}</span>
                    <span className={`mc-next-stage-chip${realtimeStatusCopy.degraded ? " warning" : ""}`}>
                      {realtimeStatusCopy.stage}
                    </span>
                    {status.error ? (
                      <span className="mc-next-stage-chip warning">Shell status needs refresh</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <PageErrorBoundary
                resetKey={pageErrorResetKey}
                pageLabel={currentRouteLabel}
                onReturnToChat={() => navigate({ area: "chat", theme: route.theme ?? theme })}
              >
                <Suspense
                  fallback={<RouteSurfaceFallback label={currentRouteLabel} description={currentRouteDescription} />}
                >
                  <div className="mc-next-stage-scroll">
                    <section
                      className={`space-page mc-next-surface-host${usesFullStageLayout ? " space-page-surface mc-next-surface-host-work" : ""}`}
                    >
                      {routeContent}
                    </section>
                  </div>
                </Suspense>
              </PageErrorBoundary>
            </main>
          </div>

          <button
            type="button"
            className={`mc-next-inspector-scrim${hasVisibleInspector ? " open" : ""}`}
            aria-hidden={!hasVisibleInspector}
            onClick={() => setInspectorOpen(false)}
            tabIndex={hasVisibleInspector ? 0 : -1}
          />

          {hasVisibleInspector && inspectorEntry ? (
            <SideInspectorDrawer
              kicker={inspectorEntry.kicker}
              title={inspectorEntry.title}
              subtitle={inspectorEntry.subtitle}
              open={hasVisibleInspector}
              pinned={detailPanelPinned}
              draggable
              onClose={() => setInspectorOpen(false)}
              onTogglePinned={() => setDetailPanelPinned(!detailPanelPinned)}
              actions={inspectorEntry.actions}
              className="mc-next-shell-inspector"
            >
              {inspectorEntry.body}
            </SideInspectorDrawer>
          ) : null}

          <footer className="mc-next-status-strip" aria-label="Mission Control status strip">
            <StatusPill icon={<ShieldCheck size={15} />} label={gatewayAccess.message} value="Gateway ready" />
            <StatusPill icon={<Activity size={15} />} label="Live updates" value={realtimeStatusCopy.strip} />
            <StatusPill icon={<Workflow size={15} />} label="Approvals" value={`${pendingApprovals} pending`} />
            <StatusPill
              icon={<BookOpenText size={15} />}
              label="Sessions"
              value={`${status.dashboard?.sessions.length ?? 0} visible`}
            />
            <StatusPill
              icon={<Wrench size={15} />}
              label="Spend"
              value={formatUsd(status.dashboard?.dailyCostUsd ?? 0)}
            />
            <StatusPill
              icon={<Bot size={15} />}
              label="Daemon"
              value={status.health?.daemonStatus?.running ? "Serving" : "Needs intervention"}
            />
          </footer>
        </div>

        <NotificationStack items={notifications} onDismiss={dismissNotification} />
      </div>
    </ShellDetailPanelProvider>
  );
}

function renderRouteContent(input: {
  route: AppRoute;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  pendingApprovals: number;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}): ReactNode {
  const route = normalizeAppRoute(input.route);
  if (route.area === "chat") {
    return (
      <LazyThreadedSurfaceRoute
        workspaceId={input.activeWorkspaceId}
        workspaceName={input.activeWorkspaceName}
        approvalsCount={input.pendingApprovals}
        surface="chat"
        lockSurface
        onOpenCowork={() => input.navigate({ area: "cowork", theme: route.theme, sessionId: route.sessionId })}
        onOpenCode={() => input.navigate({ area: "code", theme: route.theme, sessionId: route.sessionId })}
        onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
        onOpenApprovals={() => input.navigate({ area: "ops", section: "approvals", theme: route.theme })}
        onNavigateSurface={(surface, options) =>
          input.navigate({
            area: surface,
            theme: route.theme,
            sessionId: options?.sessionId ?? undefined,
            turnId: options?.turnId ?? undefined,
            artifactId: options?.artifactId ?? undefined,
          })
        }
      />
    );
  }

  if (route.area === "cowork") {
    if (route.section === "tasks" || route.section === "board") {
      return <LazyNativeRoutePages {...input} route={route} />;
    }
    return (
      <LazyThreadedSurfaceRoute
        workspaceId={input.activeWorkspaceId}
        workspaceName={input.activeWorkspaceName}
        approvalsCount={input.pendingApprovals}
        surface="cowork"
        lockSurface
        onOpenCode={() => input.navigate({ area: "code", theme: route.theme, sessionId: route.sessionId })}
        onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
        onOpenApprovals={() => input.navigate({ area: "ops", section: "approvals", theme: route.theme })}
        onNavigateSurface={(surface, options) =>
          input.navigate({
            area: surface,
            theme: route.theme,
            sessionId: options?.sessionId ?? undefined,
            turnId: options?.turnId ?? undefined,
            artifactId: options?.artifactId ?? undefined,
          })
        }
      />
    );
  }

  if (route.area === "code") {
    return (
      <LazyThreadedSurfaceRoute
        workspaceId={input.activeWorkspaceId}
        workspaceName={input.activeWorkspaceName}
        approvalsCount={input.pendingApprovals}
        surface="code"
        lockSurface
        onOpenCowork={() => input.navigate({ area: "cowork", theme: route.theme, sessionId: route.sessionId })}
        onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
        onOpenApprovals={() => input.navigate({ area: "ops", section: "approvals", theme: route.theme })}
        onNavigateSurface={(surface, options) =>
          input.navigate({
            area: surface,
            theme: route.theme,
            sessionId: options?.sessionId ?? undefined,
            turnId: options?.turnId ?? undefined,
            artifactId: options?.artifactId ?? undefined,
          })
        }
      />
    );
  }

  if (route.area === "library") {
    if (route.section === "prompt-packs") {
      return (
        <LazyPromptPacksWorkbenchPage
          workspaceId={input.activeWorkspaceId}
          variant="library"
          navigate={input.navigate}
        />
      );
    }
    return <LazyNativeRoutePages {...input} route={route} />;
  }

  if (route.area === "ops") {
    return <LazyNativeRoutePages {...input} route={route} />;
  }

  return <LazyNativeRoutePages {...input} route={route} />;
}

function RouteSurfaceFallback({ label, description }: { label: string; description: string }) {
  return (
    <section className="mc-next-route-fallback" aria-live="polite">
      <BlocksShuffleLoader label={`Loading ${label}`} />
      <p>Loading {label}</p>
      <span>{description}</span>
    </section>
  );
}

function buildRailSections(area: PrimaryArea, items: RailItem[]): RailSection[] {
  if (area === "settings") {
    return [
      {
        id: "settings-core",
        label: "Configuration",
        items: items.filter(
          (item) =>
            item.section === "general" ||
            item.section === "providers" ||
            item.section === "access" ||
            item.section === "runtime" ||
            item.section === "workspaces",
        ),
      },
      {
        id: "settings-connections",
        label: "Connections",
        items: items.filter(
          (item) => item.section === "integrations" || item.section === "channels" || item.section === "mcp",
        ),
      },
      {
        id: "settings-controls",
        label: "Controls",
        items: items.filter((item) => item.section === "tools" || item.section === "addons"),
      },
    ].filter((group) => group.items.length);
  }

  if (area === "library") {
    return [
      {
        id: "library-knowledge",
        label: "Knowledge",
        items: items.filter(
          (item) =>
            item.section === "agents" ||
            item.section === "skills" ||
            item.section === "memory" ||
            item.section === "knowledge",
        ),
      },
      {
        id: "library-assets",
        label: "Assets",
        items: items.filter(
          (item) => item.section === "files" || item.section === "artifacts" || item.section === "prompt-packs",
        ),
      },
    ].filter((group) => group.items.length);
  }

  if (area === "ops") {
    return [
      {
        id: "ops-observe",
        label: "Observe",
        items: items.filter(
          (item) => item.section === "activity" || item.section === "sessions" || item.section === "schedules",
        ),
      },
      {
        id: "ops-control",
        label: "Operate",
        items: items.filter(
          (item) =>
            item.section === "improvement" ||
            item.section === "approvals" ||
            item.section === "costs" ||
            item.section === "runtime" ||
            item.section === "diagnostics",
        ),
      },
    ].filter((group) => group.items.length);
  }

  return [{ id: `${area}-primary`, items }];
}

function StatusPill({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="mc-next-status-pill">
      <span className="mc-next-status-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function resolveShellThemeClass(theme: "dark" | "light"): "theme-signal-noir" | "theme-citadel-light" {
  return theme === "light" ? "theme-citadel-light" : "theme-signal-noir";
}

function describeRealtimeTruthUi(
  streamState: EventStreamConnectionState,
  truthMode: RealtimeTruthMode,
): {
  badge: string;
  inspector: string;
  rail: string;
  stage: string;
  strip: string;
  degraded: boolean;
} {
  if (streamState !== "open") {
    return {
      badge: "Polling",
      inspector: "Polling fallback",
      rail: "Polling fallback active",
      stage: "Realtime degraded",
      strip: "Polling fallback",
      degraded: true,
    };
  }

  if (truthMode === "replay-gap") {
    return {
      badge: "Live recovery",
      inspector: "Streaming via replay recovery",
      rail: "Streaming with replay recovery",
      stage: "Realtime replay recovery",
      strip: "Streaming (replay recovery)",
      degraded: true,
    };
  }

  if (truthMode === "compatibility") {
    return {
      badge: "Live fallback",
      inspector: "Streaming with compatibility fallback",
      rail: "Streaming with compatibility fallback",
      stage: "Realtime compatibility fallback",
      strip: "Streaming (compatibility fallback)",
      degraded: true,
    };
  }

  return {
    badge: "Live",
    inspector: "Connected",
    rail: "Gateway live with streaming",
    stage: "Realtime connected",
    strip: "Streaming",
    degraded: false,
  };
}

function isImmersiveRoute(route: AppRoute): boolean {
  return route.area === "library" && route.section === "prompt-packs";
}

function usesEmbeddedRouteHeader(route: AppRoute): boolean {
  return (
    route.area === "library" ||
    route.area === "ops" ||
    route.area === "settings" ||
    (route.area === "cowork" && (route.section === "tasks" || route.section === "board"))
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}
