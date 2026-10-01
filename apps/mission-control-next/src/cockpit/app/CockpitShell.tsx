import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useState } from "react";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { LibraryArea } from "../areas/library/LibraryArea";
import { ChatArea } from "../areas/chat/ChatArea";
import { InboxArea } from "../areas/inbox/InboxArea";
import { SystemArea } from "../areas/system/SystemArea";
import { WorkArea } from "../areas/work/WorkArea";
import { AreaPlaceholder } from "./AreaPlaceholder";
import { CommandPalette } from "./CommandPalette";
import { CockpitNavigationContext, useCockpitNavigation } from "./cockpit-navigation-context";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { Gallery } from "./Gallery";
import { InspectorPanel, InspectorProvider } from "./inspector";
import { MobileTabBar } from "./MobileTabBar";
import { COCKPIT_AREAS } from "./routes";
import { Sidebar } from "./Sidebar";
import { useCockpitRoute } from "./use-cockpit-route";
import type { GatewayReachability } from "./use-gateway-reachability";

const SettingsArea = lazy(async () => ({ default: (await import("../areas/settings/SettingsArea")).SettingsArea }));

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
  const firstRun = area === "settings" && rest[0] === "first-run";
  const { theme, density } = useUiPreferences();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const tablet = useMediaQuery("(640px <= width < 1024px)");
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  const sidebarCollapsed = collapseOverride ?? tablet;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density === "compact" ? "compact" : "comfortable";
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
              <div
                role="alert"
                className="border-b border-status-failed bg-sunken px-4 py-3 text-sm font-medium text-status-failed"
              >
                Gateway unavailable. Sending is paused; your draft is preserved.{" "}
                {gatewayReachability.lastConfirmedAt
                  ? `Last connection confirmed at ${new Date(gatewayReachability.lastConfirmedAt).toLocaleTimeString()}.`
                  : "Reconnecting…"}
              </div>
            ) : null}
            {area === "gallery" ? (
              <Gallery />
            ) : area === "chat" ? (
              <ChatArea
                gatewayUnavailable={gatewayReachability?.unavailable}
                onVisibleSessionChange={onVisibleSessionChange}
              />
            ) : area === "inbox" ? (
              <InboxArea />
            ) : area === "library" ? (
              <LibraryArea />
            ) : area === "system" ? (
              <SystemArea />
            ) : area === "work" ? (
              <WorkArea />
            ) : area === "settings" ? (
              <Suspense
                fallback={
                  <p role="status" className="p-4 text-sm text-fg-muted">
                    Loading Settings…
                  </p>
                }
              >
                <SettingsArea />
              </Suspense>
            ) : (
              <AreaPlaceholder area={area} />
            )}
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
