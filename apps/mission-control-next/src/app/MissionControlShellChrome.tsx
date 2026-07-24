import { Suspense, useRef, type ReactNode } from "react";
import {
  Activity,
  Bell,
  Bot,
  BookOpenText,
  FolderKanban,
  Fingerprint,
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
  type LucideIcon,
} from "lucide-react";
import type { RuntimeBuildIdentity } from "@goatcitadel/contracts";
import { PageErrorBoundary } from "@goatcitadel/mission-control-shared/components/PageErrorBoundary";
import { SideInspectorDrawer } from "@goatcitadel/mission-control-shared/components/SideInspectorDrawer";
import type { ShellDetailPanelEntry } from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";
import { NativeButton } from "@next/features/native-routes/primitives";
import { useModalDialogBehavior } from "@next/features/threaded-surface/useModalDialogBehavior";
import { TopbarOverflowMenu, type TopbarOverflowItem } from "./TopbarOverflowMenu";
import { isRuntimeReleaseVerified } from "./runtime-build-identity";
import {
  AREA_META,
  buildNavigationTarget,
  describeReleaseScopeForOperator,
  describeReleaseSurfaceStatus,
  getRouteReleaseScope,
  isRailItemActive,
  type AppRoute,
  type AreaMeta,
  type PrimaryArea,
  type RailItem,
  type RouteReleaseScope,
} from "./route-model";

export type RailSection = {
  id: string;
  label?: string;
  items: RailItem[];
};

export type StatusPillModel = {
  value: string;
  degraded?: boolean;
};

export const PRIMARY_NAV: Array<{ area: PrimaryArea; icon: LucideIcon }> = [
  { area: "chat", icon: Bot },
  { area: "projects", icon: FolderKanban },
  { area: "library", icon: LibraryBig },
  { area: "ops", icon: Activity },
  { area: "settings", icon: SlidersHorizontal },
];

export function ShellTopbar({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  activeWorkspaceName,
  buildPrimaryAreaRoute,
  citadelOptions,
  handleOpenStartHere,
  handleSelectCitadel,
  handleSelectWorkspace,
  handleToggleMode,
  handleToggleNotificationSound,
  handleToggleTheme,
  inspectorAvailable,
  inspectorOpen,
  isCompactTopbar,
  mode,
  navigate,
  onOpenPalette,
  onOpenNav,
  onToggleInspector,
  operatorNotificationCount,
  pendingApprovals,
  preloadRouteChunk,
  realtimeBadge,
  realtimeDegraded,
  route,
  soundEnabled,
  theme,
  workspaceOptions,
}: {
  activeCitadelId: string;
  activeCitadelName: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  buildPrimaryAreaRoute: (area: PrimaryArea) => AppRoute;
  citadelOptions: Array<{ citadelId: string; name: string }>;
  handleOpenStartHere: () => void;
  handleSelectCitadel: (citadelId: string) => void;
  handleSelectWorkspace: (workspaceId: string) => void;
  handleToggleMode: () => void;
  handleToggleNotificationSound: () => void;
  handleToggleTheme: () => void;
  inspectorAvailable: boolean;
  inspectorOpen: boolean;
  isCompactTopbar: boolean;
  mode: "simple" | "advanced";
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  onOpenPalette: () => void;
  onOpenNav: () => void;
  onToggleInspector: () => void;
  operatorNotificationCount: number;
  pendingApprovals: number;
  preloadRouteChunk: (route: AppRoute) => void;
  realtimeBadge: string;
  realtimeDegraded: boolean;
  route: AppRoute;
  soundEnabled: boolean;
  theme: "dark" | "light";
  workspaceOptions: Array<{ workspaceId: string; name: string }>;
}) {
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

  return (
    <header className="mc-next-topbar">
      <div className="mc-next-topbar-left">
        <button
          type="button"
          className="mc-next-icon-button mc-next-nav-toggle"
          onClick={onOpenNav}
          aria-label="Open navigation"
          title="Open navigation"
        >
          <Menu size={16} />
          <span>Menu</span>
        </button>
        <div className="mc-next-brand">
          <p>GoatCitadel</p>
          <h1>Mission Control</h1>
        </div>
        <label className="mc-next-select-field mc-next-citadel-field">
          <span>Citadel</span>
          <select
            aria-label="Active Citadel"
            value={activeCitadelId}
            onChange={(event) => handleSelectCitadel(event.target.value)}
          >
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
        <button
          type="button"
          className="mc-next-command-search"
          onClick={onOpenPalette}
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
        <label className="mc-next-select-field mc-next-workspace-field">
          <span>Workspace</span>
          <select
            aria-label="Active Workspace"
            value={activeWorkspaceId}
            onChange={(event) => handleSelectWorkspace(event.target.value)}
          >
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
          {realtimeDegraded ? (
            <span className="mc-next-badge mc-next-realtime-badge" data-realtime="degraded">
              {realtimeBadge}
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
            <span className="mc-next-badge-label">{pendingApprovals === 1 ? "approval" : "approvals"}</span>
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
        {inspectorAvailable ? (
          <NativeButton
            variant="secondary"
            className="mc-next-wa-button"
            onClick={onToggleInspector}
            aria-label={inspectorOpen ? "Hide Route details" : "Open Route details"}
            title={inspectorOpen ? "Hide Route details" : "Open Route details"}
          >
            {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            {inspectorOpen ? "Hide Route details" : "Open Route details"}
          </NativeButton>
        ) : null}
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
  );
}

export function ShellRail({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  activeWorkspaceName,
  buildPrimaryAreaRoute,
  citadelOptions,
  currentAreaMeta,
  groupedRailItems,
  handleSelectCitadel,
  handleSelectWorkspace,
  isMobileNav,
  navOpen,
  navigate,
  onClose,
  onOpenPalette,
  pendingApprovals,
  preloadRouteChunk,
  railSignalLines,
  railSignalTitle,
  route,
  taskBacklogCount,
  workspaceOptions,
}: {
  activeCitadelId: string;
  activeCitadelName: string;
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  buildPrimaryAreaRoute: (area: PrimaryArea) => AppRoute;
  citadelOptions: Array<{ citadelId: string; name: string }>;
  currentAreaMeta: AreaMeta;
  groupedRailItems: RailSection[];
  handleSelectCitadel: (citadelId: string) => void;
  handleSelectWorkspace: (workspaceId: string) => void;
  isMobileNav: boolean;
  navOpen: boolean;
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
  onClose: () => void;
  onOpenPalette: () => void;
  pendingApprovals: number;
  preloadRouteChunk: (route: AppRoute) => void;
  railSignalLines: string[];
  railSignalTitle: string;
  route: AppRoute;
  taskBacklogCount: number;
  workspaceOptions: Array<{ workspaceId: string; name: string }>;
}) {
  const railRef = useRef<HTMLElement | null>(null);
  const modalOpen = isMobileNav && navOpen;
  useModalDialogBehavior({
    open: modalOpen,
    onClose,
    containerRef: railRef,
  });

  return (
    <>
      <button
        type="button"
        className={`mc-next-nav-scrim${modalOpen ? " open" : ""}`}
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        ref={railRef}
        className={`mc-next-rail${navOpen ? " open" : ""}`}
        role={isMobileNav ? "dialog" : undefined}
        aria-modal={isMobileNav ? true : undefined}
        aria-label={isMobileNav ? "Navigation" : undefined}
        aria-hidden={isMobileNav ? !navOpen : undefined}
        inert={isMobileNav && !navOpen}
      >
        <div className="mc-next-rail-head">
          <div>
            <p>{currentAreaMeta.kicker}</p>
            <h2>{currentAreaMeta.label}</h2>
          </div>
          <button type="button" className="mc-next-rail-close" onClick={onClose} aria-label="Close navigation">
            <X size={16} />
          </button>
        </div>
        {isMobileNav ? (
          <>
            <div className="mc-next-rail-mobile-context" aria-label="Active scope and commands">
              <label className="mc-next-rail-mobile-select">
                <span>Citadel</span>
                <select
                  aria-label="Active Citadel"
                  value={activeCitadelId}
                  onChange={(event) => {
                    handleSelectCitadel(event.target.value);
                    onClose();
                  }}
                >
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
              <label className="mc-next-rail-mobile-select">
                <span>Workspace</span>
                <select
                  aria-label="Active Workspace"
                  value={activeWorkspaceId}
                  onChange={(event) => {
                    handleSelectWorkspace(event.target.value);
                    onClose();
                  }}
                >
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
              <button
                type="button"
                className="mc-next-rail-command-button"
                aria-label="Open Command Palette"
                onClick={() => {
                  onOpenPalette();
                  onClose();
                }}
              >
                <Search size={16} />
                <span>Command Palette</span>
                <kbd>Ctrl K</kbd>
              </button>
            </div>
            <div className="mc-next-rail-areas">
              {PRIMARY_NAV.map(({ area, icon: Icon }) => (
                <button
                  key={area}
                  type="button"
                  className={`mc-next-rail-area-link${route.area === area ? " active" : ""}`}
                  aria-current={route.area === area ? "page" : undefined}
                  onClick={() => {
                    navigate(buildPrimaryAreaRoute(area));
                    onClose();
                  }}
                >
                  <Icon size={16} />
                  <span>{AREA_META[area].label}</span>
                </button>
              ))}
            </div>
          </>
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
                        ? taskBacklogCount
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
    </>
  );
}

export function ShellStatusStrip({
  approvalsPill,
  buildIdentity,
  buildIdentityError,
  currentReleaseScope,
  currentReleaseStatusLabel,
  daemonStatusValue,
  gatewayMessage,
  navigateApprovals,
  navigateBuildProof,
  realtimeValue,
  sessionsPill,
  spendPill,
}: {
  approvalsPill: StatusPillModel;
  buildIdentity: RuntimeBuildIdentity | null;
  buildIdentityError: string | null;
  currentReleaseScope: RouteReleaseScope;
  currentReleaseStatusLabel: string;
  daemonStatusValue: string;
  gatewayMessage: string;
  navigateApprovals: () => void;
  navigateBuildProof: () => void;
  realtimeValue: string;
  sessionsPill: StatusPillModel;
  spendPill: StatusPillModel;
}) {
  const identityChip = formatRuntimeIdentityChip(buildIdentity, buildIdentityError);
  return (
    <footer className="mc-next-status-strip" aria-label="Mission Control status strip">
      <div className="mc-next-status-strip-identity" data-shell-identity-anchor="pinned">
        <StatusPill
          icon={<Fingerprint size={15} />}
          label="Build identity"
          value={identityChip.value}
          compactValue={identityChip.compactValue}
          identityStatus={identityChip.status}
          onClick={navigateBuildProof}
        />
      </div>
      <div className="mc-next-status-strip-primary">
        <StatusPill icon={<ShieldCheck size={15} />} label={gatewayMessage} value="Gateway ready" />
        <StatusPill icon={<Activity size={15} />} label="Live updates" value={realtimeValue} />
        <StatusPill
          icon={<Workflow size={15} />}
          label="Approvals"
          value={approvalsPill.value}
          degraded={approvalsPill.degraded}
          onClick={navigateApprovals}
        />
      </div>
      <details className="mc-next-status-details">
        <summary>
          <span>Runtime details</span>
          <strong>{daemonStatusValue}</strong>
        </summary>
        <div className="mc-next-status-details-popover">
          {currentReleaseScope.status === "ship" ? null : (
            <StatusPill
              icon={<ShieldCheck size={15} />}
              label="Release scope"
              value={currentReleaseStatusLabel}
              releaseStatus={currentReleaseScope.status}
            />
          )}
          <StatusPill
            icon={<BookOpenText size={15} />}
            label="Sessions"
            value={sessionsPill.value}
            degraded={sessionsPill.degraded}
          />
          <StatusPill icon={<Wrench size={15} />} label="Spend" value={spendPill.value} degraded={spendPill.degraded} />
          <StatusPill icon={<Bot size={15} />} label="Daemon" value={daemonStatusValue} />
        </div>
      </details>
    </footer>
  );
}

export function ShellRouteStage({
  children,
  currentRouteDescription,
  currentRouteLabel,
  fallback,
  onReturnToChat,
  pageErrorResetKey,
  usesFullStageLayout,
}: {
  children: ReactNode;
  currentRouteDescription: string;
  currentRouteLabel: string;
  fallback: ReactNode;
  onReturnToChat: () => void;
  pageErrorResetKey: string;
  usesFullStageLayout: boolean;
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={`mc-next-stage${usesFullStageLayout ? " mc-next-stage-work" : ""}`}
      aria-label={`${currentRouteLabel}: ${currentRouteDescription}`}
    >
      <PageErrorBoundary resetKey={pageErrorResetKey} pageLabel={currentRouteLabel} onReturnToChat={onReturnToChat}>
        <Suspense fallback={fallback}>
          <div className="mc-next-stage-scroll">
            <section
              className={`space-page mc-next-surface-host${
                usesFullStageLayout ? " space-page-surface mc-next-surface-host-work" : ""
              }`}
            >
              {children}
            </section>
          </div>
        </Suspense>
      </PageErrorBoundary>
    </main>
  );
}

export function ShellInspectorLayer({
  detailPanelPinned,
  hasVisibleInspector,
  inspectorEntry,
  onClose,
  onTogglePinned,
}: {
  detailPanelPinned: boolean;
  hasVisibleInspector: boolean;
  inspectorEntry: ShellDetailPanelEntry | null;
  onClose: () => void;
  onTogglePinned: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`mc-next-inspector-scrim${hasVisibleInspector ? " open" : ""}`}
        aria-hidden={!hasVisibleInspector}
        aria-label="Close context panel"
        onClick={onClose}
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
          onClose={onClose}
          onTogglePinned={onTogglePinned}
          actions={inspectorEntry.actions}
          className="mc-next-shell-inspector"
        >
          {inspectorEntry.body}
        </SideInspectorDrawer>
      ) : null}
    </>
  );
}

function StatusPill({
  icon,
  label,
  value,
  compactValue,
  onClick,
  releaseStatus,
  identityStatus,
  degraded = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  compactValue?: string;
  onClick?: () => void;
  releaseStatus?: string;
  identityStatus?: "verified" | "unverified" | "unavailable";
  degraded?: boolean;
}) {
  const content = (
    <>
      <span className="mc-next-status-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong className={compactValue ? "mc-next-status-value-full" : undefined}>{value}</strong>
        {compactValue ? (
          <strong className="mc-next-status-value-compact" aria-hidden="true">
            {compactValue}
          </strong>
        ) : null}
      </div>
    </>
  );
  const markerProps = {
    ...(releaseStatus ? { "data-release-status": releaseStatus } : {}),
    ...(identityStatus ? { "data-identity-status": identityStatus } : {}),
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

export function formatRuntimeIdentityChip(
  identity: RuntimeBuildIdentity | null,
  error: string | null,
): { value: string; compactValue: string; status: "verified" | "unverified" | "unavailable" } {
  if (!identity || error) {
    return { value: "Identity unavailable", compactValue: "Build ID unavailable", status: "unavailable" };
  }
  const kind = identity.kind === "development" ? "Dev" : identity.kind === "packaged" ? "Packaged" : "Source";
  const version = identity.version === "unknown" ? "version unknown" : `v${identity.version.replace(/^v/i, "")}`;
  const sha = identity.shortSha ?? "SHA unknown";
  const integrity =
    identity.integrity === "modified" ? "modified" : identity.integrity === "unknown" ? "unproven" : null;
  const releaseVerified = isRuntimeReleaseVerified(identity);
  const proof = releaseVerified ? "installed payload verified" : "proof unverified";
  const compactKind = identity.kind === "development" ? "Dev" : identity.kind === "packaged" ? "Pkg" : "Src";
  const compactProof = releaseVerified ? "verified" : "unverified";
  return {
    value: [kind, version, sha, integrity, proof].filter(Boolean).join(" · "),
    compactValue: [compactKind, version, sha, integrity, compactProof].filter(Boolean).join("/"),
    status: releaseVerified ? "verified" : "unverified",
  };
}
