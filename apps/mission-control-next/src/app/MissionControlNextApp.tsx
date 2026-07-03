/* eslint-disable max-lines -- W4.4 (ship punchlist): cohesive state hooks now live in use-gateway-access, use-event-stream, use-shell-status, use-shell-notifications, and use-shell-inspector. Remaining length is shell JSX (topbar, rail, stage, status strip) plus the co-located route-dispatch + UI helpers consumed by helpers tests; further reduction would mean moving helpers across files at the cost of those test imports. */
import { Suspense, startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bell,
  Bot,
  BookOpenText,
  FolderKanban,
  LibraryBig,
  Menu,
  MoonStar,
  PanelRightClose,
  PanelRightOpen,
  Rocket,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SunMedium,
  Volume2,
  VolumeX,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import {
  fetchWorkspaces,
  getGatewayApiBaseUrl,
  type EventStreamConnectionState,
} from "@goatcitadel/mission-control-shared/api/shell-client";
import { fetchRuntimeLifecycleExport, listCitadels } from "@goatcitadel/mission-control-shared/api/client";
import {
  buildThreadedGatewayStatusSummary,
  type ThreadedGatewayStatusSummary,
} from "@goatcitadel/threaded-surface-core/work-trust";
import { GatewayAccessGate } from "@goatcitadel/mission-control-shared/components/GatewayAccessGate";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NotificationStack } from "@goatcitadel/mission-control-shared/components/NotificationStack";
import { PageErrorBoundary } from "@goatcitadel/mission-control-shared/components/PageErrorBoundary";
import { CommandPalette, type CommandPaletteItem } from "@goatcitadel/mission-control-shared/components/CommandPalette";
import { SideInspectorDrawer } from "@goatcitadel/mission-control-shared/components/SideInspectorDrawer";
import {
  ShellDetailPanelProvider,
  type ShellDetailPanelEntry,
} from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { resolveEffectiveEffectsMode } from "@goatcitadel/mission-control-shared/state/effects-mode";
import { type RealtimeTruthMode } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import {
  LazyNativeRoutePages,
  LazyPromptPacksWorkbenchPage,
  LazyThreadedSurfaceRoute,
  preloadNativeRoutePages,
  preloadPromptPacksWorkbenchPage,
  preloadThreadedSurfaceRoute,
} from "./lazy-legacy-pages";
import { BlocksShuffleLoader } from "../components/BlocksShuffleLoader";
import { TopbarOverflowMenu, type TopbarOverflowItem } from "./TopbarOverflowMenu";
import {
  describeDirtySections,
  useAnySectionDirty,
  useBeforeUnloadGuard,
  useNavigateGuard,
} from "../features/native-routes/library/use-form-dirty";
import {
  AREA_META,
  RAIL_ITEMS,
  buildAppHref,
  buildModeRail,
  buildNavigationTarget,
  describeReleaseScopeForOperator,
  describeReleaseSurfaceStatus,
  getRouteDescription,
  getRouteLabel,
  getRouteReleaseScope,
  isExperimentalRoute,
  isRailItemActive,
  normalizeAppRoute,
  type AppRoute,
  RAIL_GROUPS,
  type PrimaryArea,
  type RailItem,
} from "./route-model";
import { coerceLegacyHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";
import { SHELL_ROUTE_SHORTCUT_LETTERS, useShellKeyboardManager } from "./use-shell-keyboard-manager";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { useGatewayAccess } from "./use-gateway-access";
import { useShellStatus, type ShellStatusState } from "./use-shell-status";
import { useShellNotifications } from "./use-shell-notifications";
import { useEventStream } from "./use-event-stream";
import { useShellInspector } from "./use-shell-inspector";
import { NativeButton } from "@next/features/native-routes/primitives";

type RailSection = {
  id: string;
  label?: string;
  items: RailItem[];
};

const PRIMARY_NAV: Array<{ area: PrimaryArea; icon: typeof Bot }> = [
  { area: "chat", icon: Bot },
  { area: "projects", icon: FolderKanban },
  { area: "library", icon: LibraryBig },
  { area: "ops", icon: Activity },
  { area: "settings", icon: SlidersHorizontal },
];

/**
 * F-M11: experimental library/ops surfaces that are filtered out of the rails
 * and need an explicit command-palette entry to stay reachable. (Settings
 * experimental sections — personalities, addons — already surface via the
 * settings rail-item palette mapping.)
 */
const EXPERIMENTAL_COMMAND_ROUTES: ReadonlyArray<{
  area: PrimaryArea;
  section: NonNullable<AppRoute["section"]>;
  label: string;
}> = [
  { area: "library", section: "curator", label: "Library → Skill Curator" },
  { area: "ops", section: "improvement", label: "Ops → Improvement" },
  { area: "ops", section: "kanban", label: "Ops → Kanban" },
];

function preloadRouteChunk(targetRoute: AppRoute): void {
  const normalized = normalizeAppRoute(targetRoute);
  if (normalized.area === "chat" || normalized.area === "cowork" || normalized.area === "code") {
    void preloadThreadedSurfaceRoute();
    return;
  }
  if (normalized.area === "library" && normalized.section === "prompt-packs") {
    void preloadPromptPacksWorkbenchPage();
    return;
  }
  void preloadNativeRoutePages();
}

export function MissionControlNextApp() {
  useBeforeUnloadGuard();
  const {
    mode,
    setMode,
    density,
    effectsMode,
    showTechnicalDetails,
    detailPanelPinned,
    setDetailPanelPinned,
    activeCitadelId,
    setActiveCitadelId,
    activeWorkspaceId,
    setActiveWorkspaceId,
    theme,
    setTheme,
    notifications: notificationPreferences,
    setNotificationSoundMode,
  } = useUiPreferences();
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const [route, setRoute] = useState<AppRoute>(() => resolveRouteFromLocation(window.location.href));
  const [navOpen, setNavOpen] = useState(false);
  // H-7 (ship punchlist): shell-level command palette opened via Cmd/Ctrl+K
  // and routed by useShellKeyboardManager. State stays here because Esc
  // priority needs to know whether the palette is the topmost dismissible.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // C2: "?" toggles a keyboard-shortcuts cheat-sheet. State lives here so Esc
  // dismiss priority can close it as the topmost dismissible.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [citadelOptions, setCitadelOptions] = useState<Array<{ citadelId: string; name: string }>>([]);
  const [workspaceOptions, setWorkspaceOptions] = useState<Array<{ workspaceId: string; name: string }>>([]);

  // W4.4: cohesive state moved into dedicated hooks. The shell still composes
  // them (e.g. status reset depends on gateway readiness, event stream feeds
  // notifications) but no longer owns the underlying useState/useRef plumbing.
  const { gatewayAccess, gatewayBusy, autoRetryPending, retryGatewayAccess } = useGatewayAccess();
  const gatewayReady = gatewayAccess.status === "ready";
  const { inspectorOpen, setInspectorOpen, detailEntry, setDetailEntry } = useShellInspector();
  const { notifications, pushNotification, dismissNotification, deliverRealtimeNotification, lastEnabledSoundModeRef } =
    useShellNotifications({ notificationPreferences });
  const { streamState, streamTruthMode } = useEventStream({
    gatewayReady,
    onRealtimeNotification: deliverRealtimeNotification,
  });
  const { status, refreshStatus } = useShellStatus({ gatewayReady });

  const rawNavigate = useCallback((nextRoute: AppRoute, options?: { replace?: boolean }) => {
    const normalized = normalizeAppRoute(nextRoute);
    const href = buildAppHref(normalized);
    const mutate = options?.replace ? window.history.replaceState : window.history.pushState;
    mutate.call(window.history, {}, "", href);
    startTransition(() => {
      setRoute(normalized);
    });
    setNavOpen(false);
  }, []);
  const isSameShellRoute = useCallback(
    (target: AppRoute) => buildAppHref(normalizeAppRoute(target)) === buildAppHref(normalizeAppRoute(route)),
    [route],
  );
  const buildPrimaryAreaRoute = useCallback(
    (area: PrimaryArea): AppRoute => ({
      area,
      mode: area === "chat" ? route.mode : undefined,
      theme: route.theme,
      sessionId: area === "chat" ? route.sessionId : undefined,
      turnId: area === "chat" ? route.turnId : undefined,
      artifactId: area === "chat" ? route.artifactId : undefined,
    }),
    [route.artifactId, route.mode, route.sessionId, route.theme, route.turnId],
  );
  const {
    navigate,
    pending: pendingDirtyNavigation,
    confirmDiscard,
    cancelDiscard,
  } = useNavigateGuard<AppRoute>(rawNavigate, isSameShellRoute);
  const dirtyKeys = useAnySectionDirty();

  /*
   * H-7 (ship punchlist): shell command palette + keyboard model.
   * Items lean on PRIMARY_NAV for route jumps so the area set stays the
   * single source of truth. Each item carries the g+<letter> shortcut as
   * a keyword so users can also find it by typing "g c".
   *
   * Task #38 ("Find a setting"): settings sections appear after the area
   * jumps so "Go to Settings" still wins for a bare "s", and the specific
   * leaves surface as the user types more (e.g. "providers", "mcp").
   * Includes the release-bearing trust/setup leaves so rail and palette
   * discoverability stay aligned.
   */
  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const areaItems = PRIMARY_NAV.map(({ area }) => {
      const meta = AREA_META[area];
      const letter = SHELL_ROUTE_SHORTCUT_LETTERS.get(area);
      return {
        id: `go-${area}`,
        label: `Go to ${meta.label}`,
        keywords: [area, meta.kicker, meta.label, ...(letter ? [`g ${letter}`, `g${letter}`] : [])],
        run: () => navigate(buildPrimaryAreaRoute(area)),
      };
    });
    const settingsItems = RAIL_ITEMS.settings.map((railItem) => {
      const section = railItem.section;
      const descriptionWords = railItem.description.toLowerCase().split(/\s+/).slice(0, 6).join(" ");
      return {
        id: `settings-${section}`,
        label: `Settings → ${railItem.label}`,
        keywords: ["settings", ...(section ? [section] : []), railItem.label.toLowerCase(), descriptionWords],
        run: () => navigate({ area: "settings", section, theme: route.theme }),
      };
    });
    // F-M11: the experimental library/ops surfaces are filtered out of the rails
    // (NAV-02) and were unreachable from the palette. Settings experimental
    // sections already appear via `settingsItems`, but curator/improvement/kanban
    // had no palette entry at all. Add them explicitly, labelled "Experimental"
    // so they stay discoverable and honestly scoped.
    const experimentalItems = EXPERIMENTAL_COMMAND_ROUTES.map((entry) => ({
      id: `experimental-${entry.area}-${entry.section}`,
      label: `${entry.label} (Experimental)`,
      keywords: [entry.area, entry.section, entry.label.toLowerCase(), "experimental"],
      run: () => navigate({ area: entry.area, section: entry.section, theme: route.theme }),
    }));
    return [...areaItems, ...settingsItems, ...experimentalItems];
  }, [buildPrimaryAreaRoute, navigate, route.theme]);

  // H-7: dismiss the topmost UI layer when Escape fires (palette handled
  // separately because it's already a controlled dialog). Order matters:
  // inspector > nav drawer.
  const dismissTopmost = useCallback((): boolean => {
    if (shortcutsOpen) {
      setShortcutsOpen(false);
      return true;
    }
    if (inspectorOpen) {
      setInspectorOpen(false);
      return true;
    }
    if (navOpen) {
      setNavOpen(false);
      return true;
    }
    return false;
  }, [inspectorOpen, navOpen, setInspectorOpen, shortcutsOpen]);

  const routeShortcuts = useMemo(
    () =>
      PRIMARY_NAV.map(({ area }) => ({
        label: AREA_META[area].label,
        letter: SHELL_ROUTE_SHORTCUT_LETTERS.get(area) ?? "",
      })).filter((shortcut) => shortcut.letter),
    [],
  );

  useShellKeyboardManager({
    onOpenPalette: () => setPaletteOpen(true),
    onClosePalette: () => setPaletteOpen(false),
    isPaletteOpen: paletteOpen,
    onDismissTopmost: dismissTopmost,
    onJumpToArea: (area) => navigate(buildPrimaryAreaRoute(area)),
    onToggleShortcuts: () => setShortcutsOpen((open) => !open),
    shellShortcutsSuspended: shortcutsOpen,
  });

  const shellThemeClass = resolveShellThemeClass(resolveEffectiveShellTheme(route.theme, theme));
  const currentAreaMeta = AREA_META[route.area];
  const currentRailItems = route.area === "chat" ? buildModeRail(route.mode) : RAIL_ITEMS[route.area];
  const groupedRailItems = useMemo(
    () =>
      buildRailSections(
        route.area,
        // NAV-02: keep experimental surfaces out of the primary rails. They stay
        // reachable via direct URL, the command palette, and their stage badge.
        currentRailItems.filter((item) => !isExperimentalRoute(item)),
      ),
    [route.area, currentRailItems],
  );
  const currentRouteLabel = getRouteLabel(route);
  const currentRouteDescription = getRouteDescription(route);
  const currentReleaseScope = getRouteReleaseScope(route);
  const currentReleaseStatusLabel = describeReleaseSurfaceStatus(currentReleaseScope.status);
  const realtimeStatusCopy = useMemo(
    () => describeRealtimeTruthUi(streamState, streamTruthMode),
    [streamState, streamTruthMode],
  );
  // F1 (topbar density): below the compact desktop breakpoint the lower-priority topbar
  // controls collapse into an overflow menu so the right cluster never clips
  // behind `overflow: clip`. Mirrors the `@media (max-width: 1439px)` CSS tier so
  // JS placement and the responsive stylesheet stay in lockstep. Falls back to
  // the roomy inline layout when matchMedia is unavailable (SSR / test renderer).
  const isCompactTopbar = useMediaQuery("(max-width: 1439px)");
  // WS-E: below the rail breakpoint the `.mc-next-rail` becomes the hamburger
  // drawer (areas live in the topbar on desktop, which is hidden here). Mirror
  // the `@media (max-width: 1023px)` CSS tier so the in-drawer area switcher
  // only renders on mobile and never duplicates the desktop topbar nav.
  const isMobileNav = useMediaQuery("(max-width: 1023px)");
  const isWorkArea = route.area === "chat" || route.area === "cowork" || route.area === "code";
  const immersiveRoute = isImmersiveRoute(route);
  const usesFullStageLayout = isWorkArea || immersiveRoute;
  const hasVisibleInspector = detailPanelPinned || inspectorOpen;
  const activeWorkspaceName =
    workspaceOptions.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? activeWorkspaceId;
  const activeCitadelName = citadelOptions.find((item) => item.citadelId === activeCitadelId)?.name ?? activeCitadelId;

  const copyTrustReportForRoute = useCallback(
    async (targetRoute: AppRoute) => {
      if (!targetRoute.sessionId) {
        pushNotification(
          "warning",
          "Open a Chat, Cowork, or Code run before exporting a trust report.",
          "trust-report",
        );
        return;
      }
      try {
        const bundle = await fetchRuntimeLifecycleExport({
          sessionId: targetRoute.sessionId,
          turnId: targetRoute.turnId,
          includeTimeline: true,
          includeTranscript: true,
          format: "trust_report",
        });
        const report = bundle.trustReport?.shareableMarkdown ?? JSON.stringify(bundle.trustReport ?? bundle, null, 2);
        await navigator.clipboard.writeText(report);
        pushNotification("success", "Trust report copied to clipboard.", "trust-report");
      } catch (error) {
        pushNotification(
          "error",
          error instanceof Error ? `Trust report export failed: ${error.message}` : "Trust report export failed.",
          "trust-report",
        );
      }
    },
    [pushNotification],
  );

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
          <span>{activeCitadelName}</span>
          <span>{activeWorkspaceName}</span>
          <span>{currentRouteDescription}</span>
        </div>
      ),
      actions: route.sessionId ? (
        <NativeButton
          variant="secondary"
          onClick={() => {
            void copyTrustReportForRoute(route);
          }}
        >
          <ShieldCheck size={14} />
          Copy trust report
        </NativeButton>
      ) : null,
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
            <h4>Context</h4>
            <ul className="mc-next-inspector-list">
              <li>Citadel: {activeCitadelName}</li>
              <li>Workspace: {activeWorkspaceName}</li>
              <li>Area: {currentAreaMeta.label}</li>
              <li>Realtime: {realtimeStatusCopy.inspector}</li>
            </ul>
          </section>
          <section className="mc-next-inspector-disclosure" aria-label="Release readiness">
            <div className="mc-next-inspector-disclosure-summary">
              <span>Release readiness</span>
              <strong>{currentReleaseStatusLabel}</strong>
            </div>
            <ul className="mc-next-inspector-list">
              <li>Scope: {currentReleaseStatusLabel}</li>
              <li>Action: {currentReleaseScope.releaseAction}</li>
              <li>Verification: {currentReleaseScope.verification}</li>
              <li>Constraint: {currentReleaseScope.note}</li>
            </ul>
          </section>
        </div>
      ),
    };
  }, [
    activeCitadelName,
    activeWorkspaceName,
    currentAreaMeta.kicker,
    currentAreaMeta.label,
    currentReleaseScope.note,
    currentReleaseScope.releaseAction,
    currentReleaseScope.verification,
    currentReleaseStatusLabel,
    currentRouteDescription,
    currentRouteLabel,
    copyTrustReportForRoute,
    realtimeStatusCopy.inspector,
    route,
    status.dashboard,
  ]);
  const inspectorEntry = detailEntry ?? passiveInspectorEntry;
  const pendingApprovals = status.dashboard?.pendingApprovals ?? 0;
  const daemonStatusUnavailable = Boolean(status.healthError);
  // F-H4: the dashboard-derived footer pills (approvals/sessions/spend) must
  // read stale/unavailable on a dashboard refresh failure instead of confidently
  // re-presenting the retained last-good numbers.
  const approvalsPill = describeDashboardFooterPill(
    status.dashboard,
    status.dashboardError,
    `${pendingApprovals} pending`,
  );
  const sessionsPill = describeDashboardFooterPill(
    status.dashboard,
    status.dashboardError,
    status.dashboard ? `${status.dashboard.sessions.length} visible` : "—",
  );
  const spendPill = describeDashboardFooterPill(
    status.dashboard,
    status.dashboardError,
    status.dashboard ? formatUsd(status.dashboard.dailyCostUsd ?? 0) : "—",
  );
  const daemonHealthKnown =
    !daemonStatusUnavailable && status.health?.daemonStatus !== undefined && status.health?.daemonStatus !== null;
  const daemonNeedsIntervention = daemonHealthKnown && status.health?.daemonStatus?.running === false;
  const daemonStatusValue = daemonStatusUnavailable
    ? "Unavailable"
    : status.health?.daemonStatus?.running
      ? "Serving"
      : daemonHealthKnown
        ? "Needs intervention"
        : "Checking";
  const threadedGatewayStatus = useMemo(
    () =>
      buildThreadedGatewayStatusSummary({
        gatewayReady,
        gatewayMessage: gatewayAccess.message,
        dashboardError: status.dashboardError,
        healthError: status.healthError,
        daemonRunning: status.health?.daemonStatus?.running ?? null,
      }),
    [
      gatewayAccess.message,
      gatewayReady,
      status.dashboardError,
      status.health?.daemonStatus?.running,
      status.healthError,
    ],
  );
  const operatorNotificationCount =
    (daemonStatusUnavailable || daemonNeedsIntervention ? 1 : 0) + (notifications.length > 0 ? 1 : 0);
  const railSignalTitle = route.area === "settings" ? "Configuration posture" : "Operator posture";
  const railSignalLines =
    route.area === "settings"
      ? [`${activeCitadelName} Citadel`, `${activeWorkspaceName} active`, realtimeStatusCopy.rail]
      : [
          `${status.dashboard?.sessions.length ?? 0} recent sessions`,
          `${status.dashboard?.activeSubagents ?? 0} active subagents`,
          `${formatUsd(status.dashboard?.dailyCostUsd ?? 0)} daily spend`,
        ];

  const loadCitadelOptions = useCallback(async () => {
    try {
      const response = await listCitadels("all", 200);
      const options = response.items.map((item) => ({
        citadelId: item.citadelId,
        name: item.name,
      }));
      setCitadelOptions(options);
      if (!response.items.some((item) => item.citadelId === activeCitadelId)) {
        const fallbackCitadelId =
          response.items.find((item) => item.citadelId === "personal")?.citadelId ?? response.items[0]?.citadelId;
        if (fallbackCitadelId) {
          setActiveCitadelId(fallbackCitadelId);
        }
      }
    } catch {
      setCitadelOptions([]);
    }
  }, [activeCitadelId, setActiveCitadelId]);

  const loadWorkspaceOptions = useCallback(async () => {
    try {
      const response = await fetchWorkspaces("all", 400, activeCitadelId);
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
  }, [activeCitadelId, activeWorkspaceId, setActiveWorkspaceId]);

  const clearInvalidProjectSelection = useCallback(() => {
    if (route.area !== "projects" || (!route.projectId && !route.artifactId)) {
      return;
    }
    navigate({ area: "projects", theme: route.theme }, { replace: true });
  }, [navigate, route.area, route.artifactId, route.projectId, route.theme]);

  const handleSelectCitadel = useCallback(
    (citadelId: string) => {
      setActiveCitadelId(citadelId);
      clearInvalidProjectSelection();
    },
    [clearInvalidProjectSelection, setActiveCitadelId],
  );

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      setActiveWorkspaceId(workspaceId);
      clearInvalidProjectSelection();
    },
    [clearInvalidProjectSelection, setActiveWorkspaceId],
  );

  // F1: shared handlers so each inline topbar control and its overflow-menu
  // counterpart stay behaviorally identical (one source of truth per action).
  const handleOpenStartHere = useCallback(
    () => navigate({ area: "settings", section: "onboarding", theme: route.theme }),
    [navigate, route.theme],
  );
  const handleToggleMode = useCallback(() => setMode(mode === "simple" ? "advanced" : "simple"), [mode, setMode]);
  const handleToggleNotificationSound = useCallback(
    () =>
      setNotificationSoundMode(notificationPreferences.soundMode === "off" ? lastEnabledSoundModeRef.current : "off"),
    [notificationPreferences.soundMode, setNotificationSoundMode, lastEnabledSoundModeRef],
  );
  const handleToggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [setTheme, theme]);
  const soundEnabled = notificationPreferences.soundMode !== "off";
  // F1: lower-priority controls that fold into the overflow menu at compact
  // widths. Approvals, notifications, and the Context toggle stay inline at every
  // width so operator-critical actions are always one click away.
  const topbarOverflowItems: TopbarOverflowItem[] = [
    {
      id: "start-here",
      label: "Start Here",
      ariaLabel: "Open Start Here",
      icon: <Rocket size={15} />,
      onSelect: handleOpenStartHere,
    },
    {
      id: "mode",
      label: mode === "simple" ? "Switch to Expert mode" : "Switch to Guided mode",
      icon: <SlidersHorizontal size={15} />,
      onSelect: handleToggleMode,
    },
    {
      id: "notification-sound",
      label: soundEnabled ? "Disable notification sounds" : "Enable notification sounds",
      icon: soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />,
      active: soundEnabled,
      onSelect: handleToggleNotificationSound,
    },
    {
      id: "theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? <SunMedium size={15} /> : <MoonStar size={15} />,
      onSelect: handleToggleTheme,
    },
  ];

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
    preloadRouteChunk(route);
  }, [route]);

  useEffect(() => {
    const handlePopState = () => {
      // Match `navigate`: keep the current surface mounted while a lazy route
      // chunk loads instead of flashing the Suspense fallback on browser back.
      startTransition(() => {
        setRoute(resolveRouteFromLocation(window.location.href));
      });
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

  // W4.4: workspace + status hydration when the gateway becomes ready.
  // useShellStatus owns the refresh loop and reset-on-disconnect; the shell
  // still owns workspace options and the initial parallel load so both data
  // sources warm up together (status hook itself does not trigger first load).
  useEffect(() => {
    if (!gatewayReady) {
      setCitadelOptions([]);
      setWorkspaceOptions([]);
      return;
    }
    void Promise.all([loadCitadelOptions(), loadWorkspaceOptions(), refreshStatus()]);
  }, [gatewayReady, loadCitadelOptions, loadWorkspaceOptions, refreshStatus]);

  useEffect(() => {
    document.title = `GoatCitadel ${currentRouteLabel}`;
  }, [currentRouteLabel]);

  if (gatewayAccess.status !== "ready") {
    return (
      <GatewayAccessGate
        gatewayBaseUrl={getGatewayApiBaseUrl()}
        access={gatewayAccess}
        busy={gatewayBusy}
        autoRetryPending={autoRetryPending}
        onRetry={retryGatewayAccess}
      />
    );
  }

  const pageErrorResetKey = buildAppHref(route);
  const routeContent = renderRouteContent({
    route,
    activeCitadelId,
    activeCitadelName,
    activeWorkspaceId,
    activeWorkspaceName,
    gatewayStatus: threadedGatewayStatus,
    pendingApprovals,
    navigate,
    setActiveCitadelId,
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
          hasVisibleInspector ? "has-shell-inspector" : "",
          showTechnicalDetails ? "" : "ui-hide-technical",
        ]
          .filter(Boolean)
          .join(" ")}
        data-area={route.area}
        data-section={route.section ?? "root"}
        data-route={pageErrorResetKey.split("?")[0]}
      >
        <a className="mc-next-skip-link" href="#main-content">
          Skip to content
        </a>
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
                {PRIMARY_NAV.map(({ area, icon: Icon }) => {
                  const target = buildPrimaryAreaRoute(area);
                  return (
                    <button
                      key={area}
                      type="button"
                      className={`mc-next-primary-link${route.area === area ? " active" : ""}`}
                      aria-current={route.area === area ? "page" : undefined}
                      onFocus={() => preloadRouteChunk(target)}
                      onMouseEnter={() => preloadRouteChunk(target)}
                      onClick={() => navigate(target)}
                    >
                      <Icon size={16} />
                      <span>{AREA_META[area].label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
            <div className="mc-next-topbar-right">
              {/* F10: one name for Cmd/Ctrl+K. The trigger, its accessible name,
                  and the dialog it opens all read "Command Palette" (the canonical
                  name in shared copy), so the visible label matches the accessible
                  name (WCAG 2.5.3) instead of the prior "Search commands" vs
                  "Open command palette" split. */}
              <button
                type="button"
                className="mc-next-command-search"
                onClick={() => setPaletteOpen(true)}
                title="Command Palette"
                aria-label="Command Palette"
              >
                <Search size={15} />
                <span>Command Palette</span>
                <kbd>Ctrl K</kbd>
              </button>
              {!isCompactTopbar ? (
                <>
                  <NativeButton
                    variant="secondary"
                    className="mc-next-start-button"
                    onClick={handleOpenStartHere}
                    title="Open Start Here"
                  >
                    <Rocket size={15} />
                    Start Here
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    className="mc-next-mode-toggle"
                    onClick={handleToggleMode}
                    title={mode === "simple" ? "Switch to Expert mode" : "Switch to Guided mode"}
                  >
                    <SlidersHorizontal size={15} />
                    {mode === "simple" ? "Guided" : "Expert"}
                  </NativeButton>
                </>
              ) : null}
              <label className="mc-next-select-field">
                <span>Citadel</span>
                <select value={activeCitadelId} onChange={(event) => handleSelectCitadel(event.target.value)}>
                  {[...citadelOptions, { citadelId: activeCitadelId, name: activeCitadelName }]
                    .filter(
                      (item, index, items) =>
                        items.findIndex((candidate) => candidate.citadelId === item.citadelId) === index,
                    )
                    .map((item) => (
                      <option key={item.citadelId} value={item.citadelId}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="mc-next-select-field">
                <span>Workspace</span>
                <select value={activeWorkspaceId} onChange={(event) => handleSelectWorkspace(event.target.value)}>
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
              <span className="mc-next-topbar-divider" aria-hidden="true" />
              <div className="mc-next-topbar-status">
                {/* F2: realtime status lives canonically in the always-visible
                    footer strip ("Live updates"). Surface the topbar badge only
                    as the degraded/fallback escalation, so the healthy path shows
                    the signal once instead of duplicating it in the same viewport. */}
                {realtimeStatusCopy.degraded ? (
                  <span className="mc-next-badge mc-next-realtime-badge" data-realtime="degraded">
                    {realtimeStatusCopy.badge}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="mc-next-badge mc-next-badge-button"
                  onClick={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
                  aria-label="Open approvals"
                  title="Open approvals"
                >
                  <span className="mc-next-badge-count">{pendingApprovals}</span>
                  <span className="mc-next-badge-label">approvals</span>
                </button>
              </div>
              <button
                type="button"
                className="mc-next-icon-button"
                onClick={() => navigate({ area: "ops", section: "notifications", theme: route.theme })}
                aria-label="Open notifications"
                title="Notifications"
              >
                <Bell size={16} />
                <span>{operatorNotificationCount}</span>
              </button>
              {!isCompactTopbar ? (
                <button
                  type="button"
                  className={`mc-next-icon-button mc-next-audio-toggle${soundEnabled ? " active" : ""}`}
                  onClick={handleToggleNotificationSound}
                  aria-pressed={soundEnabled}
                  aria-label={soundEnabled ? "Disable notification sounds" : "Enable notification sounds"}
                  title={soundEnabled ? "Disable notification sounds" : "Enable notification sounds"}
                >
                  {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                  <span>{soundEnabled ? "On" : "Off"}</span>
                </button>
              ) : null}
              <NativeButton
                variant="secondary"
                className="mc-next-wa-button"
                onClick={() => setInspectorOpen((current) => !current)}
                aria-label={inspectorOpen ? "Hide Context" : "Open Context"}
                title={inspectorOpen ? "Hide Context" : "Open Context"}
              >
                {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                {inspectorOpen ? "Hide Context" : "Open Context"}
              </NativeButton>
              {!isCompactTopbar ? (
                <button
                  type="button"
                  className="mc-next-icon-button mc-next-theme-toggle"
                  onClick={handleToggleTheme}
                  aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                  title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                >
                  {theme === "dark" ? <SunMedium size={16} /> : <MoonStar size={16} />}
                </button>
              ) : null}
              {isCompactTopbar ? <TopbarOverflowMenu items={topbarOverflowItems} /> : null}
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
              {isMobileNav ? (
                <div className="mc-next-rail-areas">
                  {PRIMARY_NAV.map(({ area, icon: Icon }) => (
                    <button
                      key={area}
                      type="button"
                      className={`mc-next-rail-area-link${route.area === area ? " active" : ""}`}
                      aria-current={route.area === area ? "page" : undefined}
                      onClick={() => {
                        navigate(buildPrimaryAreaRoute(area));
                        setNavOpen(false);
                      }}
                    >
                      <Icon size={16} />
                      <span>{AREA_META[area].label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="mc-next-rail-menu">
                {groupedRailItems.map((group) => {
                  const groupLabelId = group.label ? `mc-next-rail-group-${group.id}` : undefined;
                  return (
                    <section key={group.id} className="mc-next-rail-section" aria-labelledby={groupLabelId}>
                      {group.label ? (
                        <div className="mc-next-rail-separator" id={groupLabelId}>
                          <span>{group.label}</span>
                        </div>
                      ) : null}
                      <div className="mc-next-rail-group">
                        {group.items.map((item) => {
                          const target = buildNavigationTarget(route, item);
                          const releaseScope = getRouteReleaseScope(target);
                          const releaseStatusLabel = describeReleaseSurfaceStatus(releaseScope.status);
                          const releaseScopeOperatorSummary = describeReleaseScopeForOperator(releaseScope);
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
                              aria-label={`${item.label}: ${item.description}`}
                              onFocus={() => preloadRouteChunk(target)}
                              onMouseEnter={() => preloadRouteChunk(target)}
                              onClick={() => navigate(target)}
                            >
                              <div>
                                <strong>
                                  {item.label}
                                  {releaseScope.status === "ship" ? null : (
                                    <span
                                      className="mc-next-rail-release-badge"
                                      data-release-status={releaseScope.status}
                                      title={releaseScopeOperatorSummary}
                                      aria-label={releaseScopeOperatorSummary}
                                    >
                                      {releaseStatusLabel}
                                    </span>
                                  )}
                                </strong>
                                <span title={item.description}>{item.description}</span>
                              </div>
                              {typeof backlogCount === "number" ? (
                                <span className="mc-next-rail-count">{backlogCount}</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
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

            <main
              id="main-content"
              tabIndex={-1}
              className={`mc-next-stage${usesFullStageLayout ? " mc-next-stage-work" : ""}`}
            >
              <PageErrorBoundary
                resetKey={pageErrorResetKey}
                pageLabel={currentRouteLabel}
                onReturnToChat={() => navigate({ area: "chat", theme: route.theme })}
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
            {currentReleaseScope.status === "ship" ? null : (
              <StatusPill
                icon={<ShieldCheck size={15} />}
                label="Release scope"
                value={currentReleaseStatusLabel}
                releaseStatus={currentReleaseScope.status}
              />
            )}
            <StatusPill icon={<ShieldCheck size={15} />} label={gatewayAccess.message} value="Gateway ready" />
            <StatusPill icon={<Activity size={15} />} label="Live updates" value={realtimeStatusCopy.strip} />
            <StatusPill
              icon={<Workflow size={15} />}
              label="Approvals"
              value={approvalsPill.value}
              degraded={approvalsPill.degraded}
              onClick={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
            />
            <StatusPill
              icon={<BookOpenText size={15} />}
              label="Sessions"
              value={sessionsPill.value}
              degraded={sessionsPill.degraded}
            />
            <StatusPill
              icon={<Wrench size={15} />}
              label="Spend"
              value={spendPill.value}
              degraded={spendPill.degraded}
            />
            <StatusPill icon={<Bot size={15} />} label="Daemon" value={daemonStatusValue} />
          </footer>
        </div>

        <NotificationStack items={notifications} onDismiss={dismissNotification} />
        <ConfirmModal
          open={pendingDirtyNavigation !== null}
          title="Discard unsaved changes?"
          message={
            dirtyKeys.length > 0
              ? `You have unsaved changes in ${describeDirtySections(dirtyKeys)}.`
              : "You have unsaved changes."
          }
          confirmLabel="Discard changes"
          cancelLabel="Stay on this page"
          danger
          onConfirm={confirmDiscard}
          onCancel={cancelDiscard}
        />
        {/* H-7: shell command palette. Cmd/Ctrl+K opens; Esc closes via the
            palette's own handler (priority over useShellKeyboardManager). */}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={commandItems} />
        <ShortcutsOverlay
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          routeShortcuts={routeShortcuts}
        />
      </div>
    </ShellDetailPanelProvider>
  );
}

export function renderRouteContent(input: {
  route: AppRoute;
  activeCitadelId?: string;
  activeCitadelName?: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  gatewayStatus: ThreadedGatewayStatusSummary;
  pendingApprovals: number;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  setActiveCitadelId?: (citadelId: string) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}): ReactNode {
  const route = normalizeAppRoute(input.route);
  if (route.area === "chat") {
    if (route.mode === "cowork") {
      return (
        <LazyThreadedSurfaceRoute
          workspaceId={input.activeWorkspaceId}
          workspaceName={input.activeWorkspaceName}
          gatewayStatus={input.gatewayStatus}
          approvalsCount={input.pendingApprovals}
          surface="cowork"
          lockSurface
          onOpenCode={() => input.navigate({ area: "code", theme: route.theme, sessionId: route.sessionId })}
          onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
          onOpenApprovals={(approvalId?: string) =>
            input.navigate({ area: "ops", section: "approvals", theme: route.theme, approvalId })
          }
          onOpenStartHere={() => input.navigate({ area: "settings", section: "onboarding", theme: route.theme })}
          onOpenUniversalRunDetail={(runId) =>
            input.navigate({ area: "ops", section: "sessions", view: "run-detail", runId, theme: route.theme })
          }
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

    if (route.mode === "code") {
      return (
        <LazyThreadedSurfaceRoute
          workspaceId={input.activeWorkspaceId}
          workspaceName={input.activeWorkspaceName}
          gatewayStatus={input.gatewayStatus}
          approvalsCount={input.pendingApprovals}
          surface="code"
          lockSurface
          onOpenCowork={() => input.navigate({ area: "cowork", theme: route.theme, sessionId: route.sessionId })}
          onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
          onOpenApprovals={(approvalId?: string) =>
            input.navigate({ area: "ops", section: "approvals", theme: route.theme, approvalId })
          }
          onOpenStartHere={() => input.navigate({ area: "settings", section: "onboarding", theme: route.theme })}
          onOpenUniversalRunDetail={(runId) =>
            input.navigate({ area: "ops", section: "sessions", view: "run-detail", runId, theme: route.theme })
          }
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

    return (
      <LazyThreadedSurfaceRoute
        workspaceId={input.activeWorkspaceId}
        workspaceName={input.activeWorkspaceName}
        gatewayStatus={input.gatewayStatus}
        approvalsCount={input.pendingApprovals}
        surface="chat"
        lockSurface={false}
        hidePageHeader
        initialModeOverride={route.mode === "chat" ? "chat" : undefined}
        onOpenCowork={() => input.navigate({ area: "cowork", theme: route.theme, sessionId: route.sessionId })}
        onOpenCode={() => input.navigate({ area: "code", theme: route.theme, sessionId: route.sessionId })}
        onOpenTasks={() => input.navigate({ area: "cowork", section: "tasks", theme: route.theme })}
        onOpenApprovals={(approvalId?: string) =>
          input.navigate({ area: "ops", section: "approvals", theme: route.theme, approvalId })
        }
        onOpenStartHere={() => input.navigate({ area: "settings", section: "onboarding", theme: route.theme })}
        onOpenUniversalRunDetail={(runId) =>
          input.navigate({ area: "ops", section: "sessions", view: "run-detail", runId, theme: route.theme })
        }
        onNavigateSurface={(surface, options) =>
          input.navigate({
            area: surface,
            theme: route.theme,
            sessionId: options?.sessionId ?? undefined,
            turnId: options?.turnId ?? undefined,
            artifactId: options?.artifactId ?? undefined,
          })
        }
        onResolvedModeChange={(mode) => {
          // An explicit ?mode=chat already states operator intent (QA finding N3);
          // do not rewrite it back to the session's own resolved mode (e.g. cowork).
          if (route.mode === "chat") {
            return;
          }
          input.navigate({ ...route, area: "chat", mode }, { replace: true });
        }}
      />
    );
  }

  if (route.area === "cowork") {
    if (route.section === "tasks" || route.section === "board") {
      return <LazyNativeRoutePages {...input} route={route} />;
    }
  }

  if (route.area === "projects") {
    return <LazyNativeRoutePages {...input} route={route} />;
  }

  if (route.area === "library") {
    if (route.section === "prompt-packs") {
      return (
        <LazyPromptPacksWorkbenchPage
          key={route.view ?? "prompt-packs"}
          workspaceId={input.activeWorkspaceId}
          variant="library"
          navigate={input.navigate}
          initialPackId={parsePromptPackFocusView(route.view)}
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

function parsePromptPackFocusView(view: string | undefined): string | undefined {
  const prefix = "pack:";
  if (!view?.startsWith(prefix)) {
    return undefined;
  }
  const packId = view.slice(prefix.length).trim();
  return packId || undefined;
}

export function RouteSurfaceFallback({ label, description }: { label: string; description: string }) {
  return (
    <section className="mc-next-route-fallback" aria-live="polite">
      <BlocksShuffleLoader label={`Loading ${label}`} />
      <span>{description}</span>
    </section>
  );
}

export function buildRailSections(area: PrimaryArea, items: RailItem[]): RailSection[] {
  // Grouping is data-driven from RAIL_GROUPS (route-model) so the nav rail and
  // breadcrumb kickers (routeKicker) can never disagree. See RAIL_GROUPS for the
  // rationale on any intentionally ungrouped leaves.
  const groups = RAIL_GROUPS[area];
  if (!groups) {
    return [{ id: `${area}-primary`, items }];
  }
  return groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: items.filter((item) => item.section != null && group.sections.includes(item.section)),
    }))
    .filter((group) => group.items.length > 0);
}

function StatusPill({
  icon,
  label,
  value,
  onClick,
  releaseStatus,
  degraded = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
  releaseStatus?: string;
  /** F-H4: marks dashboard-derived pills as stale/unavailable on refresh failure. */
  degraded?: boolean;
}) {
  const content = (
    <>
      <span className="mc-next-status-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </>
  );
  const markerProps = {
    ...(releaseStatus ? { "data-release-status": releaseStatus } : {}),
    ...(degraded ? { "data-status": "degraded" } : {}),
  };
  const accessibleLabel = `${label}: ${value}${degraded ? " (unavailable)" : ""}`;
  if (onClick) {
    return (
      <button
        type="button"
        className="mc-next-status-pill mc-next-status-pill-action"
        onClick={onClick}
        title={degraded ? `${label} (unavailable)` : label}
        aria-label={accessibleLabel}
        {...markerProps}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="mc-next-status-pill" aria-label={accessibleLabel} {...markerProps}>
      {content}
    </div>
  );
}

export function resolveShellThemeClass(theme: "dark" | "light"): "theme-signal-noir" | "theme-citadel-light" {
  return theme === "light" ? "theme-citadel-light" : "theme-signal-noir";
}

export function resolveEffectiveShellTheme(
  routeTheme: string | undefined,
  preferredTheme: "dark" | "light",
): "dark" | "light" {
  return routeTheme === "dark" || routeTheme === "light" ? routeTheme : preferredTheme;
}

export function describeRealtimeTruthUi(
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
    // N1 (QA finding): "compatibility" is per-event topic-inference provenance
    // (keyword match vs explicit `links` ids), not a transport downgrade.
    // While the stream is open it is NOT a degradation — badge/strip/rail read
    // healthy exactly like "authoritative". The nuance stays visible only in
    // the inspector detail line, softened to avoid implying a fallback.
    return {
      badge: "Live",
      inspector: "Streaming (inferred refresh)",
      rail: "Gateway live with streaming",
      stage: "Realtime connected",
      strip: "Streaming",
      degraded: false,
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

export function isImmersiveRoute(route: AppRoute): boolean {
  return route.area === "library" && route.section === "prompt-packs";
}

export function usesEmbeddedRouteHeader(route: AppRoute): boolean {
  return (
    route.area === "library" ||
    route.area === "projects" ||
    route.area === "ops" ||
    route.area === "settings" ||
    (route.area === "cowork" && (route.section === "tasks" || route.section === "board"))
  );
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

/**
 * F-H4: the always-visible status strip shows dashboard-derived truth (pending
 * approvals, sessions, spend). On a refresh failure `use-shell-status` keeps the
 * prior `dashboard` object, so without this the footer would keep presenting the
 * last-good numbers as if current. Mirror the honest `healthError`→"Unavailable"
 * daemon path: when `dashboardError` is set we mark the pill stale and show
 * "Unavailable" rather than a confidently stale value. The `shellStatusError`
 * chip is gated to the stage header (hidden on ops/library/settings/projects),
 * so this strip is the only always-visible signal.
 */
export function describeDashboardFooterPill(
  dashboard: ShellStatusState["dashboard"],
  dashboardError: string | null,
  formatted: string,
): { value: string; degraded: boolean } {
  if (dashboardError) {
    return { value: "Unavailable", degraded: true };
  }
  if (!dashboard) {
    return { value: "—", degraded: false };
  }
  return { value: formatted, degraded: false };
}
