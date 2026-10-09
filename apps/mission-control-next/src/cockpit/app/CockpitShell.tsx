import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { ClassicOwnerLink } from "../ui/ClassicOwnerLink";
import { Activity, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { ChatArea } from "../areas/chat/ChatArea";
import { AreaErrorBoundary } from "../ui/AreaErrorBoundary";
import { AreaPlaceholder } from "./AreaPlaceholder";
import { CommandPalette } from "./CommandPalette";
import { GatewayUnavailableBanner } from "./GatewayUnavailableBanner";
import { CockpitNavigationContext, useCockpitNavigation } from "./cockpit-navigation-context";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider } from "./inspector";
import { MobileTabBar } from "./MobileTabBar";
import { COCKPIT_AREAS } from "./routes";
import { Sidebar } from "./Sidebar";
import { IncomingScopeReview } from "./IncomingScopeReview";
import { useCockpitRoute } from "./use-cockpit-route";
import type { GatewayReachability } from "./use-gateway-reachability";
import { SettingsArea, InboxArea, WorkArea, LibraryArea, SystemArea, Gallery, ChatProjects } from "./area-loaders";
import { applyCockpitAppearance } from "./cockpit-appearance";
import { useAreaShortcuts } from "./use-area-shortcuts";
import { ShortcutHelp } from "./ShortcutHelp";
import { cockpitDocumentTitle } from "./cockpit-document-title";
import { useCockpitScroll } from "./use-cockpit-scroll";
import { getGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";

interface CockpitShellProps {
  streamState?: EventStreamConnectionState;
  gatewayReachability?: GatewayReachability;
  onVisibleSessionChange?: (sessionId: string | undefined) => void;
}

export function CockpitShell(props: CockpitShellProps) {
  const navigation = useContext(CockpitNavigationContext);
  return navigation ? (
    <CockpitShellContent {...props} />
  ) : (
    <CockpitNavigationProvider>
      <CockpitShellContent {...props} />
    </CockpitNavigationProvider>
  );
}

function CockpitShellContent({
  streamState = "closed",
  gatewayReachability,
  onVisibleSessionChange,
}: CockpitShellProps) {
  const { isTransitionPending } = useCockpitNavigation();
  const { area, rest, pathname, search, navigate, resolution } = useCockpitRoute();
  const areaLabel = resolution.kind === "missing" ? "Page not found" : resolution.kind === "classic" ? "Classic view" :
    COCKPIT_AREAS.find((entry) => entry.area === area)?.label ?? (area === "gallery" ? "Gallery" : "Settings");
  const firstRun = area === "settings" && rest[0] === "first-run";
  const { theme, density, activeCitadelId, activeWorkspaceId } = useUiPreferences();
  // Preserve the visited Chat's DOM/state, but dispose its effects while hidden.
  // Retention never crosses installation, Citadel or workspace boundaries.
  const chatScope = JSON.stringify([getGatewayApiBaseUrl(), activeCitadelId, activeWorkspaceId]);
  const mainScroll = useCockpitScroll(JSON.stringify([chatScope, getGatewayCallerScope(), pathname, search, window.location.hash]));
  const retainedChat = useRef({ scope: chatScope, visited: false });
  if (retainedChat.current.scope !== chatScope) retainedChat.current = { scope: chatScope, visited: false };
  const nativeRoute = resolution.kind === "native";
  const conversationVisible = nativeRoute && area === "chat" && rest[0] !== "projects";
  const projectsVisible = nativeRoute && area === "chat" && rest[0] === "projects";
  if (conversationVisible) retainedChat.current.visited = true;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const tablet = useMediaQuery(RESPONSIVE_QUERIES.tablet);
  // NV-13: phones get the tab bar and its status strip; the hidden sidebar must not keep reading.
  const wide = useMediaQuery(RESPONSIVE_QUERIES.abovePhone);
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  const sidebarCollapsed = collapseOverride ?? tablet;

  const documentTitle = cockpitDocumentTitle(areaLabel, area === "chat" || area === "gallery" ? undefined : rest[0]);
  useEffect(() => {
    const previous = document.title;
    document.title = documentTitle;
    return () => {
      if (document.title === documentTitle) document.title = previous;
    };
  }, [documentTitle]);

  useLayoutEffect(() => {
    applyCockpitAppearance(theme, density);
    document.documentElement.dataset.shell = "cockpit";
    return () => {
      // A same-document handoff can transfer this marker before React unmounts us.
      if (document.documentElement.dataset.shell === "cockpit") delete document.documentElement.dataset.shell;
    };
  }, [theme, density]);

  const openPalette = useCallback(() => { if (!isTransitionPending()) setPaletteOpen(true); }, [isTransitionPending]);
  const openHelp = useCallback(() => { if (!isTransitionPending()) setHelpOpen(true); }, [isTransitionPending]);
  const toggleSidebar = useCallback(() => setCollapseOverride(!sidebarCollapsed), [sidebarCollapsed]);
  useAreaShortcuts({ scope: chatScope + pathname + search, navigate, onPalette: openPalette, onHelp: openHelp, onToggleSidebar: toggleSidebar });

  return (
    <InspectorProvider>
      <div className="flex h-dvh flex-col bg-canvas text-fg">
        <IncomingScopeReview />
        {/* Above the scrolling row, so the outage notice never scrolls away and phones see it. */}
        {gatewayReachability?.unavailable ? (
          <GatewayUnavailableBanner reachability={gatewayReachability} inChat={area === "chat"} />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {!firstRun && wide ? (
            <Sidebar
              onOpenPalette={() => {
                if (!isTransitionPending()) setPaletteOpen(true);
              }}
              streamState={streamState}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setCollapseOverride(!sidebarCollapsed)}
            />
          ) : null}
          <main
            ref={mainScroll}
            id="main-content"
            className={
              conversationVisible
                ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                : "min-w-0 flex-1 overflow-y-auto"
            }
          >
            {retainedChat.current.visited ? (
              <Activity key={chatScope} mode={conversationVisible ? "visible" : "hidden"}>
                {/* A new route query, such as the palette's New chat, retries a failed Chat. */}
                <AreaErrorBoundary label="Chat" resetKey={chatScope + search}>
                  <ChatArea
                    gatewayUnavailable={gatewayReachability?.unavailable}
                    onVisibleSessionChange={onVisibleSessionChange}
                  />
                </AreaErrorBoundary>
              </Activity>
            ) : null}
            {projectsVisible ? <AreaErrorBoundary label="Projects" resetKey={pathname + search}><Suspense fallback={<p role="status" className="p-4">Loading projects…</p>}><ChatProjects /></Suspense></AreaErrorBoundary> : null}
            {!nativeRoute ? (
              <section className="p-6 space-y-4"><h1 className="text-xl font-semibold">{resolution.kind === "classic" ? "This view is available in Classic" : "Page not found"}</h1>
                {resolution.kind === "classic" ? <ClassicOwnerLink href={resolution.href} scope={chatScope} label={resolution.label} /> : <p>Choose a destination from the navigation to continue.</p>}
              </section>
            ) : area !== "chat" ? (
              // `key` remounts on an area change; the path retries a failed view after Back or a jump inside the area.
              <AreaErrorBoundary
                key={area}
                label={areaLabel}
                resetKey={pathname + search}
                onGoToChat={() => navigate("/chat")}
              >
                <Suspense
                  key={area}
                  fallback={
                    <p role="status" className="p-4 text-sm text-fg-muted">
                      Loading {areaLabel}…
                    </p>
                  }
                >
                  {area === "gallery" ? (
                    <Gallery />
                  ) : area === "inbox" ? (
                    <InboxArea />
                  ) : area === "library" ? (
                    <LibraryArea />
                  ) : area === "system" ? (
                    <SystemArea />
                  ) : area === "work" ? (
                    <WorkArea />
                  ) : area === "settings" ? (
                    <SettingsArea />
                  ) : (
                    <AreaPlaceholder area={area} />
                  )}
                </Suspense>
              </AreaErrorBoundary>
            ) : null}
          </main>
          <InspectorPanel />
        </div>
        {!firstRun ? (
          <MobileTabBar
            onOpenPalette={() => {
              if (!isTransitionPending()) setPaletteOpen(true);
            }}
            streamState={streamState}
          />
        ) : null}
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </InspectorProvider>
  );
}
