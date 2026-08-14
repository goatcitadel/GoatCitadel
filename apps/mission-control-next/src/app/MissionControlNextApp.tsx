/* eslint-disable max-lines -- The canonical shell keeps route selection, global overlays, and shared workspace state in one owner while route pages remain lazily split. */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { fetchWorkspaces, getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/shell-client";
import { fetchRuntimeLifecycleExport, listCitadels } from "@goatcitadel/mission-control-shared/api/client";
import {
  buildThreadedGatewayStatusSummary,
  type ThreadedGatewayStatusSummary,
} from "@goatcitadel/threaded-surface-core/work-trust";
import { GatewayAccessGate } from "@goatcitadel/mission-control-shared/components/GatewayAccessGate";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NotificationStack } from "@goatcitadel/mission-control-shared/components/NotificationStack";
import { CommandPalette, type CommandPaletteItem } from "@goatcitadel/mission-control-shared/components/CommandPalette";
import {
  ShellDetailPanelProvider,
  type ShellDetailPanelEntry,
} from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { resolveEffectiveEffectsMode } from "@goatcitadel/mission-control-shared/state/effects-mode";
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
import {
  PRIMARY_NAV,
  ShellInspectorLayer,
  ShellRail,
  ShellRouteStage,
  ShellStatusStrip,
  ShellTopbar,
  type RailSection,
  type WorkspaceSelectionStatus,
} from "./MissionControlShellChrome";
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
  describeReleaseSurfaceStatus,
  getRouteDescription,
  getRouteLabel,
  getRouteReleaseScope,
  isExperimentalRoute,
  isHiddenRoute,
  isPrimaryRailRoute,
  normalizeAppRoute,
  type AppRoute,
  RAIL_GROUPS,
  type PrimaryArea,
  type RailItem,
} from "./route-model";
import { coerceCompatibilityHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";
import { SHELL_ROUTE_SHORTCUT_LETTERS, useShellKeyboardManager } from "./use-shell-keyboard-manager";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { useGatewayAccess } from "./use-gateway-access";
import { useShellStatus } from "./use-shell-status";
import { requestChatComposerPaletteOpen } from "./composer-palette-events";
import { useShellNotifications } from "./use-shell-notifications";
import { useEventStream } from "./use-event-stream";
import { useShellInspector } from "./use-shell-inspector";
import { useNotificationPresenceLease } from "../hooks/useNotificationPresenceLease";
import { EmptyState, ErrorState, NativeButton } from "@next/features/native-routes/primitives";
import {
  countDashboardSessions,
  describeDashboardFooterPill,
  describeRealtimeTruthUi,
  formatUsd,
  isImmersiveRoute,
  resolveEffectiveShellTheme,
  resolveShellThemeClass,
} from "./mission-control-shell-model";

export {
  countDashboardSessions,
  describeDashboardFooterPill,
  describeRealtimeTruthUi,
  formatUsd,
  isImmersiveRoute,
  resolveEffectiveShellTheme,
  resolveShellThemeClass,
  usesEmbeddedRouteHeader,
} from "./mission-control-shell-model";

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
  { area: "library", section: "journey", label: "Library → Journey" },
  { area: "library", section: "curator", label: "Library → Skill Curator" },
  { area: "ops", section: "improvement", label: "Ops → Improvement" },
  { area: "ops", section: "kanban", label: "Ops → Kanban" },
];

function preloadRouteChunk(targetRoute: AppRoute): void {
  const normalized = normalizeAppRoute(targetRoute);
  if (normalized.area === "chat") {
    void preloadThreadedSurfaceRoute();
    return;
  }
  if (normalized.area === "library" && normalized.section === "prompt-packs") {
    void preloadPromptPacksWorkbenchPage();
    return;
  }
  void preloadNativeRoutePages();
}

function WorkspaceScopeGate({
  status,
  citadelName,
  error,
  onCreateWorkspace,
  onRetry,
}: {
  status: Exclude<WorkspaceSelectionStatus, "ready">;
  citadelName: string;
  error: string | null;
  onCreateWorkspace: () => void;
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <ErrorState
        size="default"
        title="Workspaces could not load"
        description={`GoatCitadel could not validate the active workspace inside ${citadelName}. Scoped requests are paused so an invalid Citadel/workspace pair cannot reach the Gateway.`}
        technicalDetails={error}
        primaryAction={<NativeButton onClick={onRetry}>Retry</NativeButton>}
      />
    );
  }
  if (status === "empty") {
    return (
      <EmptyState
        tone="accent"
        title={`${citadelName} needs a workspace`}
        description="Create a workspace before opening Chat, Projects, Library, or Ops in this Citadel. Scoped requests remain paused until the workspace exists."
        primaryAction={<NativeButton onClick={onCreateWorkspace}>Create workspace</NativeButton>}
      />
    );
  }
  return (
    <EmptyState
      title={`Loading ${citadelName} workspaces`}
      description="Validating the Citadel/workspace boundary before loading scoped runtime data."
    />
  );
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
    setActiveScope,
    theme,
    setTheme,
    notifications: notificationPreferences,
    setNotificationSoundMode,
  } = useUiPreferences();
  const effectiveEffectsMode = useMemo(() => resolveEffectiveEffectsMode(effectsMode), [effectsMode]);
  const [route, setRoute] = useState<AppRoute>(() => resolveRouteFromLocation(window.location.href));
  useNotificationPresenceLease(activeWorkspaceId, route.area === "chat" ? route.sessionId : undefined);
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
  const [workspaceSelectionStatus, setWorkspaceSelectionStatus] = useState<WorkspaceSelectionStatus>("resolving");
  const [workspaceSelectionError, setWorkspaceSelectionError] = useState<string | null>(null);
  const workspaceLoadSequence = useRef(0);

  // W4.4: cohesive state moved into dedicated hooks. The shell still composes
  // them (e.g. status reset depends on gateway readiness, event stream feeds
  // notifications) but no longer owns the underlying useState/useRef plumbing.
  const { gatewayAccess, gatewayBusy, autoRetryPending, retryGatewayAccess } = useGatewayAccess();
  const gatewayReady = gatewayAccess.status === "ready";
  const { inspectorOpen, setInspectorOpen, detailEntry, setDetailEntry } = useShellInspector();
  const shellInspectorAvailable = route.area !== "chat";
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
        group: "Navigate",
        description: meta.kicker,
        keyHint: letter ? `G ${letter.toUpperCase()}` : undefined,
        active: route.area === area,
        keywords: [area, meta.kicker, meta.label, ...(letter ? [`g ${letter}`, `g${letter}`] : [])],
        run: () => navigate(buildPrimaryAreaRoute(area)),
      };
    });
    const surfaceItems = (["library", "ops"] as const).flatMap((area) =>
      RAIL_ITEMS[area]
        .filter((railItem) => !isHiddenRoute(railItem) && !isExperimentalRoute(railItem))
        .map((railItem) => ({
          id: `${area}-${railItem.section}`,
          label: railItem.label,
          group: AREA_META[area].label,
          description: railItem.description,
          active: route.area === area && route.section === railItem.section,
          keywords: [area, railItem.section, railItem.label.toLowerCase(), railItem.description.toLowerCase()].filter(
            (keyword): keyword is string => Boolean(keyword),
          ),
          run: () => navigate({ area, section: railItem.section, theme: route.theme }),
        })),
    );
    const settingsItems = RAIL_ITEMS.settings
      .filter((railItem) => !isHiddenRoute(railItem))
      .map((railItem) => {
        const section = railItem.section;
        const descriptionWords = railItem.description.toLowerCase().split(/\s+/).slice(0, 6).join(" ");
        return {
          id: `settings-${section}`,
          label: `Settings → ${railItem.label}`,
          group: "Settings",
          description: railItem.description,
          active: route.area === "settings" && route.section === section,
          keywords: ["settings", ...(section ? [section] : []), railItem.label.toLowerCase(), descriptionWords],
          run: () => navigate({ area: "settings", section, theme: route.theme }),
        };
      });
    // F-M11: the experimental library/ops surfaces are filtered out of the rails
    // (NAV-02) and were unreachable from the palette. Settings experimental
    // sections already appear via `settingsItems`, but Journey/curator/improvement/kanban
    // have no rail-derived palette entry. Add them explicitly, labelled "Experimental"
    // so they stay discoverable and honestly scoped.
    const experimentalItems = EXPERIMENTAL_COMMAND_ROUTES.map((entry) => ({
      id: `experimental-${entry.area}-${entry.section}`,
      label: `${entry.label} (Experimental)`,
      group: "Experimental",
      description: "Direct route to an explicitly experimental surface.",
      active: route.area === entry.area && route.section === entry.section,
      keywords: [entry.area, entry.section, entry.label.toLowerCase(), "experimental"],
      run: () => navigate({ area: entry.area, section: entry.section, theme: route.theme }),
    }));
    return [...areaItems, ...surfaceItems, ...settingsItems, ...experimentalItems];
  }, [buildPrimaryAreaRoute, navigate, route.area, route.section, route.theme]);

  // H-7: dismiss the topmost UI layer when Escape fires (palette handled
  // separately because it's already a controlled dialog). Order matters:
  // inspector > nav drawer.
  const dismissTopmost = useCallback((): boolean => {
    if (shortcutsOpen) {
      setShortcutsOpen(false);
      return true;
    }
    if (shellInspectorAvailable && inspectorOpen) {
      setInspectorOpen(false);
      return true;
    }
    if (navOpen) {
      setNavOpen(false);
      return true;
    }
    return false;
  }, [inspectorOpen, navOpen, setInspectorOpen, shellInspectorAvailable, shortcutsOpen]);

  const routeShortcuts = useMemo(
    () =>
      PRIMARY_NAV.map(({ area }) => ({
        label: AREA_META[area].label,
        letter: SHELL_ROUTE_SHORTCUT_LETTERS.get(area) ?? "",
      })).filter((shortcut) => shortcut.letter),
    [],
  );

  const openContextualPalette = useCallback(() => {
    if (route.area === "chat" && requestChatComposerPaletteOpen()) {
      return;
    }
    setPaletteOpen(true);
  }, [route.area]);

  useShellKeyboardManager({
    onOpenPalette: openContextualPalette,
    onClosePalette: () => setPaletteOpen(false),
    isPaletteOpen: paletteOpen,
    onDismissTopmost: dismissTopmost,
    onJumpToArea: (area) => navigate(buildPrimaryAreaRoute(area)),
    onToggleShortcuts: () => setShortcutsOpen((open) => !open),
    shellShortcutsSuspended: shortcutsOpen,
  });

  const shellThemeClass = resolveShellThemeClass(resolveEffectiveShellTheme(route.theme, theme));
  const effectiveChromeTheme = resolveEffectiveShellTheme(route.theme, theme);
  const currentAreaMeta = AREA_META[route.area];
  const currentRailItems = route.area === "chat" ? buildModeRail(route.mode) : RAIL_ITEMS[route.area];
  const groupedRailItems = useMemo(
    () =>
      buildRailSections(
        route.area,
        // NAV-02: release-aware rail visibility keeps most experimental surfaces
        // in the palette while exposing the personality catalog users need in
        // order to inspect available presets.
        currentRailItems.filter((item) => isPrimaryRailRoute(item)),
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
  const isWorkArea = route.area === "chat";
  const immersiveRoute = isImmersiveRoute(route);
  const usesFullStageLayout = isWorkArea || immersiveRoute;
  // Chat owns its own Working Context surface. Suppress the generic route
  // inspector there so two different "Context" controls cannot compete for the
  // same right-side workspace; retain the inspector on every non-Chat route.
  const hasVisibleInspector = shellInspectorAvailable && (detailPanelPinned || inspectorOpen);
  const activeWorkspaceName =
    workspaceSelectionStatus === "ready"
      ? (workspaceOptions.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? activeWorkspaceId)
      : workspaceSelectionStatus === "empty"
        ? "No workspace"
        : workspaceSelectionStatus === "error"
          ? "Workspaces unavailable"
          : "Loading workspaces";
  const activeCitadelName = citadelOptions.find((item) => item.citadelId === activeCitadelId)?.name ?? activeCitadelId;

  const copyTrustReport = useCallback(
    async (sessionId?: string | null, turnId?: string | null) => {
      if (!sessionId) {
        pushNotification("warning", "Open a Work session before exporting a trust report.", "trust-report");
        return;
      }
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        pushNotification("warning", "Clipboard is unavailable in this browser.", "trust-report");
        return;
      }
      try {
        const bundle = await fetchRuntimeLifecycleExport({
          sessionId,
          turnId: turnId ?? undefined,
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
            void copyTrustReport(route.sessionId, route.turnId);
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
    copyTrustReport,
    realtimeStatusCopy.inspector,
    route,
    status.dashboard,
  ]);
  const inspectorEntry = detailEntry ?? passiveInspectorEntry;
  const pendingApprovals = status.dashboard?.pendingApprovals ?? 0;
  const taskBacklogCount = (status.dashboard?.taskStatusCounts ?? [])
    .filter((entry) => entry.status !== "done")
    .reduce((sum, entry) => sum + entry.count, 0);
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
    status.dashboard ? `${countDashboardSessions(status.dashboard)} visible` : "—",
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
          `${countDashboardSessions(status.dashboard)} recent sessions`,
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
          workspaceLoadSequence.current += 1;
          setWorkspaceOptions([]);
          setWorkspaceSelectionError(null);
          setWorkspaceSelectionStatus("resolving");
          setActiveCitadelId(fallbackCitadelId);
        }
      }
    } catch {
      setCitadelOptions([]);
    }
  }, [activeCitadelId, setActiveCitadelId]);

  const loadWorkspaceOptions = useCallback(async () => {
    const sequence = ++workspaceLoadSequence.current;
    setWorkspaceSelectionError(null);
    setWorkspaceSelectionStatus("resolving");
    try {
      const response = await fetchWorkspaces("all", 400, activeCitadelId);
      if (sequence !== workspaceLoadSequence.current) {
        return;
      }
      const options = response.items.map((item) => ({
        workspaceId: item.workspaceId,
        name: item.name,
      }));
      setWorkspaceOptions(options);
      if (response.items.some((item) => item.workspaceId === activeWorkspaceId)) {
        setWorkspaceSelectionStatus("ready");
        return;
      }
      const fallbackWorkspaceId = response.items[0]?.workspaceId;
      if (fallbackWorkspaceId) {
        setActiveScope({ citadelId: activeCitadelId, workspaceId: fallbackWorkspaceId });
        return;
      }
      setWorkspaceSelectionStatus("empty");
    } catch (error) {
      if (sequence !== workspaceLoadSequence.current) {
        return;
      }
      setWorkspaceOptions([]);
      setWorkspaceSelectionError(error instanceof Error ? error.message : "Workspace directory could not load.");
      setWorkspaceSelectionStatus("error");
    }
  }, [activeCitadelId, activeWorkspaceId, setActiveScope]);

  const clearInvalidProjectSelection = useCallback(() => {
    if (route.area !== "projects" || (!route.projectId && !route.artifactId)) {
      return;
    }
    navigate({ area: "projects", theme: route.theme }, { replace: true });
  }, [navigate, route.area, route.artifactId, route.projectId, route.theme]);

  const handleSelectCitadel = useCallback(
    (citadelId: string) => {
      workspaceLoadSequence.current += 1;
      setWorkspaceOptions([]);
      setWorkspaceSelectionError(null);
      setWorkspaceSelectionStatus("resolving");
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
  /*
   * Toggle from the EFFECTIVE theme (a `?theme=` route pin wins over the
   * stored preference) and drop the pin when toggling: flipping only the
   * hidden preference while the pin stays rendered made the control appear
   * dead and its icon lie about the visible theme.
   */
  const handleToggleTheme = useCallback(() => {
    setTheme(effectiveChromeTheme === "dark" ? "light" : "dark");
    if (route.theme) {
      const unpinned = normalizeAppRoute({ ...route, theme: undefined });
      window.history.replaceState({}, "", buildAppHref(unpinned));
      startTransition(() => {
        setRoute(unpinned);
      });
    }
  }, [effectiveChromeTheme, route, setTheme]);
  const soundEnabled = notificationPreferences.soundMode !== "off";

  useEffect(() => {
    const nextHref = coerceCompatibilityHrefToNext(window.location.href);
    if (nextHref && nextHref !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState({}, "", nextHref);
      setRoute(resolveRouteFromLocation(window.location.href));
      return;
    }
    setRoute(resolveRouteFromLocation(window.location.href));
  }, []);

  useEffect(() => {
    preloadRouteChunk(route);
  }, [route]);

  // A bare installation has no completed setup marker. Keep its first
  // destination native and guided instead of opening a model-less Chat that
  // cannot produce a useful first turn. Settings remains reachable later, but
  // this initial redirect is intentionally one-way and history-neutral.
  useEffect(() => {
    if (
      gatewayAccess.status !== "ready" ||
      gatewayAccess.onboardingState?.completed !== false ||
      route.area !== "chat"
    ) {
      return;
    }
    navigate({ area: "settings", section: "onboarding", theme: route.theme }, { replace: true });
  }, [gatewayAccess, navigate, route.area, route.theme]);

  useEffect(() => {
    if (route.area !== "chat") {
      return;
    }
    // Chat owns Working Context. Clear both shell-inspector state channels on
    // entry so Escape cannot consume an invisible layer and stale route detail
    // cannot reappear when the operator later leaves Chat.
    setInspectorOpen(false);
    setDetailEntry(null);
  }, [route.area, setDetailEntry, setInspectorOpen]);

  useEffect(() => {
    const handlePopState = () => {
      const nextHref = coerceCompatibilityHrefToNext(window.location.href);
      if (nextHref && nextHref !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState({}, "", nextHref);
      }
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
      workspaceLoadSequence.current += 1;
      setCitadelOptions([]);
      setWorkspaceOptions([]);
      setWorkspaceSelectionError(null);
      setWorkspaceSelectionStatus("resolving");
      return;
    }
    void Promise.all([loadCitadelOptions(), refreshStatus()]);
  }, [gatewayReady, loadCitadelOptions, refreshStatus]);

  useEffect(() => {
    if (!gatewayReady) {
      return;
    }
    void loadWorkspaceOptions();
  }, [gatewayReady, loadWorkspaceOptions]);

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
  const workspaceManagementRoute = route.area === "settings" && route.section === "workspaces";
  const routeContent =
    workspaceSelectionStatus === "ready" || (workspaceSelectionStatus === "empty" && workspaceManagementRoute) ? (
      renderRouteContent({
        route,
        activeCitadelId,
        activeCitadelName,
        activeWorkspaceId: workspaceSelectionStatus === "ready" ? activeWorkspaceId : "",
        activeWorkspaceName,
        gatewayStatus: threadedGatewayStatus,
        pendingApprovals,
        navigate,
        onCopyTrustReport: copyTrustReport,
        setActiveCitadelId,
        setActiveWorkspaceId,
      })
    ) : (
      <WorkspaceScopeGate
        status={workspaceSelectionStatus}
        citadelName={activeCitadelName}
        error={workspaceSelectionError}
        onCreateWorkspace={() => navigate({ area: "settings", section: "workspaces", theme: route.theme })}
        onRetry={() => void loadWorkspaceOptions()}
      />
    );

  return (
    <ShellDetailPanelProvider
      isOpen={hasVisibleInspector}
      onOpenPanel={() => {
        if (shellInspectorAvailable) {
          setInspectorOpen(true);
        }
      }}
      onClosePanel={() => setInspectorOpen(false)}
      onActiveEntryChange={(entry) => {
        if (shellInspectorAvailable) {
          setDetailEntry(entry);
        }
      }}
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
          <ShellTopbar
            activeCitadelId={activeCitadelId}
            activeCitadelName={activeCitadelName}
            activeWorkspaceId={activeWorkspaceId}
            activeWorkspaceName={activeWorkspaceName}
            buildPrimaryAreaRoute={buildPrimaryAreaRoute}
            citadelOptions={citadelOptions}
            handleOpenStartHere={handleOpenStartHere}
            handleSelectCitadel={handleSelectCitadel}
            handleSelectWorkspace={handleSelectWorkspace}
            handleToggleMode={handleToggleMode}
            handleToggleNotificationSound={handleToggleNotificationSound}
            handleToggleTheme={handleToggleTheme}
            inspectorOpen={inspectorOpen}
            inspectorAvailable={shellInspectorAvailable}
            isCompactTopbar={isCompactTopbar}
            mode={mode}
            navigate={navigate}
            onOpenPalette={openContextualPalette}
            onOpenNav={() => setNavOpen(true)}
            onToggleInspector={() => setInspectorOpen((current) => !current)}
            operatorNotificationCount={operatorNotificationCount}
            pendingApprovals={pendingApprovals}
            preloadRouteChunk={preloadRouteChunk}
            realtimeBadge={realtimeStatusCopy.badge}
            realtimeDegraded={realtimeStatusCopy.degraded}
            route={route}
            soundEnabled={soundEnabled}
            theme={effectiveChromeTheme}
            workspaceOptions={workspaceOptions}
            workspaceSelectionStatus={workspaceSelectionStatus}
          />

          <div className={`mc-next-body${usesFullStageLayout ? " is-work-area" : ""}`}>
            <ShellRail
              activeCitadelId={activeCitadelId}
              activeCitadelName={activeCitadelName}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceName={activeWorkspaceName}
              buildPrimaryAreaRoute={buildPrimaryAreaRoute}
              citadelOptions={citadelOptions}
              currentAreaMeta={currentAreaMeta}
              groupedRailItems={groupedRailItems}
              handleSelectCitadel={handleSelectCitadel}
              handleSelectWorkspace={handleSelectWorkspace}
              isMobileNav={isMobileNav}
              navOpen={navOpen}
              navigate={navigate}
              onClose={() => setNavOpen(false)}
              onOpenPalette={openContextualPalette}
              pendingApprovals={pendingApprovals}
              preloadRouteChunk={preloadRouteChunk}
              railSignalLines={railSignalLines}
              railSignalTitle={railSignalTitle}
              route={route}
              taskBacklogCount={taskBacklogCount}
              workspaceOptions={workspaceOptions}
              workspaceSelectionStatus={workspaceSelectionStatus}
            />

            <ShellRouteStage
              currentRouteDescription={currentRouteDescription}
              currentRouteLabel={currentRouteLabel}
              fallback={<RouteSurfaceFallback label={currentRouteLabel} description={currentRouteDescription} />}
              onReturnToChat={() => navigate({ area: "chat", theme: route.theme })}
              pageErrorResetKey={pageErrorResetKey}
              usesFullStageLayout={usesFullStageLayout}
            >
              {routeContent}
            </ShellRouteStage>
          </div>

          <ShellInspectorLayer
            detailPanelPinned={detailPanelPinned}
            hasVisibleInspector={hasVisibleInspector}
            inspectorEntry={inspectorEntry}
            onClose={() => setInspectorOpen(false)}
            onTogglePinned={() => setDetailPanelPinned(!detailPanelPinned)}
          />

          <ShellStatusStrip
            approvalsPill={approvalsPill}
            buildIdentity={status.runtimeIdentity}
            buildIdentityError={status.runtimeIdentityError}
            currentReleaseScope={currentReleaseScope}
            currentReleaseStatusLabel={currentReleaseStatusLabel}
            daemonStatusValue={daemonStatusValue}
            gatewayMessage={gatewayAccess.message}
            navigateApprovals={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
            navigateBuildProof={() => navigate({ area: "ops", section: "diagnostics", theme: route.theme })}
            realtimeValue={realtimeStatusCopy.strip}
            sessionsPill={sessionsPill}
            spendPill={spendPill}
          />
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
  onCopyTrustReport?: (sessionId?: string | null, turnId?: string | null) => void;
  setActiveCitadelId?: (citadelId: string) => void;
  setActiveWorkspaceId: (workspaceId: string) => void;
}): ReactNode {
  const route = normalizeAppRoute(input.route);
  const openPersonalitiesSettings = () =>
    input.navigate({ area: "settings", section: "personalities", theme: route.theme });
  const openLibraryArtifacts = () => input.navigate({ area: "library", section: "artifacts", theme: route.theme });
  const openLibraryImports = () => input.navigate({ area: "library", section: "knowledge", theme: route.theme });
  const openOpsRuntime = () => input.navigate({ area: "ops", section: "runtime", theme: route.theme });
  if (route.area === "chat") {
    return (
      <LazyThreadedSurfaceRoute
        workspaceId={input.activeWorkspaceId}
        workspaceName={input.activeWorkspaceName}
        gatewayStatus={input.gatewayStatus}
        approvalsCount={input.pendingApprovals}
        surface="chat"
        lockSurface={false}
        hidePageHeader
        initialModeOverride="chat"
        onOpenTasks={() => input.navigate({ area: "ops", section: "kanban", theme: route.theme })}
        onOpenApprovals={(approvalId?: string) =>
          input.navigate({ area: "ops", section: "approvals", theme: route.theme, approvalId })
        }
        onCopyTrustReport={input.onCopyTrustReport}
        onOpenStartHere={() => input.navigate({ area: "settings", section: "onboarding", theme: route.theme })}
        onOpenPersonalitiesSettings={openPersonalitiesSettings}
        onOpenLibraryArtifacts={openLibraryArtifacts}
        onOpenLibraryImports={openLibraryImports}
        onOpenOpsRuntime={openOpsRuntime}
        onOpenUniversalRunDetail={(runId) =>
          input.navigate({ area: "ops", section: "sessions", view: "run-detail", runId, theme: route.theme })
        }
        onNavigateSurface={(_surface, options) =>
          input.navigate({
            area: "chat",
            theme: route.theme,
            sessionId: options?.sessionId ?? undefined,
            turnId: options?.turnId ?? undefined,
            artifactId: options?.artifactId ?? undefined,
          })
        }
      />
    );
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
