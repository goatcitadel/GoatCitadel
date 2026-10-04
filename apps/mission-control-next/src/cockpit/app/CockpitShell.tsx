import { Activity, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { ChatArea } from "../areas/chat/ChatArea";
import { AreaPlaceholder } from "./AreaPlaceholder";
import { CommandPalette } from "./CommandPalette";
import { GatewayUnavailableBanner } from "./GatewayUnavailableBanner";
import { CockpitNavigationContext, useCockpitNavigation } from "./cockpit-navigation-context";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider } from "./inspector";
import { MobileTabBar } from "./MobileTabBar";
import { COCKPIT_AREAS } from "./routes";
import { Sidebar } from "./Sidebar";
import { useCockpitRoute } from "./use-cockpit-route";
import type { GatewayReachability } from "./use-gateway-reachability";
import { SettingsArea, InboxArea, WorkArea, LibraryArea, SystemArea, Gallery } from "./area-loaders";
import { applyCockpitAppearance } from "./cockpit-appearance";
import { cockpitDocumentTitle } from "./cockpit-document-title";

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
  const { area, rest, navigate } = useCockpitRoute();
  const areaLabel =
    COCKPIT_AREAS.find((entry) => entry.area === area)?.label ?? (area === "gallery" ? "Gallery" : "Settings");
  const firstRun = area === "settings" && rest[0] === "first-run";
  const { theme, density, activeCitadelId, activeWorkspaceId } = useUiPreferences();
  // Preserve the visited Chat's DOM/state, but dispose its effects while hidden.
  // Retention never crosses installation, Citadel or workspace boundaries.
  const chatScope = JSON.stringify([getGatewayApiBaseUrl(), activeCitadelId, activeWorkspaceId]);
  const retainedChat = useRef({ scope: chatScope, visited: false });
  if (retainedChat.current.scope !== chatScope) retainedChat.current = { scope: chatScope, visited: false };
  if (area === "chat") retainedChat.current.visited = true;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const tablet = useMediaQuery("(640px <= width < 1024px)");
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!isTransitionPending()) setPaletteOpen(true);
        return;
      }
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))
        return;
      if (
        event.key.toLowerCase() === "b" &&
        !event.shiftKey &&
        !document.querySelector('[role="dialog"][data-state="open"]')
      ) {
        event.preventDefault();
        setCollapseOverride(!sidebarCollapsed);
        return;
      }
      const target = COCKPIT_AREAS.find((entry) => entry.shortcut === event.key);
      if (target) {
        event.preventDefault();
        navigate(target.path);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, sidebarCollapsed, isTransitionPending]);

  return (
    <InspectorProvider>
      <div className="flex h-dvh flex-col bg-canvas text-fg">
        <div className="flex min-h-0 flex-1">
          {!firstRun ? (
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
            id="main-content"
            className={
              area === "chat"
                ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                : "min-w-0 flex-1 overflow-y-auto"
            }
          >
            {gatewayReachability?.unavailable ? (
              <GatewayUnavailableBanner reachability={gatewayReachability} inChat={area === "chat"} />
            ) : null}
            {retainedChat.current.visited ? (
              <Activity key={chatScope} mode={area === "chat" ? "visible" : "hidden"}>
                <ChatArea
                  gatewayUnavailable={gatewayReachability?.unavailable}
                  onVisibleSessionChange={onVisibleSessionChange}
                />
              </Activity>
            ) : null}
            {area !== "chat" ? (
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
            ) : null}
          </main>
          <InspectorPanel />
        </div>
        {!firstRun ? (
          <MobileTabBar
            onOpenPalette={() => {
              if (!isTransitionPending()) setPaletteOpen(true);
            }}
          />
        ) : null}
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </InspectorProvider>
  );
}
